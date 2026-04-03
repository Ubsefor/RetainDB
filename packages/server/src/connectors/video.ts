import * as cheerio from "cheerio";
import { createReadStream } from "fs";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";

type VideoPlatform = "youtube" | "loom" | "generic";

type ProgressReporter = (progress: { current: number; total: number; message: string }) => void;

export interface VideoConfig {
  url: string;
  platform?: VideoPlatform;
  language?: string;
  allow_stt_fallback?: boolean;
  max_duration_minutes?: number;
  tags?: string[];
  max_chunks?: number;
}

type TranscriptSegment = {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker?: string;
};

type VideoExtraction = {
  title: string;
  transcript: TranscriptSegment[];
  duration_seconds?: number;
  published_at?: string;
  channel_or_author?: string;
  used_stt: boolean;
};

const MAX_AUDIO_BYTES = Number(process.env.VIDEO_STT_MAX_BYTES || 25 * 1024 * 1024);
const DEFAULT_MAX_DURATION_MINUTES = 180;
const DEFAULT_MAX_CHUNKS = 2000;

function detectPlatform(url: string, explicit?: VideoPlatform): VideoPlatform {
  if (explicit) return explicit;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
  if (host.includes("loom.com")) return "loom";
  return "generic";
}

function assertAllowedUrl(url: string, platform: VideoPlatform) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("unsupported_url: Only http/https video URLs are supported.");
  }

  const host = u.hostname.toLowerCase();
  if (platform === "youtube" && !(host.includes("youtube.com") || host.includes("youtu.be"))) {
    throw new Error("unsupported_url: Expected a YouTube URL.");
  }
  if (platform === "loom" && !host.includes("loom.com")) {
    throw new Error("unsupported_url: Expected a Loom URL.");
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function extractPublishedAtFromHtml(html: string): string | undefined {
  if (!html) return undefined;
  const $ = cheerio.load(html);

  const directCandidates = [
    $("meta[itemprop='datePublished']").attr("content"),
    $("meta[property='article:published_time']").attr("content"),
    $("meta[property='og:video:release_date']").attr("content"),
    $("time[datetime]").attr("datetime"),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of directCandidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const jsonLdBlocks = $("script[type='application/ld+json']")
    .toArray()
    .map((el) => $(el).contents().text())
    .filter(Boolean);

  for (const raw of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const value = node?.uploadDate || node?.datePublished;
        if (!value) continue;
        const date = new Date(String(value));
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }

  const regexMatch = html.match(/"(?:uploadDate|datePublished)"\s*:\s*"([^"]+)"/i);
  if (regexMatch?.[1]) {
    const parsed = new Date(regexMatch[1]);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return undefined;
}

function toTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function isLikelyMediaUrl(url: string): boolean {
  return /\.(mp4|m4a|mp3|wav|webm|mov|ogg)(\?.*)?$/i.test(url);
}

function chunkSegments(segments: TranscriptSegment[], maxChars = 1200): TranscriptSegment[] {
  if (segments.length === 0) return [];
  const out: TranscriptSegment[] = [];
  let cursor: TranscriptSegment | null = null;

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (!cursor) {
      cursor = { ...seg, text };
      continue;
    }

    const nextText = `${cursor.text}\n${text}`;
    if (nextText.length <= maxChars) {
      cursor.text = nextText;
      cursor.end_ms = Math.max(cursor.end_ms, seg.end_ms);
      continue;
    }

    out.push(cursor);
    cursor = { ...seg, text };
  }

  if (cursor) out.push(cursor);
  return out;
}

async function synthesizeVideoTranscript(
  segments: TranscriptSegment[],
  title: string,
  platform: VideoPlatform,
  url: string,
  durationSeconds?: number,
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const fullText = segments
    .map((s) => {
      const ts = toTimestamp(Math.floor(s.start_ms / 1000));
      return `[${ts}] ${s.text}`;
    })
    .join("\n");

  const synthesis = await synthesizeDocument(fullText, `${platform} video`, title, {
    url,
    duration: durationSeconds ? `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s` : "unknown",
  });

  if (!synthesis) return null;
  return formatSynthesis(synthesis, title);
}

function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "") || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const pathParts = u.pathname.split("/").filter(Boolean);
    const shortsIdx = pathParts.indexOf("shorts");
    if (shortsIdx >= 0 && pathParts[shortsIdx + 1]) return pathParts[shortsIdx + 1];
    return null;
  } catch {
    return null;
  }
}

async function fetchYouTubeMetadata(url: string): Promise<{ title?: string; author_name?: string; published_at?: string }> {
  let oembedData: { title?: string; author_name?: string; published_at?: string } = {};
  try {
    const oembed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (oembed.ok) {
      oembedData = (await oembed.json()) as any;
    }
  } catch {
    // fall through to page parse
  }

  try {
    const page = await fetch(url, { headers: { "User-Agent": "whisper-context-bot/1.0" } });
    if (page.ok) {
      const html = await page.text();
      return {
        ...oembedData,
        published_at: extractPublishedAtFromHtml(html),
      };
    }
  } catch {
    // best effort
  }
  return oembedData;
}

async function extractYouTubeTranscript(url: string, language?: string): Promise<VideoExtraction> {
  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error("unsupported_url: Could not resolve YouTube video id.");

  const langs = [language, "en", "en-US", ""].filter((l, i, arr) => l !== undefined && arr.indexOf(l) === i) as string[];
  let transcript: TranscriptSegment[] = [];

  for (const lang of langs) {
    try {
      const qs = new URLSearchParams({ fmt: "json3", v: videoId });
      if (lang) qs.set("lang", lang);
      const resp = await fetch(`https://www.youtube.com/api/timedtext?${qs.toString()}`);
      if (!resp.ok) continue;
      const raw = await resp.text();
      if (!raw || raw.trim().length < 3) continue;
      const parsed = JSON.parse(raw);
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      const next = events
        .map((ev: any) => {
          const text = (ev?.segs || []).map((s: any) => decodeHtmlEntities(String(s?.utf8 || ""))).join("").trim();
          const start_ms = Number(ev?.tStartMs || 0);
          const dur_ms = Number(ev?.dDurationMs || 0);
          return {
            text,
            start_ms,
            end_ms: start_ms + Math.max(dur_ms, 1000),
          };
        })
        .filter((s: TranscriptSegment) => s.text.length > 0);
      if (next.length > 0) {
        transcript = next;
        break;
      }
    } catch {
      // continue trying other language variants
    }
  }

  const metadata = await fetchYouTubeMetadata(url);
  const duration_seconds =
    transcript.length > 0 ? Math.floor(transcript[transcript.length - 1].end_ms / 1000) : undefined;

  return {
    title: metadata.title || `YouTube video ${videoId}`,
    transcript,
    duration_seconds,
    published_at: metadata.published_at,
    channel_or_author: metadata.author_name,
    used_stt: false,
  };
}

async function extractLoomTranscript(url: string): Promise<VideoExtraction> {
  let title = "Loom recording";
  let author: string | undefined;
  const transcript: TranscriptSegment[] = [];

  try {
    const oembed = await fetch(`https://www.loom.com/v1/oembed?url=${encodeURIComponent(url)}`);
    if (oembed.ok) {
      const parsed = (await oembed.json()) as any;
      title = parsed?.title || title;
      author = parsed?.author_name;
    }
  } catch {
    // no-op
  }

  try {
    const res = await fetch(url, { headers: { "User-Agent": "whisper-context-bot/1.0" } });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      const publishedAt = extractPublishedAtFromHtml(html);
      if (publishedAt) {
        author = author || $("meta[name='author']").attr("content") || author;
      }
      const combined = $("body").text().replace(/\s+/g, " ").trim();
      const cleaned = combined.slice(0, 20000);
      if (cleaned.length > 0) {
        transcript.push({ text: cleaned, start_ms: 0, end_ms: Math.max(1000, cleaned.length * 10) });
      }
      return {
        title,
        transcript,
        duration_seconds: transcript.length > 0 ? Math.floor(transcript[transcript.length - 1].end_ms / 1000) : undefined,
        published_at: publishedAt,
        channel_or_author: author,
        used_stt: false,
      };
    }
  } catch {
    // handled by fallback path
  }

  return {
    title,
    transcript,
    duration_seconds: transcript.length > 0 ? Math.floor(transcript[transcript.length - 1].end_ms / 1000) : undefined,
    channel_or_author: author,
    used_stt: false,
  };
}

async function transcribeMediaWithOpenAI(url: string, language?: string): Promise<{ text: string; duration_seconds?: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("stt_failed: OPENAI_API_KEY is missing for STT fallback.");

  const resp = await fetch(url, { headers: { "User-Agent": "whisper-context-bot/1.0" } });
  if (!resp.ok) throw new Error(`stt_failed: media download failed (${resp.status}).`);

  const len = Number(resp.headers.get("content-length") || 0);
  if (len > 0 && len > MAX_AUDIO_BYTES) {
    throw new Error(`stt_failed: media exceeds max bytes (${MAX_AUDIO_BYTES}).`);
  }

  const bytes = Buffer.from(await resp.arrayBuffer());
  if (bytes.length === 0) throw new Error("stt_failed: empty media payload.");
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new Error(`stt_failed: media exceeds max bytes (${MAX_AUDIO_BYTES}).`);
  }

  const extMatch = url.match(/\.([a-zA-Z0-9]+)(\?|$)/);
  const ext = extMatch ? extMatch[1] : "mp4";
  const tmpPath = join(tmpdir(), `whisper-video-${randomUUID()}.${ext}`);
  await fs.writeFile(tmpPath, bytes);

  try {
    const openai = new OpenAI({ apiKey });
    const transcript = await openai.audio.transcriptions.create({
      file: createReadStream(tmpPath) as any,
      model: process.env.VIDEO_STT_MODEL || "gpt-4o-mini-transcribe",
      ...(language ? { language } : {}),
      response_format: "verbose_json" as any,
    } as any);

    const text = String((transcript as any)?.text || "").trim();
    const duration_seconds = Number((transcript as any)?.duration || 0) || undefined;
    if (!text) throw new Error("stt_failed: STT returned empty transcript.");
    return { text, duration_seconds };
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}

async function extractGenericTranscript(url: string, language?: string, allowStt = true): Promise<VideoExtraction> {
  let title = "Video source";
  const transcript: TranscriptSegment[] = [];
  let used_stt = false;
  let duration_seconds: number | undefined;
  let published_at: string | undefined;

  if (allowStt && isLikelyMediaUrl(url)) {
    const stt = await transcribeMediaWithOpenAI(url, language);
    transcript.push({ text: stt.text, start_ms: 0, end_ms: Math.max(1000, (stt.duration_seconds || 60) * 1000) });
    used_stt = true;
    duration_seconds = stt.duration_seconds;
  } else {
    const res = await fetch(url, { headers: { "User-Agent": "whisper-context-bot/1.0" } });
    if (!res.ok) throw new Error(`transcript_unavailable: failed to fetch URL (${res.status}).`);
    const contentType = res.headers.get("content-type") || "";
    const raw = await res.text();
    if (contentType.includes("text/html")) {
      const $ = cheerio.load(raw);
      title = $("title").text().trim() || title;
      published_at = extractPublishedAtFromHtml(raw);
      const bodyText = $("body").text().replace(/\s+/g, " ").trim();
      if (bodyText) {
        transcript.push({
          text: bodyText.slice(0, 40000),
          start_ms: 0,
          end_ms: Math.max(1000, Math.floor(bodyText.length * 8)),
        });
      }
    } else if (raw.trim()) {
      transcript.push({ text: raw.trim().slice(0, 40000), start_ms: 0, end_ms: Math.max(1000, raw.length * 8) });
    }
  }

  return {
    title,
    transcript,
    duration_seconds: duration_seconds || (transcript.length ? Math.floor(transcript[transcript.length - 1].end_ms / 1000) : undefined),
    published_at,
    used_stt,
  };
}

function mapReasonCode(error: unknown): string {
  const msg = String((error as any)?.message || "");
  if (msg.startsWith("unsupported_url")) return "unsupported_url";
  if (msg.startsWith("transcript_unavailable")) return "transcript_unavailable";
  if (msg.startsWith("stt_failed")) return "stt_failed";
  if (msg.startsWith("oversize_video")) return "oversize_video";
  return "unknown";
}

export async function syncVideo(
  sourceId: string,
  projectId: string,
  config: VideoConfig,
  onProgress?: ProgressReporter,
  signal?: AbortSignal
) {
  const report = (current: number, total: number, stage: string, message: string) => {
    onProgress?.({ current, total, message: `[stage:${stage}] ${message}` });
  };

  const errors: string[] = [];
  const url = String(config.url || "").trim();
  if (!url) throw new Error("unsupported_url: video config.url is required.");

  const platform = detectPlatform(url, config.platform);
  assertAllowedUrl(url, platform);

  const allowSttFallback = config.allow_stt_fallback !== false;
  const maxDurationMinutes = Number(config.max_duration_minutes || DEFAULT_MAX_DURATION_MINUTES);
  const maxChunks = Math.max(1, Math.min(DEFAULT_MAX_CHUNKS, Number(config.max_chunks || DEFAULT_MAX_CHUNKS)));
  const transcriptRetrievedAt = new Date().toISOString();

  try {
    if (signal?.aborted) throw new Error("SYNC_ABORTED");
    report(0, 6, "extracting", "Resolving video source");

    let extracted: VideoExtraction;
    if (platform === "youtube") {
      extracted = await extractYouTubeTranscript(url, config.language);
    } else if (platform === "loom") {
      extracted = await extractLoomTranscript(url);
    } else {
      extracted = await extractGenericTranscript(url, config.language, allowSttFallback);
    }

    if (signal?.aborted) throw new Error("SYNC_ABORTED");
    report(1, 6, "transcribing", "Acquiring transcript");

    if (extracted.transcript.length === 0 && allowSttFallback) {
      try {
        const stt = await transcribeMediaWithOpenAI(url, config.language);
        extracted.transcript = [
          {
            text: stt.text,
            start_ms: 0,
            end_ms: Math.max(1000, (stt.duration_seconds || 60) * 1000),
          },
        ];
        extracted.duration_seconds = stt.duration_seconds || extracted.duration_seconds;
        extracted.used_stt = true;
      } catch (sttErr: any) {
        errors.push(String(sttErr?.message || sttErr));
      }
    }

    if (extracted.transcript.length === 0) {
      if (allowSttFallback && errors.some((e) => e.includes("stt_failed"))) {
        throw new Error("stt_failed: Transcript not available and STT fallback failed.");
      }
      throw new Error("transcript_unavailable: No transcript could be extracted from this video URL.");
    }

    const durationSeconds = extracted.duration_seconds || Math.floor(extracted.transcript[extracted.transcript.length - 1].end_ms / 1000);
    if (durationSeconds > maxDurationMinutes * 60) {
      throw new Error(`oversize_video: duration ${durationSeconds}s exceeds ${maxDurationMinutes} minutes.`);
    }

    report(2, 6, "segmenting", "Segmenting transcript");
    const merged = chunkSegments(extracted.transcript, 1200).slice(0, maxChunks);

    // Index LLM synthesis first — this is the "what is this video about" document
    report(3, 6, "synthesizing", "Generating high-level video synthesis");
    const synthesisContent = await synthesizeVideoTranscript(
      merged,
      extracted.title,
      platform,
      url,
      durationSeconds,
    );

    if (synthesisContent) {
      await ingestDocument({
        sourceId,
        projectId,
        externalId: `${url}#synthesis`,
        title: `${extracted.title} — Overview`,
        content: synthesisContent,
        metadata: {
          source: "video",
          source_kind: "video",
          video_url: url,
          platform,
          duration_seconds: durationSeconds,
          published_at: extracted.published_at,
          transcript_retrieved_at: transcriptRetrievedAt,
          channel_or_author: extracted.channel_or_author,
          is_synthesis: true,
          tags: config.tags || [],
        },
        filePath: `${platform}-video-synthesis.md`,
        sourceType: "video",
        ingestionProfile: "video_transcript",
      });
    }

    // Index transcript chunks with timestamps for specific lookups
    report(4, 6, "indexing", "Indexing transcript segments");
    let chunksIndexed = 0;
    for (const [idx, seg] of merged.entries()) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");

      const startSeconds = Math.floor(seg.start_ms / 1000);
      const endSeconds = Math.floor(seg.end_ms / 1000);
      const citation = `${url} @ ${toTimestamp(startSeconds)}`;

      // Prepend timestamp to content so "what happened at 45:27" is directly retrievable
      const startLabel = toTimestamp(startSeconds);
      const endLabel = toTimestamp(endSeconds);
      const timestampedContent = `[${startLabel} – ${endLabel}]\n${seg.text}`;

      await ingestDocument({
        sourceId,
        projectId,
        externalId: `${url}#t=${startSeconds}-${endSeconds}`,
        title: `${extracted.title} [${startLabel}]`,
        content: timestampedContent,
        metadata: {
          source: "video",
          source_kind: "video",
          video_url: url,
          platform,
          duration_seconds: durationSeconds,
          published_at: extracted.published_at,
          transcript_retrieved_at: transcriptRetrievedAt,
          channel_or_author: extracted.channel_or_author,
          timestamp_start_ms: seg.start_ms,
          timestamp_end_ms: seg.end_ms,
          speaker: seg.speaker,
          citation,
          path: `${url}@${toTimestamp(startSeconds)}`,
          line_start: startSeconds + 1,
          line_end: Math.max(startSeconds + 1, endSeconds + 1),
          used_stt: extracted.used_stt,
          tags: config.tags || [],
        },
        filePath: `${platform}-video.txt`,
        sourceType: "video",
        ingestionProfile: "video_transcript",
        skipEntityExtraction: true,
      });
      chunksIndexed += 1;
      if (idx % 20 === 0) {
        report(4, 6, "indexing", `Indexed ${idx + 1}/${merged.length} transcript segments`);
      }
    }

    report(6, 6, "completed", "Video source indexed");
    return {
      documentsIndexed: chunksIndexed + (synthesisContent ? 1 : 0),
      chunksIndexed,
      totalChunks: merged.length,
      durationSeconds: durationSeconds,
      platform,
      sourceUrl: url,
      usedStt: extracted.used_stt,
      synthesisGenerated: Boolean(synthesisContent),
      errors: errors.slice(0, 10),
    };
  } catch (error: any) {
    const reason = mapReasonCode(error);
    const message = String(error?.message || error);
    report(6, 6, "failed", `${reason}: ${message}`);
    throw new Error(`${reason}: ${message}`);
  }
}
