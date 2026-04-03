export type RouteSurface = "node" | "edge";
export type RouteAuthMode =
  | "public"
  | "auth_required"
  | "api_key_or_admin"
  | "admin_only";
export type RouteOrgRule = "public" | "auth_org" | "admin_override" | "header_org";
export type RouteTelemetryKind =
  | "request"
  | "retrieval"
  | "ingest"
  | "sync"
  | "webhook"
  | "admin";

export interface RouteControl {
  method: string;
  path: string;
  surface: RouteSurface;
  authMode: RouteAuthMode;
  orgRule: RouteOrgRule;
  adminOverride: boolean;
  rateBucket: string;
  auditRequired: boolean;
  idempotencyRequired: boolean;
  telemetry: RouteTelemetryKind[];
  securitySensitive: boolean;
}

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

function pathToRegex(path: string): RegExp {
  const escaped = path
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/:([A-Za-z0-9_]+)/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

function deriveAuthMode(path: string): RouteAuthMode {
  if (path === "/" || path === "/health" || path.startsWith("/v1/contracts/meta")) return "public";
  if (path.startsWith("/v1/wizard/auth/device/") || path === "/v1/wizard/events") return "public";
  if (path.startsWith("/v1/admin/")) return "admin_only";
  if (
    path === "/v1/memory" ||
    path === "/v1/memory/bulk" ||
    path === "/v1/memory/ingest/session" ||
    path === "/v1/memory/search" ||
    path === "/v1/context/query" ||
    path === "/v1/learn" ||
    path === "/v1/index" ||
    path === "/v1/index/bundle"
  ) {
    return "api_key_or_admin";
  }
  return "auth_required";
}

function deriveOrgRule(path: string): RouteOrgRule {
  if (path === "/" || path === "/health" || path.startsWith("/v1/contracts/meta")) return "public";
  if (path.startsWith("/v1/admin/")) return "admin_override";
  return "auth_org";
}

function deriveTelemetry(path: string): RouteTelemetryKind[] {
  if (path.startsWith("/v1/admin/")) return ["request", "admin"];
  if (path.includes("/sync") || path.includes("/sources")) return ["request", "sync"];
  if (path === "/v1/learn") return ["request", "ingest"];
  if (path === "/v1/index") return ["request", "ingest"];
  if (path.includes("/ingest")) return ["request", "ingest"];
  if (path.includes("/webhooks")) return ["request", "webhook"];
  if (path.includes("/query") || path.includes("/search") || path.includes("/oracle")) {
    return ["request", "retrieval"];
  }
  return ["request"];
}

function deriveRateBucket(path: string): string {
  if (path.startsWith("/v1/admin/")) return "admin";
  if (path.includes("/sync")) return "sync";
  if (path === "/v1/learn") return "ingest";
  if (path === "/v1/index") return "ingest";
  if (path.includes("/ingest")) return "ingest";
  if (path.includes("/query") || path.includes("/search")) return "query";
  if (path.includes("/memory")) return "memory";
  return "general";
}

function deriveIdempotency(method: string, path: string): boolean {
  const normalizedMethod = normalizeMethod(method);
  if (
    normalizedMethod !== "POST" &&
    normalizedMethod !== "PUT" &&
    normalizedMethod !== "PATCH" &&
    normalizedMethod !== "DELETE"
  ) {
    return false;
  }
  return (
    path === "/v1/projects/:projectId/sources" ||
    path === "/v1/projects/:projectId/add_source" ||
    path === "/v1/sources/:sourceId/sync" ||
    path === "/v1/projects/:projectId/ingest" ||
    path === "/v1/learn" ||
    path === "/v1/index" ||
    path === "/v1/webhooks/:id/redeliver" ||
    path === "/v1/admin/sources/rehydrate" ||
    path === "/v1/admin/config/import" ||
    path === "/v1/sources/:sourceId/restore"
  );
}

function buildControl(
  surface: RouteSurface,
  method: string,
  path: string
): RouteControl {
  const authMode = deriveAuthMode(path);
  return {
    method: normalizeMethod(method),
    path,
    surface,
    authMode,
    orgRule: deriveOrgRule(path),
    adminOverride: authMode === "admin_only",
    rateBucket: deriveRateBucket(path),
    auditRequired:
      authMode === "admin_only" ||
      ["POST", "PUT", "PATCH", "DELETE"].includes(normalizeMethod(method)),
    idempotencyRequired: deriveIdempotency(method, path),
    telemetry: deriveTelemetry(path),
    securitySensitive:
      authMode === "admin_only" ||
      path.includes("/keys") ||
      path.includes("/webhooks") ||
      path.includes("/restore") ||
      path.includes("/config/import"),
  };
}

export function buildRouteControlMatrix(
  routes: Array<{ method: string; path: string }>,
  surface: RouteSurface
): RouteControl[] {
  const unique = new Map<string, RouteControl>();
  for (const route of routes) {
    const key = `${normalizeMethod(route.method)} ${route.path}`;
    if (unique.has(key)) continue;
    unique.set(key, buildControl(surface, route.method, route.path));
  }
  return [...unique.values()].sort((a, b) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)
  );
}

export function getRouteControl(
  matrix: RouteControl[],
  method: string,
  path: string
): RouteControl | null {
  const normalizedMethod = normalizeMethod(method);
  for (const control of matrix) {
    if (control.method !== normalizedMethod) continue;
    if (pathToRegex(control.path).test(path)) return control;
  }
  return null;
}

export function assertRouteControlCoverage(
  matrix: RouteControl[],
  routes: Array<{ method: string; path: string }>,
  surface: RouteSurface
) {
  const missing = routes.filter((route) => {
    return !getRouteControl(matrix, route.method, route.path);
  });
  if (missing.length > 0) {
    throw new Error(
      `[route-controls:${surface}] Missing controls for ${missing
        .map((route) => `${normalizeMethod(route.method)} ${route.path}`)
        .join(", ")}`
    );
  }
}
