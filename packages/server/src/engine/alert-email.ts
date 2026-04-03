import type { WebhookEvent } from "./webhooks.js";

const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const ALERT_EMAIL_ENABLED = /^true$/i.test(process.env.ALERT_EMAIL_ENABLED || "true");
const ALERT_EMAIL_FROM = (process.env.ALERT_EMAIL_FROM || "RetainDB Alerts <onboarding@resend.dev>").trim();
const ALERT_EMAIL_TO = (process.env.ALERT_EMAIL_TO || "alex@retaindb.com")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ALERT_EMAIL_EVENTS = new Set(
  (process.env.ALERT_EMAIL_EVENTS || "request.error,ops.alert,source.failed,source.rehydrated,source.deleted,source.restored")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

function getField(data: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function getSeverity(event: WebhookEvent, data: Record<string, any>): string {
  return (
    getField(data, "severity") ||
    (event === "source.failed"
      ? "critical"
      : event === "request.error"
        ? Number(getField(data, "status")) >= 500
          ? "critical"
          : "warning"
        : event === "ops.alert"
          ? "warning"
          : "info")
  );
}

function buildSummary(event: WebhookEvent, data: Record<string, any>): string {
  const sourceName = getField(data, "sourceName", "source_name");
  const sourceId = getField(data, "sourceId", "source_id");
  const connectorType = getField(data, "connectorType", "connector_type");
  const sourceLabel = sourceName || sourceId || "source";
  switch (event) {
    case "request.error":
      return `${getField(data, "method") || "Request"} ${getField(data, "path") || "unknown path"} returned ${getField(data, "status") || "an error"}.`;
    case "source.failed":
      return `Sync failed for ${sourceLabel}${connectorType ? ` (${connectorType})` : ""}.`;
    case "source.rehydrated":
      return `Rehydrate started for ${sourceLabel}${connectorType ? ` (${connectorType})` : ""}.`;
    case "source.deleted":
      return `${sourceLabel} was soft-deleted.`;
    case "source.restored":
      return `${sourceLabel} was restored.`;
    case "ops.alert":
      return getField(data, "summary") || getField(data, "code") || "Operational alert triggered.";
    default:
      return `Alert received for ${event}.`;
  }
}

function buildRecommendedAction(event: WebhookEvent, data: Record<string, any>): string {
  switch (event) {
    case "request.error":
      return "Inspect the failing route, trace id, and error code. If this repeats for customers, treat it as a product incident rather than a one-off user mistake.";
    case "source.failed":
      return "Open the source status, inspect the error, then retry sync after fixing the connector, auth, or upstream content issue.";
    case "source.rehydrated":
      return "Monitor the queued sync job until the source returns to READY.";
    case "source.deleted":
      return "No action is needed if this was intentional. If not, restore the source before the restore window expires.";
    case "source.restored":
      return "No urgent action is needed. Re-sync the source if you need fresh documents immediately.";
    case "ops.alert":
      return "Review the alert details and the affected route, queue, or connector. If this repeats, treat it as an operational incident.";
    default:
      return "Review the alert details.";
  }
}

function buildFacts(event: WebhookEvent, data: Record<string, any>): Array<[string, string]> {
  const facts: Array<[string, string]> = [
    ["Event", event],
    ["Severity", getSeverity(event, data)],
  ];
  const candidates: Array<[string, string[]]> = [
    ["Status", ["status"]],
    ["Method", ["method"]],
    ["Path", ["path"]],
    ["Org ID", ["orgId", "org_id"]],
    ["User ID", ["userId", "user_id"]],
    ["Source", ["sourceName", "source_name", "sourceId", "source_id"]],
    ["Source ID", ["sourceId", "source_id"]],
    ["Project ID", ["projectId", "project_id"]],
    ["Connector", ["connectorType", "connector_type"]],
    ["Job ID", ["jobId", "job_id"]],
    ["Source Version", ["sourceVersionId", "source_version_id"]],
    ["Error Code", ["errorCode", "error_code", "code"]],
    ["Error", ["error"]],
    ["Restore Until", ["restore_until"]],
    ["Warning Codes", ["warning_codes"]],
    ["Documents Failed", ["documents_failed"]],
    ["Documents Indexed", ["documents_indexed"]],
    ["Trace ID", ["traceId", "trace_id"]],
    ["Created At", ["created_at", "restored_at", "deleted_at"]],
  ];

  for (const [label, keys] of candidates) {
    const value = getField(data, ...keys);
    if (value) facts.push([label, value]);
  }

  if (data?.metadata && typeof data.metadata === "object") {
    facts.push(["Metadata", JSON.stringify(data.metadata)]);
  }

  return facts;
}

function shouldSendEmailForEvent(event: WebhookEvent): boolean {
  return ALERT_EMAIL_ENABLED && ALERT_EMAIL_TO.length > 0 && ALERT_EMAIL_EVENTS.has(event);
}

function renderSubject(event: WebhookEvent, data: Record<string, any>): string {
  switch (event) {
    case "request.error":
      return `[RetainDB Alert] ${data.method || "Request"} ${data.path || ""} failed${data.status ? ` (${data.status})` : ""}`.trim();
    case "ops.alert":
      return `[RetainDB Alert] ${data.summary || data.code || "Operational alert"}`;
    case "source.failed":
      return `[RetainDB Alert] Source failed${data.sourceId ? `: ${data.sourceId}` : ""}`;
    case "source.rehydrated":
      return `[RetainDB Alert] Source rehydrated${data.sourceId ? `: ${data.sourceId}` : ""}`;
    case "source.deleted":
      return `[RetainDB Alert] Source deleted${data.sourceId ? `: ${data.sourceId}` : ""}`;
    case "source.restored":
      return `[RetainDB Alert] Source restored${data.sourceId ? `: ${data.sourceId}` : ""}`;
    default:
      return `[RetainDB Alert] ${event}`;
  }
}

function renderHtml(event: WebhookEvent, data: Record<string, any>): string {
  const facts = buildFacts(event, data)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 10px;font-weight:600;border-bottom:1px solid #e5e7eb;vertical-align:top;">${escapeHtml(
          label
        )}</td><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const metadata = `<pre style="white-space:pre-wrap;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;background:#f6f8fa;padding:12px;border-radius:8px;">${escapeHtml(
    JSON.stringify(data, null, 2)
  )}</pre>`;
  return [
    `<h2 style="font-family:Arial,sans-serif;">${escapeHtml(renderSubject(event, data))}</h2>`,
    `<p style="font-family:Arial,sans-serif;"><strong>What happened:</strong> ${escapeHtml(buildSummary(event, data))}</p>`,
    `<p style="font-family:Arial,sans-serif;"><strong>What to do:</strong> ${escapeHtml(buildRecommendedAction(event, data))}</p>`,
    `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;margin:12px 0 16px 0;min-width:520px;">${facts}</table>`,
    metadata,
  ].join("\n");
}

function renderText(event: WebhookEvent, data: Record<string, any>): string {
  const facts = buildFacts(event, data).map(([label, value]) => `${label}: ${value}`);
  return [
    renderSubject(event, data),
    "",
    `What happened: ${buildSummary(event, data)}`,
    `What to do: ${buildRecommendedAction(event, data)}`,
    "",
    ...facts,
    "",
    "Raw payload:",
    JSON.stringify(data, null, 2),
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function maybeSendAlertEmail(event: WebhookEvent, data: Record<string, any>) {
  if (!shouldSendEmailForEvent(event)) return { sent: false, reason: "disabled_or_unmatched" as const };
  if (!RESEND_API_KEY) {
    console.warn(`[alert-email] Skipping ${event}: RESEND_API_KEY is not set`);
    return { sent: false, reason: "missing_api_key" as const };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: ALERT_EMAIL_FROM,
      to: ALERT_EMAIL_TO,
      subject: renderSubject(event, data),
      html: renderHtml(event, data),
      text: renderText(event, data),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Alert email failed: ${response.status} ${body.slice(0, 500)}`);
  }

  return { sent: true as const };
}
