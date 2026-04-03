import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface DiscordConfig {
  token: string;
  guildId: string;
  channelIds?: string[];
  maxMessages?: number;
  daysBack?: number;
  includeThreadChannels?: boolean;
  includeEmbeds?: boolean;
  includeAttachments?: boolean;
}

interface DiscordProgress {
  stage: "fetching_channels" | "fetching_messages" | "indexing" | "done";
  current: number;
  total: number;
  message: string;
}

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RETRIES = 3;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function discordFetch(path: string, token: string, attempt = 0) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const body = await res.json().catch(() => ({}));
    const retryAfter = Number(body?.retry_after || 1);
    await sleep(Math.max(1, retryAfter * 1000));
    return discordFetch(path, token, attempt + 1);
  }

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await sleep((attempt + 1) * 1000);
    return discordFetch(path, token, attempt + 1);
  }

  if (!res.ok) throw new Error(`Discord API error: ${res.status}`);
  return res.json();
}

function formatDiscordMessage(
  message: any,
  includeEmbeds: boolean,
  includeAttachments: boolean
) {
  const parts: string[] = [];
  if (message?.content) parts.push(String(message.content).trim());

  if (includeEmbeds && Array.isArray(message?.embeds)) {
    for (const embed of message.embeds) {
      const label = [embed?.title, embed?.description, embed?.url].filter(Boolean).join(" | ");
      if (label) parts.push(`[embed] ${label}`);
    }
  }

  if (includeAttachments && Array.isArray(message?.attachments)) {
    for (const attachment of message.attachments) {
      const name = attachment?.filename || "attachment";
      const url = attachment?.url || "";
      parts.push(`[attachment] ${name}${url ? ` (${url})` : ""}`);
    }
  }

  return parts.join(" | ").replace(/\s+/g, " ").trim();
}

export async function syncDiscord(
  sourceId: string,
  projectId: string,
  config: DiscordConfig,
  onProgress?: (progress: DiscordProgress) => void,
  signal?: AbortSignal
) {
  const {
    token,
    guildId,
    maxMessages = 500,
    daysBack = 30,
    includeThreadChannels = true,
    includeEmbeds = true,
    includeAttachments = true,
  } = config;

  if (!token) {
    throw new Error("Discord requires 'token' in config. Create a Discord Bot and get the Bot token.");
  }

  let channelIds = config.channelIds || [];

  if (channelIds.length === 0) {
    onProgress?.({
      stage: "fetching_channels",
      current: 0,
      total: 0,
      message: "Fetching Discord channels...",
    });

    const channels: any[] = await discordFetch(`/guilds/${guildId}/channels`, token);
    channelIds = channels
      .filter((channel) => {
        if (channel.type === 0 || channel.type === 5) return true;
        if (includeThreadChannels && (channel.type === 11 || channel.type === 12)) return true;
        return false;
      })
      .map((channel) => channel.id);
  }

  const cutoff = Date.now() - daysBack * 86_400_000;
  let indexed = 0;
  const errors: string[] = [];

  for (let idx = 0; idx < channelIds.length; idx++) {
    if (signal?.aborted) throw new Error("SYNC_ABORTED");
    const channelId = channelIds[idx];

    onProgress?.({
      stage: "fetching_messages",
      current: idx + 1,
      total: channelIds.length,
      message: `Fetching Discord channel ${idx + 1}/${channelIds.length}...`,
    });

    try {
      const channel = await discordFetch(`/channels/${channelId}`, token);
      const channelName = channel?.name || channelId;

      const messages: any[] = [];
      let before: string | undefined;

      while (messages.length < maxMessages) {
        if (signal?.aborted) throw new Error("SYNC_ABORTED");
        let path = `/channels/${channelId}/messages?limit=100`;
        if (before) path += `&before=${before}`;

        const page: any[] = await discordFetch(path, token);
        if (!Array.isArray(page) || page.length === 0) break;

        for (const message of page) {
          const ts = new Date(message.timestamp).getTime();
          if (!Number.isFinite(ts) || ts < cutoff) continue;
          const hasContent = Boolean(
            message?.content?.trim() ||
              (includeEmbeds && message?.embeds?.length) ||
              (includeAttachments && message?.attachments?.length)
          );
          if (!hasContent) continue;
          messages.push(message);
          if (messages.length >= maxMessages) break;
        }

        const oldest = page[page.length - 1];
        const oldestTs = oldest ? new Date(oldest.timestamp).getTime() : 0;
        if (!oldest || !oldest.id || oldestTs < cutoff) break;
        before = oldest.id;
      }

      if (messages.length === 0) continue;

      const unique = new Map<string, any>();
      for (const message of messages) {
        if (!message?.id) continue;
        unique.set(message.id, message);
      }
      const ordered = [...unique.values()].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      const byDay = new Map<string, string[]>();
      for (const message of ordered) {
        const date = message.timestamp.split("T")[0];
        const time = message.timestamp.split("T")[1]?.slice(0, 5) || "";
        const author = message.author?.username || message.author?.global_name || "unknown";
        const text = formatDiscordMessage(message, includeEmbeds, includeAttachments);
        const line = `[${time}] ${author}: ${text}`;

        if (!byDay.has(date)) byDay.set(date, []);
        byDay.get(date)!.push(line);
      }

      onProgress?.({
        stage: "indexing",
        current: idx + 1,
        total: channelIds.length,
        message: `Indexing #${channelName}...`,
      });

      for (const [date, lines] of byDay.entries()) {
        const content = lines.join("\n");
        if (!content.trim()) continue;

        const title = `#${channelName} - ${date}`;
        const meta = {
          source: "discord",
          source_type: "discord",
          guildId,
          channelId,
          channelName,
          date,
          messageCount: lines.length,
        };

        const synthesis = await synthesizeDocument(content, "discord", title, { channel: channelName, date, guild: guildId });
        if (synthesis) {
          await ingestDocument({
            sourceId,
            projectId,
            externalId: `discord-${channelId}-${date}#synthesis`,
            title: `#${channelName} - ${date} — Summary`,
            content: formatSynthesis(synthesis, title),
            metadata: { ...meta, is_synthesis: true },
            sourceType: "discord",
          });
        }

        await ingestDocument({
          sourceId,
          projectId,
          externalId: `discord-${channelId}-${date}`,
          title,
          content,
          metadata: meta,
          sourceType: "discord",
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
    message: `Indexed ${indexed} Discord documents`,
  });

  if (indexed > 0) {
    generateSourceProfile(sourceId, projectId, { sourceType: "discord" }).catch(() => {});
  }

  return {
    documentsIndexed: indexed,
    channelsProcessed: channelIds.length,
    errors: errors.slice(0, 20),
    truncated: errors.length > 20,
  };
}

