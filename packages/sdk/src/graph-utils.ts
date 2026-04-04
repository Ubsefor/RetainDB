export interface MemoryGraphNode {
  id: string;
  label?: string;
  memory_type?: string;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  type?: string;
}

export interface MemoryGraphPayload {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

function sanitizeId(id: string): string {
  return `n_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function shortLabel(input: string, max = 48): string {
  const text = (input || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

/**
 * Convert memory graph payload to Mermaid flowchart syntax.
 * Useful for quick visualization in docs/dashboards.
 */
export function memoryGraphToMermaid(graph: MemoryGraphPayload): string {
  const lines: string[] = ["flowchart LR"];

  for (const node of graph.nodes || []) {
    const sid = sanitizeId(node.id);
    const label = shortLabel(node.label || node.id);
    lines.push(`  ${sid}["${label.replace(/"/g, '\\"')}"]`);
  }

  for (const edge of graph.edges || []) {
    const s = sanitizeId(edge.source);
    const t = sanitizeId(edge.target);
    const rel = shortLabel(edge.type || "rel", 18).replace(/"/g, '\\"');
    lines.push(`  ${s} -->|${rel}| ${t}`);
  }

  return lines.join("\n");
}

