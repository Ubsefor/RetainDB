/**
 * Importance Decay - Time-based relevance scoring
 * Old memories decay in importance unless frequently accessed
 */

import { db } from "../../db/index.js";

export interface DecayConfig {
  // Decay function type
  decayFunction: "exponential" | "linear" | "logarithmic";

  // Decay rate (0-1, higher = faster decay)
  decayRate: number;

  // Half-life in days (time for importance to decay by 50%)
  halfLifeDays: number;

  // Minimum importance (floor, prevents complete decay)
  minImportance: number;

  // Access boost (how much to boost importance when recalled)
  accessBoost: number;

  // Memory types that don't decay (permanent facts)
  permanentTypes?: string[];
}

const DEFAULT_CONFIG: DecayConfig = {
  decayFunction: "exponential",
  decayRate: 0.1,
  halfLifeDays: 30,
  minImportance: 0.1,
  accessBoost: 0.2,
  permanentTypes: ["factual", "instruction"], // Facts and instructions don't decay
};

/**
 * Calculate importance score with time decay
 */
export function calculateDecayedImportance(
  baseImportance: number,
  createdAt: Date,
  lastAccessedAt: Date | null,
  memoryType: string,
  config: Partial<DecayConfig> = {}
): number {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Permanent memory types don't decay
  if (cfg.permanentTypes?.includes(memoryType)) {
    return baseImportance;
  }

  // Calculate age in days
  const now = Date.now();
  const createdTime = createdAt.getTime();
  const ageInDays = (now - createdTime) / (1000 * 60 * 60 * 24);

  // Calculate time since last access
  const daysSinceAccess = lastAccessedAt
    ? (now - lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24)
    : ageInDays;

  // Apply decay function
  let decayMultiplier: number;

  switch (cfg.decayFunction) {
    case "exponential":
      // Exponential decay: importance = base * e^(-decay * time)
      decayMultiplier = Math.exp(-cfg.decayRate * ageInDays);
      break;

    case "linear":
      // Linear decay: importance = base * (1 - decay * time)
      decayMultiplier = Math.max(0, 1 - cfg.decayRate * ageInDays);
      break;

    case "logarithmic":
      // Logarithmic decay: importance = base / (1 + decay * log(time))
      decayMultiplier = 1 / (1 + cfg.decayRate * Math.log(1 + ageInDays));
      break;

    default:
      decayMultiplier = 1;
  }

  // Access boost: recently accessed memories are more important
  const accessBoost = lastAccessedAt
    ? cfg.accessBoost * Math.exp(-0.1 * daysSinceAccess)
    : 0;

  // Calculate final importance
  let importance = baseImportance * decayMultiplier + accessBoost;

  // Apply floor
  importance = Math.max(cfg.minImportance, Math.min(1.0, importance));

  return importance;
}

/**
 * Update importance scores for all memories in a project
 */
export async function updateImportanceScores(params: {
  projectId: string;
  config?: Partial<DecayConfig>;
  batchSize?: number;
}): Promise<{ updated: number; avgImportance: number }> {
  const { projectId, config = {}, batchSize = 1000 } = params;

  console.log(`🔄 Updating importance scores for project ${projectId}...`);

  let updated = 0;
  let totalImportance = 0;
  let offset = 0;

  while (true) {
    const memories = await db.memory.findMany({
      where: {
        projectId,
        isActive: true,
      },
      take: batchSize,
      skip: offset,
      select: {
        id: true,
        importance: true,
        memoryType: true,
        createdAt: true,
        lastAccessedAt: true,
      },
    });

    if (memories.length === 0) break;

    // Update each memory
    const updates = memories.map((memory) => {
      const newImportance = calculateDecayedImportance(
        memory.importance,
        memory.createdAt,
        memory.lastAccessedAt,
        memory.memoryType,
        config
      );

      totalImportance += newImportance;

      return db.memory.update({
        where: { id: memory.id },
        data: { importance: newImportance },
      });
    });

    await Promise.all(updates);

    updated += memories.length;
    offset += batchSize;

    console.log(`  Updated ${updated} memories...`);
  }

  const avgImportance = updated > 0 ? totalImportance / updated : 0;

  console.log(`✅ Updated ${updated} memories (avg importance: ${avgImportance.toFixed(3)})`);

  return { updated, avgImportance };
}

/**
 * Boost importance when memory is accessed
 */
export async function boostMemoryImportance(
  memoryId: string,
  config: Partial<DecayConfig> = {}
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: {
      importance: true,
      accessCount: true,
    },
  });

  if (!memory) return;

  // Boost importance (but cap at 1.0)
  const newImportance = Math.min(1.0, memory.importance + cfg.accessBoost);

  await db.memory.update({
    where: { id: memoryId },
    data: {
      importance: newImportance,
      lastAccessedAt: new Date(),
      accessCount: memory.accessCount + 1,
    },
  });
}

/**
 * Archive low-importance memories
 * Soft-delete memories that have decayed below threshold
 */
export async function archiveLowImportanceMemories(params: {
  projectId: string;
  importanceThreshold?: number;
  minAgeDays?: number;
}): Promise<{ archived: number }> {
  const { projectId, importanceThreshold = 0.15, minAgeDays = 90 } = params;

  const minDate = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

  const result = await db.memory.updateMany({
    where: {
      projectId,
      isActive: true,
      importance: { lt: importanceThreshold },
      createdAt: { lt: minDate },
      // Don't archive frequently accessed memories
      accessCount: { lt: 3 },
    },
    data: {
      isActive: false,
      validUntil: new Date(),
      metadata: {
        archivedReason: "low_importance",
        archivedAt: new Date().toISOString(),
      },
    },
  });

  console.log(`📦 Archived ${result.count} low-importance memories`);

  return { archived: result.count };
}

/**
 * Get importance statistics for a project
 */
export async function getImportanceStats(projectId: string): Promise<{
  total: number;
  avgImportance: number;
  distribution: {
    high: number; // > 0.7
    medium: number; // 0.3 - 0.7
    low: number; // < 0.3
  };
  oldestHighImportance: Date | null;
  newestLowImportance: Date | null;
}> {
  const memories = await db.memory.findMany({
    where: {
      projectId,
      isActive: true,
    },
    select: {
      importance: true,
      createdAt: true,
    },
  });

  const total = memories.length;
  const avgImportance =
    memories.reduce((sum, m) => sum + m.importance, 0) / (total || 1);

  const distribution = {
    high: memories.filter((m) => m.importance > 0.7).length,
    medium: memories.filter((m) => m.importance >= 0.3 && m.importance <= 0.7).length,
    low: memories.filter((m) => m.importance < 0.3).length,
  };

  const highImportance = memories.filter((m) => m.importance > 0.7);
  const oldestHighImportance =
    highImportance.length > 0
      ? highImportance.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
          .createdAt
      : null;

  const lowImportance = memories.filter((m) => m.importance < 0.3);
  const newestLowImportance =
    lowImportance.length > 0
      ? lowImportance.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
          .createdAt
      : null;

  return {
    total,
    avgImportance,
    distribution,
    oldestHighImportance,
    newestLowImportance,
  };
}

/**
 * Scheduled job to update importance scores
 */
export async function scheduledImportanceUpdate(orgId: string): Promise<void> {
  console.log(`🔄 Running scheduled importance update for org ${orgId}...`);

  const projects = await db.project.findMany({
    where: { orgId },
  });

  for (const project of projects) {
    try {
      await updateImportanceScores({
        projectId: project.id,
        config: {
          halfLifeDays: 30,
          minImportance: 0.1,
        },
      });

      // Archive very old, low-importance memories
      await archiveLowImportanceMemories({
        projectId: project.id,
        importanceThreshold: 0.1,
        minAgeDays: 180, // 6 months
      });
    } catch (error) {
      console.error(`Failed to update importance for project ${project.name}:`, error);
    }
  }

  console.log("✅ Scheduled importance update complete");
}
