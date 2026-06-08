import type { ConnectorProvider } from "./types.js";
import { fetchWithRetry, sleep } from "./fetch.js";

interface SlackConfig {
  token: string;
  channelIds?: string[];
  maxMessages?: number;
  daysBack?: number;
  includeThreads?: boolean;
  maxThreadReplies?: number;
  includeFiles?: boolean;
}

function asSlackConfig(input: Record<string, unknown>): SlackConfig {
  return {
    token: String(input.token || "").trim(),
    channelIds: Array.isArray(input.channelIds) ? input.channelIds.map(String) : undefined,
    maxMessages: typeof input.maxMessages === "number" ? input.maxMessages : 500,
    daysBack: typeof input.daysBack === "number" ? input.daysBack : 30,
    includeThreads: input.includeThreads !== false,
    maxThreadReplies: typeof input.maxThreadReplies === "number" ? input.maxThreadReplies : 50,
    includeFiles: input.includeFiles !== false,
  };
}

async function slackFetch(path: string, token: string, params: Record<string, string> = {}, attempt = 0): Promise<any> {
  const url = new URL(`https://slack.com/api${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429 && attempt < 3) {
    const ra = Number(res.headers.get("retry-after") || 1);
    await sleep(Math.max(1, ra) * 1000);
    return slackFetch(path, token, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  return data;
}

async function listChannels(token: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { types: "public_channel,private_channel", limit: "200" };
    if (cursor) params.cursor = cursor;
    const r = await slackFetch("/conversations.list", token, params);
    for (const c of r.channels || []) if (c?.id) ids.push(c.id);
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return [...new Set(ids)];
}

function formatMessage(m: any, includeFiles: boolean): string {
  const parts: string[] = [];
  if (m.text) parts.push(String(m.text).trim());
  if (includeFiles && Array.isArray(m.files)) {
    for (const f of m.files) parts.push(`[file] ${f?.name || "file"}${f?.permalink ? ` (${f.permalink})` : ""}`);
  }
  if (includeFiles && Array.isArray(m.attachments)) {
    for (const a of m.attachments) parts.push(`[attachment] ${a?.title || a?.fallback || "attachment"}${a?.text ? `: ${a.text}` : ""}`);
  }
  return parts.join(" | ").replace(/\s+/g, " ").trim();
}

export const slackConnector: ConnectorProvider = {
  type: "slack",
  requiresAuth: true,
  describe: () => "Pull recent messages from Slack channels (Bot token with channels:history).",
  schema: () => ({
    type: "slack",
    requiresAuth: true,
    summary: "Pull recent messages from Slack channels (Bot token with channels:history).",
    fields: [
      { name: "token", required: true, type: "string", description: "Slack Bot token (xoxb-…) with channels:history scope.", cliFlag: "token", secret: true },
      { name: "channelIds", required: false, type: "string[]", description: "Restrict to specific channel IDs (comma-separated). Empty = all visible channels.", cliFlag: "channels" },
      { name: "daysBack", required: false, type: "number", description: "Lookback window in days.", default: 30, cliFlag: "days-back" },
      { name: "maxMessages", required: false, type: "number", description: "Per-channel message cap.", default: 500, cliFlag: "max-messages" },
      { name: "includeThreads", required: false, type: "boolean", description: "Pull thread replies.", default: true, cliFlag: "threads" },
      { name: "includeFiles", required: false, type: "boolean", description: "Include file/attachment metadata in transcript.", default: true, cliFlag: "files" },
    ],
    example: { token: "xoxb-…", daysBack: 7 },
  }),
  validateConfig(config) {
    const c = asSlackConfig(config);
    if (!c.token) return { ok: false, error: "config.token is required (Slack Bot token with channels:history scope)" };
    if (!c.token.startsWith("xoxb-") && !c.token.startsWith("xoxp-")) {
      return { ok: false, error: "config.token must start with xoxb- or xoxp-" };
    }
    return { ok: true };
  },
  async sync({ source, signal, onProgress }) {
    const cfg = asSlackConfig(source.config);
    const channelIds = cfg.channelIds && cfg.channelIds.length > 0 ? cfg.channelIds : await listChannels(cfg.token);
    const oldest = String(Math.floor((Date.now() - cfg.daysBack! * 86_400_000) / 1000));
    const docs = [];
    for (let i = 0; i < channelIds.length; i++) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      const channelId = channelIds[i];
      onProgress?.({ stage: "fetching", current: i + 1, total: channelIds.length, message: `Channel ${i + 1}/${channelIds.length}` });
      try {
        const info = await slackFetch("/conversations.info", cfg.token, { channel: channelId });
        const channelName = info.channel?.name || channelId;
        const all: any[] = [];
        let cursor: string | undefined;
        while (all.length < cfg.maxMessages!) {
          if (signal?.aborted) throw new Error("SYNC_ABORTED");
          const params: Record<string, string> = { channel: channelId, limit: "200", oldest };
          if (cursor) params.cursor = cursor;
          const r = await slackFetch("/conversations.history", cfg.token, params);
          for (const m of r.messages || []) {
            if (m?.type !== "message") continue;
            if (!m?.text && !m?.files?.length && !m?.attachments?.length) continue;
            all.push(m);
            if (all.length >= cfg.maxMessages!) break;
          }
          if (!r.has_more) break;
          cursor = r.response_metadata?.next_cursor;
        }
        const byDay = new Map<string, string[]>();
        for (const m of all) {
          const ts = parseFloat(m.ts || "0");
          const date = new Date(ts * 1000).toISOString().split("T")[0];
          const time = new Date(ts * 1000).toISOString().split("T")[1].slice(0, 5);
          const author = m.user || m.bot_id || "unknown";
          const line = `[${time}] ${author}: ${formatMessage(m, cfg.includeFiles!)}`;
          if (!byDay.has(date)) byDay.set(date, []);
          byDay.get(date)!.push(line);
        }
        for (const [date, lines] of byDay) {
          if (lines.length === 0) continue;
          docs.push({
            external_id: `slack:${channelId}:${date}`,
            title: `#${channelName} - ${date}`,
            content: lines.join("\n"),
            source_type: "slack" as const,
            metadata: { channelId, channelName, date, messageCount: lines.length, daysBack: cfg.daysBack },
          });
        }
      } catch {
        // skip channel failures
      }
    }
    onProgress?.({ stage: "done", current: docs.length, total: docs.length, message: `Indexed ${docs.length} channel-days` });
    return docs;
  },
};
