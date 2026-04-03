import { prisma } from "../db/index.js";
import { fireWebhookEvent } from "./webhooks.js";
import { evaluateOperationalAlerts } from "./ops-observability.js";
import {
  markStaleSourceVersionsFailed,
  pruneSupersededSourceVersions,
  purgeExpiredDeletedSources,
} from "./source-versions.js";

// ─── Cron Parser ────────────────────────────────────────────
// Lightweight cron matching — supports: minute hour dayOfMonth month dayOfWeek
// Special values: * (any), */N (every N), N (exact), N-M (range), N,M (list)

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      for (let i = min; i <= max; i += step) values.push(i);
    } else if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) values.push(i);
    } else {
      values.push(parseInt(part, 10));
    }
  }

  return values;
}

function parseCron(expression: string): CronFields | null {
  // Handle common presets
  const presets: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
  };

  const expr = presets[expression] || expression;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minute: parseCronField(parts[0], 0, 59),
      hour: parseCronField(parts[1], 0, 23),
      dayOfMonth: parseCronField(parts[2], 1, 31),
      month: parseCronField(parts[3], 1, 12),
      dayOfWeek: parseCronField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function cronMatches(cron: CronFields, date: Date): boolean {
  return (
    cron.minute.includes(date.getMinutes()) &&
    cron.hour.includes(date.getHours()) &&
    cron.dayOfMonth.includes(date.getDate()) &&
    cron.month.includes(date.getMonth() + 1) &&
    cron.dayOfWeek.includes(date.getDay())
  );
}

// ─── Sync Runner ────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let maintenanceRunning = false;
let lastMaintenanceAt = 0;
const MAINTENANCE_INTERVAL_MS = Math.max(
  parseInt(process.env.OPS_MAINTENANCE_INTERVAL_MS || "600000", 10),
  60_000
);
const OPS_ALERT_ORG_ID = process.env.OPS_ALERT_ORG_ID || process.env.SIMPLECLAW_ORG_ID || "";
const alertCooldownByCode = new Map<string, number>();
const ALERT_COOLDOWN_MS = Math.max(parseInt(process.env.OPS_ALERT_COOLDOWN_MS || "1800000", 10), 60_000);

/**
 * Start the scheduled sync runner. Checks every minute for sources due to sync.
 */
export function startScheduler() {
  if (schedulerInterval) return;

  console.log("[scheduler] Starting sync scheduler (checks every 60s)");

  // Run immediately on start, then every 60 seconds
  runScheduledSyncs();
  runOperationalMaintenance();
  schedulerInterval = setInterval(() => {
    void runScheduledSyncs();
    void runOperationalMaintenance();
  }, 60_000);
}

/**
 * Stop the scheduler.
 */
export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[scheduler] Scheduler stopped");
  }
}

/**
 * Check for and run any sources due for a scheduled sync.
 */
async function runScheduledSyncs() {
  if (isRunning) return; // prevent overlapping runs
  isRunning = true;

  try {
    const now = new Date();

    // Find all sources with a sync schedule that aren't currently syncing
    const scheduledSources = await prisma.$queryRaw`
      SELECT
        s.*, p."orgId" as "projectOrgId"
      FROM sources s
      INNER JOIN projects p ON p.id = s."projectId"
      WHERE s."syncSchedule" IS NOT NULL
        AND s.status NOT IN ('INDEXING', 'CONNECTING')
    `;

    let synced = 0;

    for (const source of scheduledSources as any[]) {
      if (!source.syncSchedule) continue;

      const cron = parseCron(source.syncSchedule);
      if (!cron) {
        console.warn(`[scheduler] Invalid cron "${source.syncSchedule}" for source ${source.id}`);
        continue;
      }

      // Check if this minute matches the cron schedule
      if (!cronMatches(cron, now)) continue;

      // Skip if synced recently (within last 55 seconds to avoid double-runs)
      if (source.lastSyncAt && now.getTime() - new Date(source.lastSyncAt).getTime() < 55_000) {
        continue;
      }

      console.log(`[scheduler] Triggering sync for source ${source.id} (${source.name})`);

      // Trigger sync in background
      triggerSync(source, source.projectOrgId).catch((err) => {
        console.error(`[scheduler] Sync failed for source ${source.id}:`, err);
      });

      synced++;
    }

    if (synced > 0) {
      console.log(`[scheduler] Triggered ${synced} scheduled syncs`);
    }
  } catch (err) {
    console.error("[scheduler] Error checking scheduled syncs:", err);
  } finally {
    isRunning = false;
  }
}

async function runOperationalMaintenance() {
  if (maintenanceRunning) return;
  const now = Date.now();
  if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
  maintenanceRunning = true;
  lastMaintenanceAt = now;
  try {
    const [staleVersions, purgedSources, prunedVersions, alertReport] = await Promise.all([
      markStaleSourceVersionsFailed(),
      purgeExpiredDeletedSources(),
      pruneSupersededSourceVersions(),
      evaluateOperationalAlerts(),
    ]);

    if (OPS_ALERT_ORG_ID) {
      for (const alert of alertReport.alerts) {
        const cooldownKey = `${alert.code}:${JSON.stringify(alert.metadata || {})}`;
        const lastSentAt = alertCooldownByCode.get(cooldownKey) || 0;
        if (Date.now() - lastSentAt < ALERT_COOLDOWN_MS) continue;
        alertCooldownByCode.set(cooldownKey, Date.now());
        fireWebhookEvent(OPS_ALERT_ORG_ID, "ops.alert", alert);
      }

      if (staleVersions > 0) {
        fireWebhookEvent(OPS_ALERT_ORG_ID, "ops.alert", {
          code: "STALE_SOURCE_VERSIONS",
          severity: "critical",
          category: "queue",
          summary: "Stale staged source versions were marked failed",
          metadata: { stale_versions: staleVersions },
          created_at: new Date().toISOString(),
        });
      }
      if (purgedSources.length > 0) {
        fireWebhookEvent(OPS_ALERT_ORG_ID, "ops.alert", {
          code: "EXPIRED_SOURCES_PURGED",
          severity: "warning",
          category: "lifecycle",
          summary: "Expired soft-deleted sources were purged",
          metadata: { purged_sources: purgedSources.map((source) => source.id) },
          created_at: new Date().toISOString(),
        });
      }
      if (prunedVersions > 0) {
        fireWebhookEvent(OPS_ALERT_ORG_ID, "ops.alert", {
          code: "SUPERSEDED_VERSIONS_PRUNED",
          severity: "warning",
          category: "lifecycle",
          summary: "Superseded source versions were pruned",
          metadata: { pruned_versions: prunedVersions },
          created_at: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] Operational maintenance failed:", err);
  } finally {
    maintenanceRunning = false;
  }
}

/**
 * Trigger a sync for a source. Dynamically imports the connector to avoid
 * circular dependencies and keep the scheduler lightweight.
 */
async function triggerSync(
  source: any,
  orgId: string
) {
  const startTime = Date.now();

  // Mark as syncing
  await prisma.source.update({
    where: { id: source.id },
    data: { status: "INDEXING", updatedAt: new Date() },
  });

  try {
    const config = (source.config || {}) as Record<string, any>;

    switch (source.connectorType) {
      case "github": {
        const { syncGitHub } = await import("../connectors/github.js");
        await syncGitHub(source.id, source.projectId, config as any);
        break;
      }
      case "gitlab": {
        const { syncGitLab } = await import("../connectors/gitlab.js");
        await syncGitLab(source.id, source.projectId, config as any);
        break;
      }
      case "url": {
        const { syncUrl } = await import("../connectors/url.js");
        await syncUrl(source.id, source.projectId, config as any);
        break;
      }
      case "sitemap": {
        const { syncSitemap } = await import("../connectors/sitemap.js");
        await syncSitemap(source.id, source.projectId, config as any);
        break;
      }
      case "notion": {
        const { syncNotion } = await import("../connectors/notion.js");
        await syncNotion(source.id, source.projectId, config as any);
        break;
      }
      case "confluence": {
        const { syncConfluence } = await import("../connectors/confluence.js");
        await syncConfluence(source.id, source.projectId, config as any);
        break;
      }
      case "slack": {
        const { syncSlack } = await import("../connectors/slack.js");
        await syncSlack(source.id, source.projectId, config as any);
        break;
      }
      case "discord": {
        const { syncDiscord } = await import("../connectors/discord.js");
        await syncDiscord(source.id, source.projectId, config as any);
        break;
      }
      case "huggingface": {
        const { syncHuggingFace } = await import("../connectors/huggingface.js");
        await syncHuggingFace(source.id, source.projectId, config as any);
        break;
      }
      case "api_spec": {
        const { syncApiSpec } = await import("../connectors/api_spec.js");
        await syncApiSpec(source.id, source.projectId, config as any);
        break;
      }
      case "database": {
        const { syncDatabase } = await import("../connectors/database.js");
        await syncDatabase(source.id, source.projectId, config as any);
        break;
      }
      case "npm_package": {
        const { syncNpmPackage } = await import("../connectors/npm_package.js");
        await syncNpmPackage(source.id, source.projectId, config as any);
        break;
      }
      case "pypi_package": {
        const { syncPyPIPackage } = await import("../connectors/pypi_package.js");
        await syncPyPIPackage(source.id, source.projectId, config as any);
        break;
      }
      case "arxiv": {
        const { syncArxiv } = await import("../connectors/arxiv.js");
        await syncArxiv(source.id, source.projectId, config as any);
        break;
      }
      case "pdf": {
        const { syncPdf } = await import("../connectors/pdf.js");
        await syncPdf(source.id, source.projectId, config as any);
        break;
      }
      case "video": {
        const { syncVideo } = await import("../connectors/video.js");
        await syncVideo(source.id, source.projectId, config as any);
        break;
      }
      default:
        throw new Error(`Unsupported connector type: ${source.connectorType}`);
    }

    const durationMs = Date.now() - startTime;

    // Update source status
    await prisma.source.update({
      where: { id: source.id },
      data: {
        status: "READY",
        lastSyncAt: new Date(),
        lastSyncDurationMs: durationMs,
        syncError: null,
        updatedAt: new Date(),
      },
    });

    // Fire webhook
    fireWebhookEvent(orgId, "source.synced", {
      sourceId: source.id,
      projectId: source.projectId,
      connectorType: source.connectorType,
      durationMs,
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;

    await prisma.source.update({
      where: { id: source.id },
      data: {
        status: "ERROR",
        syncError: err.message || "Unknown error",
        lastSyncDurationMs: durationMs,
        updatedAt: new Date(),
      },
    });

    // Fire failure webhook
    fireWebhookEvent(orgId, "source.failed", {
      sourceId: source.id,
      projectId: source.projectId,
      connectorType: source.connectorType,
      error: err.message,
      durationMs,
    });
  }
}
