import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface SlackConfig {
  token: string;
  channelIds?: string[];
  maxMessages?: number;
  daysBack?: number;
  includeThreads?: boolean;
  maxThreadReplies?: number;
  includeFiles?: boolean;
}

interface SlackProgress {
  stage: "fetching_channels" | "fetching_messages" | "indexing" | "done";
  current: number;
  total: number;
  message: string;
}

const MAX_RETRIES = 3;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function slackFetch(
  path: string,
  token: string,
  params?: Record<string, string>,
  attempt = 0
) {
  const url = new URL(`https://slack.com/api${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after") || 1);
    await sleep(Math.max(1, retryAfter) * 1000);
    return slackFetch(path, token, params, attempt + 1);
  }

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await sleep((attempt + 1) * 1000);
    return slackFetch(path, token, params, attempt + 1);
  }

  if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API: ${data.error}`);
  return data;
}

async function listAllChannelIds(token: string): Promise<string[]> {
  const channelIds: string[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = {
      types: "public_channel,private_channel",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;
    const response = await slackFetch("/conversations.list", token, params);
    const channels = response.channels || [];
    for (const channel of channels) {
      if (channel?.id) channelIds.push(channel.id);
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return [...new Set(channelIds)];
}

function formatSlackMessage(message: any, includeFiles: boolean) {
  const parts: string[] = [];
  if (message.text) parts.push(String(message.text).trim());

  if (includeFiles && Array.isArray(message.files)) {
    for (const file of message.files) {
      const name = file?.name || "file";
      const link = file?.permalink || file?.url_private || "";
      parts.push(`[file] ${name}${link ? ` (${link})` : ""}`);
    }
  }

  if (includeFiles && Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      const title = attachment?.title || attachment?.fallback || "attachment";
      const text = attachment?.text || "";
      parts.push(`[attachment] ${title}${text ? `: ${text}` : ""}`);
    }
  }

  return parts.join(" | ").replace(/\s+/g, " ").trim();
}

async function fetchThreadReplies(
  token: string,
  channelId: string,
  threadTs: string,
  maxThreadReplies: number,
  includeFiles: boolean
) {
  const replies: any[] = [];
  let cursor: string | undefined;

  while (replies.length < maxThreadReplies) {
    const params: Record<string, string> = {
      channel: channelId,
      ts: threadTs,
      limit: "200",
    };
    if (cursor) params.cursor = cursor;

    const response = await slackFetch("/conversations.replies", token, params);
    const items = (response.messages || []).filter((msg: any) => msg.ts !== threadTs);
    for (const msg of items) {
      if (!msg?.text && !msg?.files?.length && !msg?.attachments?.length) continue;
      replies.push(msg);
      if (replies.length >= maxThreadReplies) break;
    }

    if (!response.has_more || !response.response_metadata?.next_cursor) break;
    cursor = response.response_metadata.next_cursor;
  }

  return replies.map((reply) => {
    const time = new Date(parseFloat(reply.ts) * 1000).toISOString().split("T")[1].slice(0, 5);
    const author = reply.user || reply.bot_id || "unknown";
    const text = formatSlackMessage(reply, includeFiles);
    return `  ↳ [${time}] ${author}: ${text}`;
  });
}

export async function syncSlack(
  sourceId: string,
  projectId: string,
  config: SlackConfig,
  onProgress?: (progress: SlackProgress) => void,
  signal?: AbortSignal
) {
  const {
    token,
    maxMessages = 500,
    daysBack = 30,
    includeThreads = true,
    maxThreadReplies = 100,
    includeFiles = true,
  } = config;

  if (!token) {
    throw new Error("Slack requires 'token' in config. Create a Slack App and get a Bot token with channels:history scope.");
  }

  let channelIds = config.channelIds || [];
  if (channelIds.length === 0) {
    onProgress?.({
      stage: "fetching_channels",
      current: 0,
      total: 0,
      message: "Fetching Slack channels...",
    });
    channelIds = await listAllChannelIds(token);
  }

  const oldest = String(Math.floor((Date.now() - daysBack * 86_400_000) / 1000));
  let indexed = 0;
  const errors: string[] = [];

  for (let idx = 0; idx < channelIds.length; idx++) {
    if (signal?.aborted) throw new Error("SYNC_ABORTED");
    const channelId = channelIds[idx];

    onProgress?.({
      stage: "fetching_messages",
      current: idx + 1,
      total: channelIds.length,
      message: `Fetching channel ${idx + 1}/${channelIds.length}...`,
    });

    try {
      const channelInfo = await slackFetch("/conversations.info", token, { channel: channelId });
      const channelName = channelInfo.channel?.name || channelId;

      const allMessages: any[] = [];
      let cursor: string | undefined;

      while (allMessages.length < maxMessages) {
        if (signal?.aborted) throw new Error("SYNC_ABORTED");
        const params: Record<string, string> = {
          channel: channelId,
          limit: "200",
          oldest,
        };
        if (cursor) params.cursor = cursor;

        const response = await slackFetch("/conversations.history", token, params);
        const messages = response.messages || [];

        for (const message of messages) {
          const hasContent = Boolean(message?.text || message?.files?.length || message?.attachments?.length);
          if (message?.type !== "message" || !hasContent) continue;
          allMessages.push(message);
          if (allMessages.length >= maxMessages) break;
        }

        if (!response.has_more || !response.response_metadata?.next_cursor) break;
        cursor = response.response_metadata.next_cursor;
      }

      if (allMessages.length === 0) continue;

      const uniqueByTs = new Map<string, any>();
      for (const message of allMessages) {
        if (!message?.ts) continue;
        uniqueByTs.set(message.ts, message);
      }

      const ordered = [...uniqueByTs.values()].sort(
        (a, b) => parseFloat(a.ts || "0") - parseFloat(b.ts || "0")
      );

      const byDay = new Map<string, string[]>();

      for (const message of ordered) {
        if (signal?.aborted) throw new Error("SYNC_ABORTED");
        const date = new Date(parseFloat(message.ts) * 1000).toISOString().split("T")[0];
        const time = new Date(parseFloat(message.ts) * 1000).toISOString().split("T")[1].slice(0, 5);
        const author = message.user || message.bot_id || "unknown";
        const line = `[${time}] ${author}: ${formatSlackMessage(message, includeFiles)}`;

        if (!byDay.has(date)) byDay.set(date, []);
        byDay.get(date)!.push(line);

        if (includeThreads && message.thread_ts && message.thread_ts === message.ts && message.reply_count > 0) {
          try {
            const threadLines = await fetchThreadReplies(
              token,
              channelId,
              message.thread_ts,
              maxThreadReplies,
              includeFiles
            );
            if (threadLines.length > 0) {
              byDay.get(date)!.push(...threadLines);
            }
          } catch (error: any) {
            errors.push(`Thread ${channelId}/${message.thread_ts}: ${error?.message || "failed"}`);
          }
        }
      }

      onProgress?.({
        stage: "indexing",
        current: idx + 1,
        total: channelIds.length,
        message: `Indexing Slack channel #${channelName}...`,
      });

      for (const [date, lines] of byDay.entries()) {
        const content = lines.join("\n");
        if (!content.trim()) continue;

        const title = `#${channelName} - ${date}`;
        const meta = {
          source: "slack",
          source_type: "slack",
          channelId,
          channelName,
          date,
          messageCount: lines.length,
        };

        const synthesis = await synthesizeDocument(content, "slack", title, { channel: channelName, date });
        if (synthesis) {
          await ingestDocument({
            sourceId,
            projectId,
            externalId: `slack-${channelId}-${date}#synthesis`,
            title: `#${channelName} - ${date} — Summary`,
            content: formatSynthesis(synthesis, title),
            metadata: { ...meta, is_synthesis: true },
            sourceType: "slack",
          });
        }

        await ingestDocument({
          sourceId,
          projectId,
          externalId: `slack-${channelId}-${date}`,
          title,
          content,
          metadata: meta,
          sourceType: "slack",
        });
        indexed++;
      }
    } catch (error: any) {
      errors.push(`Channel ${channelId}: ${error?.message || "failed"}`);
    }
  }

  onProgress?.({
    stage: "done",
    current: indexed,
    total: indexed,
    message: `Indexed ${indexed} Slack documents`,
  });

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, { sourceType: "slack" }).catch(() => {});
  }

  return {
    documentsIndexed: indexed,
    channelsProcessed: channelIds.length,
    errors: errors.slice(0, 20),
    truncated: errors.length > 20,
  };
}

