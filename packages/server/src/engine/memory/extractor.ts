import OpenAI from "openai";
import { z } from "zod";
import type { ExtractedMemory, ExtractionContext, MemoryType } from "./types.js";

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
}

// ── Zod schema ────────────────────────────────────────────────────────────────

const MEMORY_TYPES = [
  "factual", "preference", "event", "relationship", "opinion", "goal", "instruction",
] as const;

const TEMPORAL_PRECISIONS = ["exact", "inferred_day", "inferred_month", "unknown"] as const;

const MemorySchema = z.object({
  content: z.string().min(10).max(500),
  memoryType: z.enum(MEMORY_TYPES),
  entityMentions: z.array(z.string().max(100)).max(10).default([]),
  eventDate: z.string().nullable().default(null),
  temporalPrecision: z.enum(TEMPORAL_PRECISIONS).default("unknown"),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200).optional(),
  sourceSpan: z.string().max(150).optional(),
});

const ExtractionResponseSchema = z.object({
  memories: z.array(MemorySchema).max(8),
});

type RawMemory = z.infer<typeof MemorySchema>;

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a high-precision memory extraction system. Your sole task is to extract durable, retrieval-useful memories from a text chunk.

## What qualifies as a memory

Extract only facts, preferences, relationships, events, goals, opinions, and persistent instructions that:
- Are explicitly stated or safely inferrable from context
- Would be useful to remember in a future conversation with this person
- Are stable (not transient session actions)

## What to SKIP

Do NOT extract:
- Greetings, acknowledgments, pleasantries
- Low-confidence inferences
- Near-duplicates of other memories you are already returning
- Multi-clause statements joined by "and" or "but" — split them

## Atomicity rule

Each memory must express exactly ONE fact, preference, relationship, event, goal, opinion, or instruction.

Bad: "Alex joined Google in 2023 and now leads the ML team"
Good:
  - "Alex joined Google in 2023"
  - "Alex leads the ML team at Google"

## Disambiguation rules

- Resolve pronouns only when the referent is clearly supported by context
- Resolve vague references ("the company", "the project") only when clearly identifiable from context
- If a reference cannot be resolved with high confidence, do NOT extract that memory

## Temporal rules

- eventDate: when the event happened, not when it was mentioned
- Set eventDate to null if timing is uncertain
- temporalPrecision: "exact" = explicit ISO date, "inferred_day" = safely computed, "inferred_month" = approximate, "unknown" = default

## Output constraints

- Return at most 5 memories (hard cap)
- Minimum confidence to include: 0.75
- reasoning: one short sentence max (for debug only)
- sourceSpan: a short verbatim fragment (≤15 words) from the chunk that grounds this memory
- content must be standalone and understandable without surrounding context

## Memory types

factual | preference | event | relationship | opinion | goal | instruction`;

// ── Core extraction ───────────────────────────────────────────────────────────

export async function extractMemories(
  chunk: string,
  context: ExtractionContext,
): Promise<ExtractedMemory[]> {
  if (!chunk.trim() || chunk.trim().length < 10) return [];

  const userPrompt = buildUserPrompt(chunk, context);

  const model = process.env.EXTRACTOR_MODEL || "gpt-5.4-mini";
  const isGpt5 = /^gpt-5/.test(model);

  // gpt-5 series uses max_completion_tokens + json_schema; gpt-4 uses max_tokens + json_object
  const createParams: any = {
    model,
    temperature: 0.0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    ...(isGpt5
      ? {
          max_completion_tokens: 1024,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "memory_extraction",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  memories: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        content: { type: "string" },
                        memoryType: { type: "string" },
                        entityMentions: { type: "array", items: { type: "string" } },
                        eventDate: { type: ["string", "null"] },
                        temporalPrecision: { type: "string" },
                        confidence: { type: "number" },
                        reasoning: { type: "string" },
                        sourceSpan: { type: "string" },
                      },
                      required: ["content", "memoryType", "entityMentions", "eventDate", "temporalPrecision", "confidence", "reasoning", "sourceSpan"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["memories"],
                additionalProperties: false,
              },
            },
          },
        }
      : {
          max_tokens: 1024,
          response_format: { type: "json_object" },
        }),
  };

  let raw: RawMemory[];
  try {
    // Retry up to 3 times on rate limit (429)
    let response: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await getOpenAIClient().chat.completions.create(createParams);
        break;
      } catch (err: any) {
        if (err?.status === 429 && attempt < 2) {
          const retryAfterMs = parseInt(err?.headers?.["retry-after-ms"] || "2000", 10);
          await new Promise(r => setTimeout(r, retryAfterMs + 500));
          continue;
        }
        throw err;
      }
    }

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      console.error("[extractor] empty response from OpenAI");
      return [];
    }

    let parsed: unknown;
    try {
      // Strip markdown code fences if present (some models wrap JSON in ```json ... ```)
      const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error("[extractor] JSON parse failed:", (e as Error).message, "| text:", text.slice(0, 200));
      return [];
    }

    // Normalize snake_case field names the model sometimes returns
    const MEMORY_TYPE_MAP: Record<string, string> = {
      fact: "factual", facts: "factual", information: "factual", info: "factual",
      issue: "factual", experience: "event", activity: "event", occurrence: "event",
      "success story": "event", story: "event", habit: "preference",
      desire: "preference", like: "preference", dislike: "preference", interest: "preference",
      task: "goal", objective: "goal", aim: "goal", want: "goal", plan: "goal",
      belief: "opinion", view: "opinion", attitude: "opinion",
      rule: "instruction", directive: "instruction", request: "instruction",
      connection: "relationship", association: "relationship",
    };
    const normalizeMemoryType = (raw: any): string => {
      if (!raw) return "factual"; // default when missing
      const v = String(raw).toLowerCase().trim();
      return MEMORY_TYPE_MAP[v] ?? (MEMORY_TYPES.includes(v as any) ? v : "factual");
    };
    const normalize = (item: any) => ({
      content: item.content ?? item.memory ?? item.text ?? item.description ?? item.fact ?? item.statement,
      memoryType: normalizeMemoryType(item.memoryType ?? item.memory_type ?? item.type ?? item.category),
      entityMentions: item.entityMentions ?? item.entity_mentions ?? item.entities ?? item.people ?? [],
      eventDate: item.eventDate ?? item.event_date ?? item.date ?? null,
      temporalPrecision: item.temporalPrecision ?? item.temporal_precision ?? "unknown",
      confidence: item.confidence ?? item.score ?? 0.8,
      reasoning: item.reasoning,
      sourceSpan: item.sourceSpan ?? item.source_span ?? item.source,
    });

    const rawParsed = (parsed as any)?.memories ?? parsed;
    const rawItems = Array.isArray(rawParsed) ? rawParsed.map(normalize) : [];

    // Validate items individually — drop bad ones rather than rejecting the whole batch
    const validItems: RawMemory[] = [];
    for (const item of rawItems) {
      const r = MemorySchema.safeParse(item);
      if (r.success) {
        validItems.push(r.data);
      } else {
        console.warn("[extractor] dropping invalid item:", JSON.stringify(item).slice(0, 150));
      }
    }
    raw = validItems;
  } catch (err: any) {
    console.error("[extractor] OpenAI call failed:", err?.message || err);
    return [];
  }

  return raw
    .filter(m => m.confidence >= 0.75)
    .slice(0, 5)
    .map(m => toExtractedMemory(m, context.documentDate));
}

// ── Batch extraction (concurrency-limited) ────────────────────────────────────

const DEFAULT_CONCURRENCY = 2;

export async function extractMemoriesBatch(
  chunks: Array<{ id: string; content: string }>,
  context: ExtractionContext,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<Map<string, ExtractedMemory[]>> {
  const results = new Map<string, ExtractedMemory[]>();
  const queue = [...chunks];
  const inFlight = new Set<Promise<void>>();

  const runOne = async (chunk: { id: string; content: string }) => {
    try {
      const memories = await extractMemories(chunk.content, context);
      results.set(chunk.id, memories);
    } catch (err: any) {
      console.error("[extractor] batch item failed:", chunk.id, err?.message || err);
      results.set(chunk.id, []);
    }
  };

  while (queue.length > 0 || inFlight.size > 0) {
    while (queue.length > 0 && inFlight.size < concurrency) {
      const chunk = queue.shift()!;
      const p = runOne(chunk).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  return results;
}

// ── Context builder ───────────────────────────────────────────────────────────

function buildUserPrompt(chunk: string, context: ExtractionContext): string {
  const parts: string[] = [];

  if (context.previousMessages && context.previousMessages.length > 0) {
    const recent = context.previousMessages.slice(-5).join("\n");
    parts.push(`## Context (recent messages)\n${recent}`);
  }

  if (context.entityContext && context.entityContext.size > 0) {
    const entities: string[] = [];
    context.entityContext.forEach((name, ref) => {
      entities.push(`- "${ref}" = ${name}`);
    });
    parts.push(`## Known entity references\n${entities.join("\n")}`);
  }

  parts.push(`## Document date\n${context.documentDate.toISOString()}`);
  parts.push(`## Chunk to extract from\n${chunk}`);
  parts.push(`Return a JSON object with a "memories" array.`);

  return parts.join("\n\n");
}

// ── Entity context builder ────────────────────────────────────────────────────

/**
 * Build a pronoun→name map from recent memories.
 *
 * Only maps pronouns when we have clear, unambiguous evidence:
 * - a single person name appearing in entityMentions
 * - confidence above threshold
 *
 * Returns empty map if ambiguous — better to provide no hints than wrong ones.
 */
export function buildEntityContext(
  recentMemories: Array<{ content: string; entityMentions: string[]; confidence: number }>,
): Map<string, string> {
  const entityMap = new Map<string, string>();

  // Collect person-like names (capitalized, 2+ chars, not all-caps acronym)
  const personNameFreq = new Map<string, number>();
  const personNamePattern = /^[A-Z][a-z]{1,25}(?:\s[A-Z][a-z]{1,25})*$/;

  for (const mem of recentMemories) {
    if (mem.confidence < 0.7) continue;
    for (const entity of mem.entityMentions) {
      if (personNamePattern.test(entity) && entity.length > 2) {
        personNameFreq.set(entity, (personNameFreq.get(entity) ?? 0) + 1);
      }
    }
  }

  // Only map pronouns if there is exactly one dominant person name
  // (avoids the "last entity wins" corruption bug)
  const persons = Array.from(personNameFreq.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (persons.length === 1) {
    const [name] = persons[0];
    entityMap.set("he", name);
    entityMap.set("she", name);
    entityMap.set("him", name);
    entityMap.set("her", name);
    entityMap.set("they", name);
  }
  // If persons.length > 1 we cannot safely assign pronouns — return empty map

  return entityMap;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Post-extraction quality filter.
 *
 * Checks for unresolved ambiguity rather than blindly rejecting any pronoun
 * (some pronouns are legitimately unambiguous in context, e.g. "OpenAI released their model").
 */
export function validateMemory(memory: ExtractedMemory): boolean {
  if (memory.confidence < 0.75) return false;
  if (memory.content.length < 10) return false;

  // Reject only when a personal pronoun is the SUBJECT and there are no entity mentions
  // that could ground it. "Their model" is fine; "He prefers dark mode" is not.
  const ambiguousSubject = /^(he|she|they|it)\b/i;
  if (ambiguousSubject.test(memory.content.trim()) && memory.entityMentions.length === 0) {
    console.warn("[extractor] rejected: ambiguous subject with no entities:", memory.content);
    return false;
  }

  // Reject vague subjects only when no named entity is present
  const vagueSubjectNoEntity =
    /^(the company|that project|this thing|the system)\b/i.test(memory.content.trim()) &&
    memory.entityMentions.length === 0;
  if (vagueSubjectNoEntity) {
    console.warn("[extractor] rejected: vague subject with no entities:", memory.content);
    return false;
  }

  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toExtractedMemory(raw: RawMemory, documentDate: Date): ExtractedMemory {
  let eventDate: Date | null = null;
  if (raw.eventDate) {
    const d = new Date(raw.eventDate);
    eventDate = isNaN(d.getTime()) ? null : d;
  }

  return {
    content: raw.content,
    memoryType: raw.memoryType as MemoryType,
    entityMentions: raw.entityMentions,
    eventDate,
    temporalPrecision: eventDate ? raw.temporalPrecision : "unknown",
    confidence: raw.confidence,
    reasoning: raw.reasoning,
    sourceSpan: raw.sourceSpan,
    inferred: false,
  };
}
