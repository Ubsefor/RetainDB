import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "../db/index.js";

export type WebhookEvent =
  | "request.error"
  | "source.synced"
  | "source.sync_queued"
  | "source.rehydrated"
  | "source.failed"
  | "source.deleted"
  | "source.restored"
  | "document.indexed"
  | "document.deleted"
  | "memory.created"
  | "memory.updated"
  | "memory.deleted"
  | "entity.extracted"
  | "project.created"
  | "project.deleted"
  | "ops.alert";

interface WebhookPayload {
  eventId?: string;
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, any>;
}

interface DeliveryResult {
  webhookId: string;
  url: string;
  eventId?: string;
  attempt?: number;
  success: boolean;
  statusCode?: number;
  error?: string;
  errorCode?: string;
  durationMs: number;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 30000];
const DELIVERY_TIMEOUT = 10_000;
const MAX_FAILURE_COUNT = 10;

export function fireWebhookEvent(
  orgId: string,
  event: WebhookEvent,
  data: Record<string, any>,
  opts?: { traceId?: string | null; parentTraceId?: string | null; action?: string }
): void {
  deliverWebhooks(orgId, event, data, opts).catch((err) => {
    console.error(`[webhooks] Failed to deliver ${event}:`, err);
  });
}

export async function deliverWebhooks(
  orgId: string,
  event: WebhookEvent,
  data: Record<string, any>,
  opts?: { traceId?: string | null; parentTraceId?: string | null; action?: string }
): Promise<DeliveryResult[]> {
  const hooks = await prisma.webhook.findMany({
    where: {
      orgId,
      isActive: true,
    },
  });

  const matchingHooks = hooks.filter((hook) => {
    const events = (hook.events as string[]) || [];
    return events.includes(event);
  });

  if (matchingHooks.length === 0) return [];

  const payload: WebhookPayload = {
    eventId: randomUUID(),
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  const results = await Promise.allSettled(
    matchingHooks.map((hook) => deliverToHook(hook, payload, opts))
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          webhookId: matchingHooks[i].id,
          url: matchingHooks[i].url,
          eventId: payload.eventId,
          success: false,
          error: r.reason?.message || "Unknown error",
          errorCode: "UNKNOWN",
          durationMs: 0,
        }
  );
}

export async function redeliverWebhookDelivery(
  deliveryId: string,
  opts?: { traceId?: string | null; parentTraceId?: string | null }
) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (!delivery) throw new Error("Webhook delivery not found");

  const hook = await prisma.webhook.findUnique({
    where: { id: delivery.webhookId },
  });
  if (!hook) throw new Error("Webhook not found");

  const payload = delivery.payload as unknown as WebhookPayload;
  return deliverToHook(
    hook,
    {
      eventId: delivery.eventId || payload.eventId || randomUUID(),
      event: delivery.event as WebhookEvent,
      timestamp: new Date().toISOString(),
      data: payload.data || (payload as any),
    },
    {
      traceId: opts?.traceId || null,
      parentTraceId: opts?.parentTraceId || delivery.traceId || null,
      action: "redeliver",
    }
  );
}

async function deliverToHook(
  hook: any,
  payload: WebhookPayload,
  opts?: { traceId?: string | null; parentTraceId?: string | null; action?: string }
): Promise<DeliveryResult> {
  if (!hook.secret) {
    console.error(`[webhooks] Refusing to deliver webhook ${hook.id}: no secret configured`);
    return { webhookId: hook.id, url: hook.url, success: false, durationMs: 0, error: "Webhook has no secret configured" };
  }
  const body = JSON.stringify(payload);
  const signature = signPayload(body, hook.secret);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS[attempt - 1] || 30000);
    }

    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT);

      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RetainDB-Signature": signature,
          "X-RetainDB-Event-Id": payload.eventId || "",
          "X-RetainDB-Event": payload.event,
          "X-RetainDB-Timestamp": payload.timestamp,
          "X-RetainDB-Delivery-Attempt": String(attempt + 1),
          "User-Agent": "whisper-context-webhooks/1.0",
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const durationMs = Date.now() - start;

      if (res.ok) {
        await prisma.webhook.update({
          where: { id: hook.id },
          data: {
            lastTriggeredAt: new Date(),
            lastDeliveredAt: new Date(),
            lastStatusCode: res.status,
            failureCount: 0,
          },
        });
        await persistWebhookDelivery(hook.id, {
          eventId: payload.eventId || null,
          event: payload.event,
          action: opts?.action || "deliver",
          attempt: attempt + 1,
          payload,
          statusCode: res.status,
          durationMs,
          traceId: opts?.traceId || null,
          parentTraceId: opts?.parentTraceId || null,
        });
        return {
          webhookId: hook.id,
          url: hook.url,
          eventId: payload.eventId,
          attempt: attempt + 1,
          success: true,
          statusCode: res.status,
          durationMs,
        };
      }

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        await incrementFailure(hook);
        const errorCode = `HTTP_${res.status}`;
        const responseBody = await safeResponseText(res);
        await persistWebhookDelivery(hook.id, {
          eventId: payload.eventId || null,
          event: payload.event,
          action: opts?.action || "deliver",
          attempt: attempt + 1,
          payload,
          statusCode: res.status,
          durationMs,
          errorCode,
          errorMessage: `HTTP ${res.status}`,
          responseBody,
          traceId: opts?.traceId || null,
          parentTraceId: opts?.parentTraceId || null,
        });
        return {
          webhookId: hook.id,
          url: hook.url,
          eventId: payload.eventId,
          attempt: attempt + 1,
          success: false,
          statusCode: res.status,
          error: `HTTP ${res.status}`,
          errorCode,
          durationMs,
        };
      }
    } catch (err: any) {
      const durationMs = Date.now() - start;

      if (attempt === MAX_RETRIES) {
        await incrementFailure(hook);
        const errorCode = err.name === "AbortError" ? "TIMEOUT" : "DELIVERY_ERROR";
        await persistWebhookDelivery(hook.id, {
          eventId: payload.eventId || null,
          event: payload.event,
          action: opts?.action || "deliver",
          attempt: attempt + 1,
          payload,
          durationMs,
          errorCode,
          errorMessage: err.name === "AbortError" ? "Timeout" : err.message,
          traceId: opts?.traceId || null,
          parentTraceId: opts?.parentTraceId || null,
        });
        return {
          webhookId: hook.id,
          url: hook.url,
          eventId: payload.eventId,
          attempt: attempt + 1,
          success: false,
          error: err.name === "AbortError" ? "Timeout" : err.message,
          errorCode,
          durationMs,
        };
      }
    }
  }

  await incrementFailure(hook);
  await persistWebhookDelivery(hook.id, {
    eventId: payload.eventId || null,
    event: payload.event,
    action: opts?.action || "deliver",
    attempt: MAX_RETRIES + 1,
    payload,
    durationMs: 0,
    errorCode: "MAX_RETRIES_EXHAUSTED",
    errorMessage: "Max retries exhausted",
    traceId: opts?.traceId || null,
    parentTraceId: opts?.parentTraceId || null,
  });
  return {
    webhookId: hook.id,
    url: hook.url,
    eventId: payload.eventId,
    attempt: MAX_RETRIES + 1,
    success: false,
    error: "Max retries exhausted",
    errorCode: "MAX_RETRIES_EXHAUSTED",
    durationMs: 0,
  };
}

async function incrementFailure(hook: any) {
  const newCount = (hook.failureCount || 0) + 1;

  await prisma.webhook.update({
    where: { id: hook.id },
    data: {
      failureCount: newCount,
      ...(newCount >= MAX_FAILURE_COUNT ? { isActive: false } : {}),
    },
  });

  if (newCount >= MAX_FAILURE_COUNT) {
    console.warn(`[webhooks] Auto-disabled webhook ${hook.id} after ${newCount} consecutive failures`);
  }
}

function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = signPayload(body, secret);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistWebhookDelivery(
  webhookId: string,
  input: {
    eventId?: string | null;
    event: string;
    action: string;
    attempt: number;
    payload: Record<string, any>;
    statusCode?: number;
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
    responseBody?: string;
    traceId?: string | null;
    parentTraceId?: string | null;
  }
) {
  await prisma.webhookDelivery.create({
    data: {
      webhookId,
      eventId: input.eventId || null,
      event: input.event,
      action: input.action,
      attempt: input.attempt,
      payload: input.payload,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      responseBody: input.responseBody,
      traceId: input.traceId || null,
      parentTraceId: input.parentTraceId || null,
    },
  });
}

async function safeResponseText(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return undefined;
  }
}
