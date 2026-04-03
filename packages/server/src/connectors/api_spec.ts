import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface ApiSpecConfig {
  url?: string;
  content?: string;
  format?: "openapi" | "swagger" | "graphql";
}

/** Minimal YAML→JS parser for simple OpenAPI specs (covers 95% of real cases) */
function parseYaml(text: string): any {
  try {
    // Try dynamic import of js-yaml if available
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require("js-yaml");
    return yaml.load(text);
  } catch {
    // Fallback: hand-rolled minimal YAML→JSON for flat/nested objects
    // This handles the subset needed to detect openapi/swagger keys
    return parseMinimalYaml(text);
  }
}

function parseMinimalYaml(text: string): any {
  const result: any = {};
  const lines = text.split(/\r?\n/);
  const stack: Array<{ obj: any; indent: number }> = [{ obj: result, indent: -1 }];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    const match = line.match(/^(\s*)([^:]+):\s*(.*)/);
    if (!match) continue;
    const [, , key, value] = match;
    const trimKey = key.trim();
    const trimVal = value.trim().replace(/^['"]|['"]$/g, "");

    // Pop stack to the right indent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;
    if (trimVal) {
      parent[trimKey] = trimVal;
    } else {
      parent[trimKey] = {};
      stack.push({ obj: parent[trimKey], indent });
    }
  }
  return result;
}

export async function syncApiSpec(
  sourceId: string,
  projectId: string,
  config: ApiSpecConfig
) {
  if (!config.url && !config.content) {
    throw new Error("API spec requires 'url' or 'content' in config.");
  }

  let content = config.content || "";

  if (config.url) {
    const res = await fetch(config.url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Failed to fetch API spec: ${res.status} ${res.statusText}`);
    content = await res.text();
  }

  if (!content) throw new Error("No API spec content provided");

  // Detect format
  const trimmed = content.trimStart();
  const isYaml = !trimmed.startsWith("{") && !trimmed.startsWith("[");

  let spec: any;
  if (isYaml) {
    spec = parseYaml(content);
  } else {
    try {
      spec = JSON.parse(content);
    } catch {
      // Broken JSON — ingest raw
      await ingestDocument({
        sourceId, projectId,
        externalId: config.url || "api-spec",
        title: "API Specification",
        content,
        metadata: { format: config.format || "unknown", url: config.url },
        sourceType: "api_spec",
      });
      return { endpointsIndexed: 1 };
    }
  }

  const isOpenApi = spec?.openapi || spec?.swagger;
  const isGraphQL = spec?.__schema || spec?.data?.__schema || config.format === "graphql";

  if (isOpenApi) {
    return indexOpenApi(sourceId, projectId, spec, config.url);
  }

  if (isGraphQL) {
    const title = "GraphQL Schema";
    const schemaContent = JSON.stringify(spec, null, 2);
    const synthesis = await synthesizeDocument(schemaContent, "api_spec", title, { format: "graphql" });
    if (synthesis) {
      await ingestDocument({
        sourceId, projectId,
        externalId: `${config.url || "graphql-schema"}#synthesis`,
        title: "GraphQL Schema — Overview",
        content: formatSynthesis(synthesis, title),
        metadata: { format: "graphql", url: config.url, is_synthesis: true },
        sourceType: "api_spec",
      });
    }
    await ingestDocument({
      sourceId, projectId,
      externalId: config.url || "graphql-schema",
      title,
      content: schemaContent,
      metadata: { format: "graphql", url: config.url },
      sourceType: "api_spec",
    });
    return { endpointsIndexed: 1 };
  }

  // Unknown format
  await ingestDocument({
    sourceId, projectId,
    externalId: config.url || "api-spec",
    title: "API Specification",
    content: JSON.stringify(spec, null, 2),
    metadata: { url: config.url },
    sourceType: "api_spec",
  });

  return { endpointsIndexed: 1 };
}

async function indexOpenApi(
  sourceId: string,
  projectId: string,
  spec: any,
  url?: string
) {
  const title = spec.info?.title || "API";
  const version = spec.info?.version || "";
  const description = spec.info?.description || "";
  const servers = (spec.servers || []).map((s: any) => s.url).filter(Boolean);
  let indexed = 0;

  // Build rich overview
  const overviewParts = [`# ${title} ${version}`];
  if (description) overviewParts.push(`\n${description}`);
  if (servers.length > 0) overviewParts.push(`\n**Servers:** ${servers.join(", ")}`);

  // Collect tag descriptions
  if (spec.tags?.length) {
    overviewParts.push("\n## Tag Groups");
    for (const tag of spec.tags) {
      overviewParts.push(`- **${tag.name}**: ${tag.description || ""}`);
    }
  }

  // Endpoint summary table
  const paths = spec.paths || {};
  const endpointSummaries: string[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(methods as any)) {
      if (!["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) continue;
      const op = details as any;
      endpointSummaries.push(`- \`${method.toUpperCase()} ${path}\`: ${op.summary || op.operationId || ""}`);
    }
  }
  if (endpointSummaries.length > 0) {
    overviewParts.push("\n## Endpoints");
    overviewParts.push(endpointSummaries.slice(0, 50).join("\n"));
    if (endpointSummaries.length > 50) overviewParts.push(`_(${endpointSummaries.length - 50} more endpoints)_`);
  }

  const overviewContent = overviewParts.join("\n");
  const overviewTitle = `${title} ${version} — Overview`;

  // Synthesis for overview
  const synthesis = await synthesizeDocument(overviewContent, "api_spec", overviewTitle, {
    format: spec.openapi ? `OpenAPI ${spec.openapi}` : `Swagger ${spec.swagger}`,
    endpoints: String(endpointSummaries.length),
  });
  if (synthesis) {
    await ingestDocument({
      sourceId, projectId,
      externalId: `${url || "api"}-overview#synthesis`,
      title: `${title} — API Overview`,
      content: formatSynthesis(synthesis, overviewTitle),
      metadata: { format: "openapi", section: "synthesis", url, is_synthesis: true },
      sourceType: "api_spec",
    });
    indexed++;
  }

  if (overviewContent.length > 20) {
    await ingestDocument({
      sourceId, projectId,
      externalId: `${url || "api"}-overview`,
      title: overviewTitle,
      content: overviewContent,
      metadata: { format: "openapi", section: "overview", url },
      sourceType: "api_spec",
    });
    indexed++;
  }

  // Index each endpoint
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(methods as any)) {
      if (!["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) continue;

      const op = details as any;
      const summary = op.summary || "";
      const opDesc = op.description || "";
      const operationId = op.operationId || `${method}-${path}`;
      const tags = (op.tags || []).join(", ");

      const parts: string[] = [
        `## ${method.toUpperCase()} ${path}`,
        summary ? `\n**${summary}**` : "",
        tags ? `\nTags: ${tags}` : "",
        opDesc ? `\n${opDesc}` : "",
      ];

      // Parameters
      if (op.parameters?.length) {
        parts.push("\n### Parameters");
        for (const p of op.parameters) {
          const required = p.required ? " *(required)*" : "";
          const type = p.schema?.type || p.type || "";
          const desc = p.description || type;
          parts.push(`- \`${p.name}\` (${p.in})${required}: ${desc}`);
        }
      }

      // Request body
      if (op.requestBody) {
        parts.push("\n### Request Body");
        const bodyContent = op.requestBody.content || {};
        const desc = op.requestBody.description || "";
        if (desc) parts.push(desc);
        for (const [ct, schema] of Object.entries(bodyContent)) {
          parts.push(`Content-Type: \`${ct}\``);
          const s = (schema as any).schema;
          if (s?.properties) {
            const props = Object.entries(s.properties)
              .slice(0, 15)
              .map(([k, v]: [string, any]) => `  - \`${k}\` (${v.type || "any"}): ${v.description || ""}`)
              .join("\n");
            parts.push(props);
          } else if (s) {
            parts.push("```json\n" + JSON.stringify(s, null, 2).slice(0, 800) + "\n```");
          }
        }
      }

      // Responses
      if (op.responses) {
        parts.push("\n### Responses");
        for (const [code, resp] of Object.entries(op.responses)) {
          const r = resp as any;
          parts.push(`- **${code}**: ${r.description || ""}`);
        }
      }

      const endpointContent = parts.filter(Boolean).join("\n");

      await ingestDocument({
        sourceId, projectId,
        externalId: `${url || "api"}-${operationId}`,
        title: `${method.toUpperCase()} ${path} — ${summary || operationId}`,
        content: endpointContent,
        metadata: {
          format: "openapi",
          method: method.toUpperCase(),
          path,
          operationId,
          tags: op.tags,
          url,
        },
        sourceType: "api_spec",
      });
      indexed++;
    }
  }

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, {
      sourceType: "api_spec",
      rootUrl: url,
    }).catch(() => {});
  }

  return { endpointsIndexed: indexed };
}
