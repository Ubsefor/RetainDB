/**
 * SOTA Memory Relation Detection
 * Detects relationships between memories (updates, extends, derives, contradicts)
 * Builds knowledge graph for temporal reasoning and version tracking
 */

import OpenAI from "openai";
import type { MemoryRelationship, RelationType } from "./types.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const RELATION_DETECTION_PROMPT = `You are an expert at detecting relationships between memories in a knowledge graph.

**Relation Types:**

1. **updates** - New memory supersedes/replaces old memory (state mutation)
   Example:
   - Old: "User's favorite color is blue"
   - New: "User's favorite color is green"
   - Relation: updates (green replaces blue)

2. **extends** - New memory adds detail to existing memory without contradiction (refinement)
   Example:
   - Old: "John works at Google"
   - New: "John works at Google as a Senior Engineer"
   - Relation: extends (adds job title)

3. **derives** - New memory is inferred from existing memory/memories (inference)
   Example:
   - Memory 1: "User prefers dark mode"
   - Memory 2: "User prefers high contrast"
   - New: "User likely has vision preferences for accessibility"
   - Relation: derives (inferred from both)

4. **contradicts** - New memory conflicts with existing memory (conflict detection)
   Example:
   - Old: "Meeting scheduled for 3pm"
   - New: "Meeting scheduled for 4pm"
   - Relation: contradicts (should trigger update)

5. **supports** - New memory provides evidence/support for existing memory
   Example:
   - Memory 1: "User is interested in ML"
   - New: "User enrolled in ML course"
   - Relation: supports (confirms interest)

**Important:**
- Only detect relations when there's a clear, meaningful connection
- Be conservative - if unsure, don't create a relation
- "updates" should invalidate the old memory (set validUntil)
- "extends" keeps the old memory valid but adds information
- "contradicts" should flag for review/resolution`;

export async function detectRelations(
  newMemory: {
    content: string;
    memoryType: string;
    entityMentions: string[];
  },
  existingMemories: Array<{
    id: string;
    content: string;
    memoryType: string;
    entityMentions: string[];
    documentDate: Date | null;
  }>
): Promise<MemoryRelationship[]> {
  if (existingMemories.length === 0) {
    return [];
  }

  // Filter to relevant memories (share entities or topics)
  const relevantMemories = filterRelevantMemories(newMemory, existingMemories);

  if (relevantMemories.length === 0) {
    return [];
  }

  const prompt = `${RELATION_DETECTION_PROMPT}

**New memory:**
"${newMemory.content}"
Type: ${newMemory.memoryType}
Entities: ${newMemory.entityMentions.join(", ")}

**Existing memories to check against:**
${relevantMemories.map((m, i) => `${i}. "${m.content}" (Type: ${m.memoryType}, Date: ${m.documentDate?.toISOString() || "unknown"})`).join("\n")}

Analyze if the new memory relates to any existing memories.

Return a JSON array of relations:
[{
  "toMemoryIndex": 0,
  "relationType": "updates|extends|derives|contradicts|supports",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation why this relation exists"
}]

Return ONLY the JSON array. If no relations found, return [].`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2048,
      temperature: 0.0,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      return [];
    }
    const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text;

    const relations = JSON.parse(jsonStr);

    if (!Array.isArray(relations)) {
      return [];
    }

    return relations
      .filter((r: any) => r.confidence >= 0.7) // High confidence threshold
      .map((r: any) => ({
        toMemoryId: relevantMemories[r.toMemoryIndex].id,
        relationType: r.relationType as RelationType,
        confidence: r.confidence,
        reasoning: r.reasoning,
      }));
  } catch (error) {
    console.error("Relation detection failed:", error);
    return [];
  }
}

/**
 * Filter memories that are likely related to the new memory
 * Reduces LLM calls and improves accuracy
 */
function filterRelevantMemories<T extends {
  id: string;
  content: string;
  entityMentions: string[];
}>(
  newMemory: {
    content: string;
    entityMentions: string[];
  },
  existingMemories: T[]
): T[] {
  return existingMemories.filter((existing) => {
    // Share at least one entity
    const sharedEntities = newMemory.entityMentions.some((entity) =>
      existing.entityMentions.includes(entity)
    );

    if (sharedEntities) {
      return true;
    }

    // Share significant keywords (simple keyword overlap)
    const newWords = extractKeywords(newMemory.content);
    const existingWords = extractKeywords(existing.content);

    const overlap = newWords.filter((w) => existingWords.includes(w));

    return overlap.length >= 2; // At least 2 shared keywords
  });
}

/**
 * Extract keywords from text (simple approach)
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "can",
    "to",
    "of",
    "in",
    "for",
    "on",
    "at",
    "by",
    "from",
    "with",
    "about",
  ]);

  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3 && !stopWords.has(word))
    .slice(0, 10); // Top 10 keywords
}

/**
 * Determine if relation should invalidate old memory
 */
export function shouldInvalidateMemory(relationType: RelationType): boolean {
  return relationType === "updates" || relationType === "contradicts";
}

/**
 * Build relation graph for traversal
 * Returns adjacency list representation
 */
export function buildRelationGraph(
  relations: Array<{
    fromMemoryId: string;
    toMemoryId: string;
    relationType: string;
  }>
): Map<string, Array<{ memoryId: string; relationType: string }>> {
  const graph = new Map<string, Array<{ memoryId: string; relationType: string }>>();

  for (const relation of relations) {
    // Forward edge (from → to)
    if (!graph.has(relation.fromMemoryId)) {
      graph.set(relation.fromMemoryId, []);
    }
    graph.get(relation.fromMemoryId)!.push({
      memoryId: relation.toMemoryId,
      relationType: relation.relationType,
    });

    // Backward edge (to → from) for bidirectional traversal
    if (!graph.has(relation.toMemoryId)) {
      graph.set(relation.toMemoryId, []);
    }
    graph.get(relation.toMemoryId)!.push({
      memoryId: relation.fromMemoryId,
      relationType: `inverse_${relation.relationType}`,
    });
  }

  return graph;
}

/**
 * Get version chain for a memory
 * Follows "updates" relations to find all versions
 */
export async function getVersionChain(
  memoryId: string,
  db: any
): Promise<Array<{ id: string; version: number; content: string; validFrom: string | null; validUntil: string | null }>> {
  const versions: any[] = [];

  // Helper to convert date to ISO string safely
  const toISOString = (date: Date | null | string | undefined): string | null => {
    if (!date) return null;
    if (typeof date === 'string') {
      // Already a string, check if valid
      try { new Date(date).toISOString(); return date; } catch { return null; }
    }
    try {
      const d = new Date(date);
      return isNaN(d.getTime()) ? null : d.toISOString();
    } catch {
      return null;
    }
  };

  // Get current memory
  let currentMemory = await db.memory.findUnique({
    where: { id: memoryId },
    select: {
      id: true,
      content: true,
      version: true,
      validFrom: true,
      validUntil: true,
      supersededBy: true,
    },
  });

  if (!currentMemory) {
    return [];
  }

  // Walk backward through supersedes relation
  const seenIds = new Set<string>();
  while (currentMemory && !seenIds.has(currentMemory.id)) {
    seenIds.add(currentMemory.id);

    versions.unshift({
      id: currentMemory.id,
      version: currentMemory.version,
      content: currentMemory.content,
      validFrom: toISOString(currentMemory.validFrom),
      validUntil: toISOString(currentMemory.validUntil),
    });

    // Find previous version
    const prev = await db.memory.findFirst({
      where: { supersededBy: currentMemory.id },
      select: {
        id: true,
        content: true,
        version: true,
        validFrom: true,
        validUntil: true,
        supersededBy: true,
      },
    });

    currentMemory = prev;
  }

  // Walk forward through supersededBy relation
  currentMemory = await db.memory.findUnique({
    where: { id: memoryId },
  });

  while (currentMemory?.supersededBy && !seenIds.has(currentMemory.supersededBy)) {
    seenIds.add(currentMemory.supersededBy);

    const next = await db.memory.findUnique({
      where: { id: currentMemory.supersededBy },
      select: {
        id: true,
        content: true,
        version: true,
        validFrom: true,
        validUntil: true,
        supersededBy: true,
      },
    });

    if (next) {
      versions.push({
        id: next.id,
        version: next.version,
        content: next.content,
        validFrom: toISOString(next.validFrom),
        validUntil: toISOString(next.validUntil),
      });

      currentMemory = next;
    } else {
      break;
    }
  }

  return versions;
}
