import { createHash } from "crypto";
import { prisma } from "../db/index.js";

const DEFAULT_TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || "86400", 10);

function sortObject(value: any): any {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, any>>((acc, key) => {
        acc[key] = sortObject(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function getIdempotencyKey(headers: { [key: string]: string | undefined }): string | null {
  const raw = headers["Idempotency-Key"] || headers["idempotency-key"];
  if (!raw) return null;
  const key = raw.trim();
  if (!key) return null;
  return key.slice(0, 200);
}

export function hashIdempotencyPayload(payload: Record<string, any>): string {
  const normalized = sortObject(payload);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export async function loadIdempotentResponse(params: {
  orgId: string;
  endpoint: string;
  idempotencyKey: string;
  requestHash: string;
}) {
  const { orgId, endpoint, idempotencyKey, requestHash } = params;

  try {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT request_hash, status_code, response_body
      FROM api_idempotency
      WHERE org_id = ${orgId}
        AND endpoint = ${endpoint}
        AND idempotency_key = ${idempotencyKey}
        AND expires_at > NOW()
      LIMIT 1
    `;

    if (rows.length === 0) {
      return { type: "miss" as const };
    }

    const row = rows[0];
    if (row.request_hash !== requestHash) {
      return { type: "conflict" as const };
    }

    return {
      type: "hit" as const,
      statusCode: Number(row.status_code || 200),
      body: row.response_body,
    };
  } catch (error: any) {
    if (String(error?.message || "").toLowerCase().includes("api_idempotency")) {
      return { type: "miss" as const };
    }
    throw error;
  }
}

export async function storeIdempotentResponse(params: {
  orgId: string;
  endpoint: string;
  idempotencyKey: string;
  requestHash: string;
  statusCode: number;
  body: Record<string, any>;
  ttlSeconds?: number;
}) {
  const {
    orgId,
    endpoint,
    idempotencyKey,
    requestHash,
    statusCode,
    body,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  } = params;

  const expiresAt = new Date(Date.now() + Math.max(60, ttlSeconds) * 1000);

  try {
    await prisma.$executeRaw`
      INSERT INTO api_idempotency (
        id,
        org_id,
        endpoint,
        idempotency_key,
        request_hash,
        status_code,
        response_body,
        expires_at,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        ${orgId},
        ${endpoint},
        ${idempotencyKey},
        ${requestHash},
        ${statusCode},
        ${JSON.stringify(body)}::jsonb,
        ${expiresAt},
        NOW(),
        NOW()
      )
      ON CONFLICT (org_id, endpoint, idempotency_key)
      DO UPDATE SET
        request_hash = EXCLUDED.request_hash,
        status_code = EXCLUDED.status_code,
        response_body = EXCLUDED.response_body,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
  } catch (error: any) {
    if (String(error?.message || "").toLowerCase().includes("api_idempotency")) {
      return;
    }
    throw error;
  }
}
