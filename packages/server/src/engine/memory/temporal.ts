/**
 * SOTA Temporal Reasoning System
 * Handles temporal queries, relative dates, and event timeline reasoning
 * Key differentiator vs competitors (76.69% on LongMemEval temporal reasoning)
 * 
 * OPTIMIZATION: Fast path for simple queries, LLM only for complex temporal
 */

import OpenAI from "openai";
import type { TemporalFilter } from "./types.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

// Fast path: Keywords that definitely indicate temporal constraints
const TEMPORAL_KEYWORDS = [
  'yesterday', 'today', 'tomorrow', 'last week', 'this week', 'next week',
  'last month', 'this month', 'next month', 'last year', 'this year',
  'recently', 'ago', 'days ago', 'weeks ago', 'months ago', 'years ago',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
];

function hasTemporalKeyword(query: string): boolean {
  const lower = query.toLowerCase();
  return TEMPORAL_KEYWORDS.some(kw => lower.includes(kw));
}

// FAST REGEX PARSER: Handle simple patterns without LLM
function parseSimpleTemporal(query: string, questionDate: Date): TemporalFilter | null {
  const lower = query.toLowerCase();
  
  // Simple patterns that can be parsed with regex
  if (lower.includes('yesterday')) {
    const d = new Date(questionDate);
    d.setDate(d.getDate() - 1);
    return { 
      hasTemporalConstraint: true, 
      relative: 'yesterday',
      dateRange: { start: d, end: d }
    };
  }
  
  if (lower.includes('today')) {
    return { 
      hasTemporalConstraint: true, 
      relative: 'today',
      dateRange: { start: questionDate, end: questionDate }
    };
  }
  
  if (lower === 'last week' || lower.includes('last week')) {
    const start = new Date(questionDate);
    start.setDate(start.getDate() - 7);
    return { 
      hasTemporalConstraint: true, 
      relative: 'last_week',
      dateRange: { start, end: questionDate }
    };
  }
  
  if (lower === 'last month' || lower.includes('last month')) {
    const start = new Date(questionDate);
    start.setMonth(start.getMonth() - 1);
    return { 
      hasTemporalConstraint: true, 
      relative: 'last_month',
      dateRange: { start, end: questionDate }
    };
  }
  
  if (lower === 'last year' || lower.includes('last year')) {
    const start = new Date(questionDate);
    start.setFullYear(start.getFullYear() - 1);
    return { 
      hasTemporalConstraint: true, 
      relative: 'last_year',
      dateRange: { start, end: questionDate }
    };
  }
  
  // Check for "X days/weeks/months ago"
  const daysAgo = lower.match(/(\d+)\s+days?\s+ago/);
  if (daysAgo) {
    const days = parseInt(daysAgo[1]);
    const start = new Date(questionDate);
    start.setDate(start.getDate() - days);
    return { 
      hasTemporalConstraint: true, 
      dateRange: { start, end: questionDate }
    };
  }
  
  return null; // Not a simple pattern, need LLM
}

const TEMPORAL_PARSING_PROMPT = `You are an expert temporal query parser. Extract temporal constraints from user queries.

**Your job:**
1. Identify if the query has temporal constraints
2. Extract relative time references (today, yesterday, last week, etc.)
3. Extract absolute dates if mentioned
4. Calculate date ranges if applicable

**Relative Terms:**
- "today" → filter to documentDate = questionDate
- "yesterday" → documentDate = questionDate - 1 day
- "last week" → documentDate in range [questionDate - 7 days, questionDate]
- "last month" → documentDate in range [questionDate - 30 days, questionDate]
- "last year" → documentDate in range [questionDate - 365 days, questionDate]
- "this week" → current week
- "this month" → current month

**Examples:**
- "What did I say about vacation yesterday?" → relative: "yesterday"
- "Tell me about meetings last week" → relative: "last_week"
- "What happened on January 15?" → absoluteDate: "2024-01-15"
- "Show me everything from last month" → relative: "last_month"
- "What's my favorite color?" → no temporal constraint`;

export async function parseTemporalQuery(
  query: string,
  questionDate: Date
): Promise<TemporalFilter> {
  // FAST PATH: If no temporal keywords, return no constraint immediately
  // This avoids LLM call for 90% of queries
  if (!hasTemporalKeyword(query)) {
    return { hasTemporalConstraint: false };
  }

  // FASTER PATH: Try regex parser first for simple patterns
  // This handles 80% of temporal queries without LLM
  const simpleResult = parseSimpleTemporal(query, questionDate);
  if (simpleResult) {
    return simpleResult;
  }

  const prompt = `${TEMPORAL_PARSING_PROMPT}

**Query:** "${query}"
**Question asked on:** ${questionDate.toISOString()}

Extract temporal information and return JSON:
{
  "hasTemporalConstraint": boolean,
  "relative": "today|yesterday|last_week|last_month|last_year|this_week|this_month|null",
  "absoluteDate": "ISO date string or null",
  "dateRange": { "start": "ISO", "end": "ISO" } or null
}

Return ONLY the JSON, no other text.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Faster model for parsing
      max_tokens: 512,
      temperature: 0.0,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      return { hasTemporalConstraint: false };
    }
    const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;

    const parsed = JSON.parse(jsonStr);

    // Convert relative to absolute dates
    if (parsed.relative) {
      const range = calculateRelativeDateRange(parsed.relative, questionDate);
      parsed.dateRange = range;
      parsed.absoluteDate = range.start;
    } else if (parsed.absoluteDate) {
      parsed.absoluteDate = new Date(parsed.absoluteDate);
    }

    // Convert date strings to Date objects in range
    if (parsed.dateRange) {
      parsed.dateRange = {
        start: new Date(parsed.dateRange.start),
        end: new Date(parsed.dateRange.end),
      };
    }

    return parsed;
  } catch (error) {
    console.error("Temporal parsing failed:", error);
    return { hasTemporalConstraint: false };
  }
}

/**
 * Calculate absolute date range from relative term
 */
export function calculateRelativeDateRange(
  relative: string,
  from: Date
): { start: Date; end: Date } {
  const start = new Date(from);
  const end = new Date(from);

  switch (relative) {
    case "today":
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;

    case "yesterday":
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      break;

    case "last_week":
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;

    case "this_week":
      // Start of current week (Monday)
      const dayOfWeek = start.getDay();
      const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Adjust for Sunday
      start.setDate(start.getDate() + diff);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;

    case "last_month":
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;

    case "this_month":
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;

    case "last_year":
      start.setFullYear(start.getFullYear() - 1);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;

    default:
      // Default to no constraint
      start.setFullYear(1970);
      end.setFullYear(2100);
  }

  return { start, end };
}

/**
 * Extract event date from memory content using LLM
 * Differentiates between documentDate (when said) and eventDate (when occurred)
 */
export async function extractEventDate(
  memoryContent: string,
  documentDate: Date
): Promise<Date | null> {
  const prompt = `Extract the event date from this memory.

**Important distinction:**
- documentDate: When this was said/written
- eventDate: When the event actually occurred/will occur

**Memory:** "${memoryContent}"
**Document Date (when this was said):** ${documentDate.toISOString()}

**Examples:**
- "User said they have a meeting tomorrow" → eventDate = documentDate + 1 day
- "User attended conference on Jan 15" → eventDate = Jan 15 of appropriate year
- "User's favorite color is blue" → eventDate = null (no event, just a fact)
- "Meeting happened yesterday" → eventDate = documentDate - 1 day

Return JSON:
{
  "hasEvent": boolean,
  "eventDate": "ISO date string or null",
  "reasoning": "brief explanation"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 256,
      temperature: 0.0,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      return null;
    }
    const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;

    const result = JSON.parse(jsonStr);

    if (result.hasEvent && result.eventDate) {
      return new Date(result.eventDate);
    }

    return null;
  } catch (error) {
    console.error("Event date extraction failed:", error);
    return null;
  }
}

/**
 * Check if a memory is valid at a given point in time
 * Uses validFrom/validUntil for version tracking
 */
export function isMemoryValidAt(
  memory: {
    validFrom: Date | null;
    validUntil: Date | null;
  },
  atTime: Date
): boolean {
  if (!memory.validFrom) {
    return true; // No validity constraints
  }

  if (atTime < memory.validFrom) {
    return false; // Not yet valid
  }

  if (memory.validUntil && atTime > memory.validUntil) {
    return false; // No longer valid
  }

  return true;
}

/**
 * Get the current version of a memory at a given time
 * Handles knowledge updates and versioning
 */
export async function getMemoryVersionAt(
  memoryId: string,
  atTime: Date,
  db: any
): Promise<any | null> {
  // Get all versions in the chain
  const versions = await db.memory.findMany({
    where: {
      OR: [
        { id: memoryId },
        { supersededBy: memoryId },
      ],
    },
    orderBy: {
      version: "asc",
    },
  });

  if (versions.length === 0) {
    return null;
  }

  // Find the version valid at the given time
  for (const version of versions.reverse()) {
    // Reverse to check newest first
    if (isMemoryValidAt(version, atTime)) {
      return version;
    }
  }

  return null;
}

/**
 * Temporal distance scoring
 * Boost recent memories, decay old ones
 */
export function calculateTemporalRelevance(
  memoryDate: Date | string | null | undefined,
  questionDate: Date,
  decayFactor: number = 0.1
): number {
  if (!memoryDate) return 0.5;
  
  // Handle string dates from raw SQL queries
  const memDate = typeof memoryDate === 'string' ? new Date(memoryDate) : memoryDate;
  
  if (!(memDate instanceof Date) || isNaN(memDate.getTime())) {
    return 0.5;
  }
  
  const daysDiff = Math.abs(
    (questionDate.getTime() - memDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Exponential decay: score = e^(-decay * days)
  const score = Math.exp(-decayFactor * daysDiff);

  return score;
}

/**
 * Build timeline of events from memories
 * Useful for "what happened between X and Y" queries
 */
export interface TimelineEvent {
  date: Date;
  memory: {
    id: string;
    content: string;
    memoryType: string;
  };
}

export function buildTimeline(
  memories: Array<{
    id: string;
    content: string;
    memoryType: string;
    eventDate: Date | null;
    documentDate: Date | null;
  }>
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const memory of memories) {
    const date = memory.eventDate || memory.documentDate;
    if (date) {
      events.push({
        date,
        memory: {
          id: memory.id,
          content: memory.content,
          memoryType: memory.memoryType,
        },
      });
    }
  }

  // Sort by date
  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  return events;
}
