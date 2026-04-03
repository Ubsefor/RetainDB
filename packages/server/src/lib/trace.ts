import { randomUUID } from "crypto";

export function getTraceIdFromHeaders(headers: {
  [key: string]: string | undefined;
}): string {
  return headers["x-trace-id"] || headers["x-request-id"] || randomUUID();
}

export function getTraceIdFromRequest(c: {
  req: { header: (name: string) => string | undefined };
  get?: (key: string) => unknown;
}): string {
  const fromContext = typeof c.get === "function" ? c.get("traceId") : undefined;
  if (typeof fromContext === "string" && fromContext.length > 0) {
    return fromContext;
  }
  return (
    c.req.header("x-trace-id") ||
    c.req.header("x-request-id") ||
    randomUUID()
  );
}

export function normalizeParentTraceId(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}
