import { Pool } from "pg";
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
    throw new Error("Database requires 'connectionString' in config. Format: postgres://user:***@host:5432/db");
  }

  let indexed = 0;
  let targetTables: any[] = [];

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });

  try {
    // Get all tables
    const allTablesResult = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
    `);
    const allTables = allTablesResult.rows;

    targetTables = tables?.length
      ? allTables.filter((t: any) => tables.includes(t.table_name) || tables.includes(`${t.table_schema}.${t.table_name}`))
      : allTables;

    // Index overall schema overview
    const overview = targetTables
      .map((t: any) => `- ${t.table_schema}.${t.table_name}`)
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
        const columnsResult = await pool.query(`
          SELECT
            column_name,
            data_type,
            is_nullable,
            column_default,
            character_maximum_length
          FROM information_schema.columns
          WHERE table_schema = $1
          AND table_name = $2
          ORDER BY ordinal_position
        `, [table.table_schema, table.table_name]);
        const columns = columnsResult.rows;

        // Get constraints
        const constraintsResult = await pool.query(`
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
          WHERE tc.table_schema = $1
          AND tc.table_name = $2
        `, [table.table_schema, table.table_name]);
        const constraints = constraintsResult.rows;

        // Get indexes
        const indexesResult = await pool.query(`
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = $1
          AND tablename = $2
        `, [table.table_schema, table.table_name]);
        const indexes = indexesResult.rows;

        const fullName = `${table.table_schema}.${table.table_name}`;

        const content = [
          `# Table: ${fullName}`,
          "\n## Columns\n",
          ...columns.map((c: any) => {
            const nullable = c.is_nullable === "YES" ? "nullable" : "not null";
            const def = c.column_default ? `, default: ${c.column_default}` : "";
            const len = c.character_maximum_length ? `(${c.character_maximum_length})` : "";
            return `- \`${c.column_name}\` ${c.data_type}${len} (${nullable}${def})`;
          }),
          constraints.length ? "\n## Constraints\n" : "",
          ...constraints.map((c: any) => {
            if (c.constraint_type === "FOREIGN KEY") {
              return `- FK \`${c.column_name}\` → ${c.foreign_table}.${c.foreign_column}`;
            }
            return `- ${c.constraint_type}: \`${c.column_name}\``;
          }),
          indexes.length ? "\n## Indexes\n" : "",
          ...indexes.map((i: any) => `- ${i.indexname}: ${i.indexdef}`),
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
          const rowsResult = await pool.query(`SELECT * FROM "${table.table_schema}"."${table.table_name}" LIMIT 5`);
          const rows = rowsResult.rows;

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
    await pool.end();
  }

  return { documentsIndexed: indexed, tablesProcessed: targetTables.length };
}
