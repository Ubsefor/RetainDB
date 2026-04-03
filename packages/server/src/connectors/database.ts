import postgres from "postgres";
import { ingestDocument } from "../engine/ingest.js";

interface DatabaseConfig {
  connectionString: string;
  dialect?: "postgresql"; // only postgres for now
  includeSchema?: boolean;
  includeSampleData?: boolean;
  tables?: string[]; // specific tables, or all
}

export async function syncDatabase(
  sourceId: string,
  projectId: string,
  config: DatabaseConfig
) {
  const { connectionString, includeSchema = true, includeSampleData = false, tables } = config;
  
  if (!connectionString) {
    throw new Error("Database requires 'connectionString' in config. Format: postgres://user:pass@host:5432/db");
  }

  let indexed = 0;
  let targetTables: any[] = [];

  const sql = postgres(connectionString, { max: 1, connect_timeout: 10 });

  try {
    // Get all tables
    const allTables = await sql`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
    `;

    targetTables = tables?.length
      ? allTables.filter((t) => tables.includes(t.table_name) || tables.includes(`${t.table_schema}.${t.table_name}`))
      : allTables;

    // Index overall schema overview
    const overview = targetTables
      .map((t) => `- ${t.table_schema}.${t.table_name}`)
      .join("\n");

    await ingestDocument({
      sourceId,
      projectId,
      externalId: "db-overview",
      title: "Database Schema Overview",
      content: `# Database Tables\n\n${overview}`,
      metadata: { source: "database", section: "overview" },
    });
    indexed++;

    // Index each table's schema
    if (includeSchema) {
      for (const table of targetTables) {
        const columns = await sql`
          SELECT
            column_name,
            data_type,
            is_nullable,
            column_default,
            character_maximum_length
          FROM information_schema.columns
          WHERE table_schema = ${table.table_schema}
          AND table_name = ${table.table_name}
          ORDER BY ordinal_position
        `;

        // Get constraints
        const constraints = await sql`
          SELECT
            tc.constraint_type,
            tc.constraint_name,
            kcu.column_name,
            ccu.table_name AS foreign_table,
            ccu.column_name AS foreign_column
          FROM information_schema.table_constraints tc
          LEFT JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          LEFT JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
            AND tc.constraint_type = 'FOREIGN KEY'
          WHERE tc.table_schema = ${table.table_schema}
          AND tc.table_name = ${table.table_name}
        `;

        // Get indexes
        const indexes = await sql`
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = ${table.table_schema}
          AND tablename = ${table.table_name}
        `;

        const fullName = `${table.table_schema}.${table.table_name}`;

        const content = [
          `# Table: ${fullName}`,
          "\n## Columns\n",
          ...columns.map((c) => {
            const nullable = c.is_nullable === "YES" ? "nullable" : "not null";
            const def = c.column_default ? `, default: ${c.column_default}` : "";
            const len = c.character_maximum_length ? `(${c.character_maximum_length})` : "";
            return `- \`${c.column_name}\` ${c.data_type}${len} (${nullable}${def})`;
          }),
          constraints.length ? "\n## Constraints\n" : "",
          ...constraints.map((c) => {
            if (c.constraint_type === "FOREIGN KEY") {
              return `- FK \`${c.column_name}\` → ${c.foreign_table}.${c.foreign_column}`;
            }
            return `- ${c.constraint_type}: \`${c.column_name}\``;
          }),
          indexes.length ? "\n## Indexes\n" : "",
          ...indexes.map((i) => `- ${i.indexname}: ${i.indexdef}`),
        ].filter(Boolean).join("\n");

        await ingestDocument({
          sourceId,
          projectId,
          externalId: `db-table-${fullName}`,
          title: `Table: ${fullName}`,
          content,
          metadata: {
            source: "database",
            section: "schema",
            schema: table.table_schema,
            table: table.table_name,
            columnCount: columns.length,
          },
        });
        indexed++;
      }
    }

    // Sample data
    if (includeSampleData) {
      for (const table of targetTables) {
        try {
          const fullName = `${table.table_schema}.${table.table_name}`;
          const rows = await sql.unsafe(`SELECT * FROM "${table.table_schema}"."${table.table_name}" LIMIT 5`);

          if (rows.length === 0) continue;

          const content = [
            `# Sample Data: ${fullName}`,
            `\n${rows.length} sample rows:\n`,
            "```json",
            JSON.stringify(rows, null, 2),
            "```",
          ].join("\n");

          await ingestDocument({
            sourceId,
            projectId,
            externalId: `db-sample-${fullName}`,
            title: `Sample Data: ${fullName}`,
            content,
            metadata: { source: "database", section: "sample_data", table: fullName },
          });
          indexed++;
        } catch {
          // Skip tables we can't read
        }
      }
    }
  } finally {
    await sql.end();
  }

  return { documentsIndexed: indexed, tablesProcessed: targetTables.length };
}
