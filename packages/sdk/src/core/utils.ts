export function normalizeBaseUrl(url: string): string {
  let normalized = url.trim().replace(/\/+$/, "");
  normalized = normalized.replace(/\/api\/v1$/i, "");
  normalized = normalized.replace(/\/v1$/i, "");
  normalized = normalized.replace(/\/api$/i, "");
  return normalized;
}

export function normalizeEndpoint(endpoint: string): string {
  const withLeadingSlash = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (/^\/api\/v1(\/|$)/i.test(withLeadingSlash)) {
    return withLeadingSlash.replace(/^\/api/i, "");
  }
  return withLeadingSlash;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function randomId(prefix = "id"): string {
  return `${prefix}_${stableHash(`${Date.now()}_${Math.random()}`)}`;
}
