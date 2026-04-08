/**
 * Pluggable storage backend for shared file storage.
 *
 * Config via env:
 *   STORAGE_TYPE=local|supabase|s3|r2   (default: local)
 *
 *   -- local --
 *   STORAGE_LOCAL_DIR=./data/files      (default)
 *
 *   -- supabase (recommended) --
 *   SUPABASE_URL=https://xxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   SUPABASE_STORAGE_BUCKET=retaindb-files
 *
 *   -- s3 --
 *   STORAGE_BUCKET=my-bucket
 *   AWS_REGION=us-east-1
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *
 *   -- r2 --
 *   STORAGE_BUCKET=my-bucket
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 */

import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";

export interface StorageBackend {
  /** Store a file buffer at the given key. */
  put(key: string, data: Buffer, mimeType?: string): Promise<void>;
  /** Retrieve a file buffer by key. */
  get(key: string): Promise<Buffer>;
  /** Delete a file by key. */
  delete(key: string): Promise<void>;
  /**
   * Return a presigned/redirect URL for the key, or null if the backend
   * requires inline serving via get().
   */
  presign(key: string, expiresInSeconds?: number): Promise<string | null>;
}

// ─── Local filesystem ────────────────────────────────────────────────────────

class LocalStorage implements StorageBackend {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private resolve(key: string): string {
    // Sanitise: strip leading slashes, collapse ".." segments
    const safe = key.replace(/\.\./g, "_").replace(/^\/+/, "");
    return join(this.baseDir, safe);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch {
      // File may already be gone — ignore
    }
  }

  async presign(_key: string): Promise<string | null> {
    // Local backend serves content inline; no pre-signed URL
    return null;
  }
}

// ─── Supabase Storage ────────────────────────────────────────────────────────
// Uses the Supabase Storage REST API directly — no SDK required.
// Docs: https://supabase.com/docs/guides/storage/restful-api

class SupabaseStorage implements StorageBackend {
  private baseUrl: string;
  private authHeader: string;
  private bucket: string;

  constructor(supabaseUrl: string, serviceRoleKey: string, bucket: string) {
    this.baseUrl = supabaseUrl.replace(/\/+$/, "") + "/storage/v1";
    this.authHeader = `Bearer ${serviceRoleKey}`;
    this.bucket = bucket;
  }

  async put(key: string, data: Buffer, mimeType?: string): Promise<void> {
    const url = `${this.baseUrl}/object/${this.bucket}/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": mimeType || "application/octet-stream",
        "x-upsert": "true",
      },
      body: data as unknown as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase Storage upload failed (${res.status}): ${text}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const url = `${this.baseUrl}/object/${this.bucket}/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: this.authHeader } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase Storage download failed (${res.status}): ${text}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const url = `${this.baseUrl}/object/${this.bucket}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [key] }),
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase Storage delete failed (${res.status}): ${text}`);
    }
  }

  async presign(key: string, expiresInSeconds = 3600): Promise<string | null> {
    const url = `${this.baseUrl}/object/sign/${this.bucket}/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { signedURL?: string };
    if (!json.signedURL) return null;
    // signedURL is a relative path — prefix with the Supabase project URL
    const base = this.baseUrl.replace("/storage/v1", "");
    return json.signedURL.startsWith("http") ? json.signedURL : base + json.signedURL;
  }
}

// ─── S3 / R2 ─────────────────────────────────────────────────────────────────

async function buildS3Backend(type: "s3" | "r2"): Promise<StorageBackend> {
  let S3Client: any, PutObjectCommand: any, GetObjectCommand: any, DeleteObjectCommand: any, getSignedUrl: any;

  try {
    ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
      await import("@aws-sdk/client-s3" as any));
    ({ getSignedUrl } = await import("@aws-sdk/s3-request-presigner" as any));
  } catch {
    throw new Error(
      `STORAGE_TYPE="${type}" requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner. ` +
        `Run: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
    );
  }

  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error("STORAGE_BUCKET env var is required for s3/r2 storage");

  const clientConfig: Record<string, any> = {
    credentials: {
      accessKeyId:
        type === "r2"
          ? process.env.R2_ACCESS_KEY_ID!
          : process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey:
        type === "r2"
          ? process.env.R2_SECRET_ACCESS_KEY!
          : process.env.AWS_SECRET_ACCESS_KEY!,
    },
  };

  if (type === "r2") {
    const accountId = process.env.R2_ACCOUNT_ID;
    if (!accountId) throw new Error("R2_ACCOUNT_ID env var is required for r2 storage");
    clientConfig.endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    clientConfig.region = "auto";
  } else {
    clientConfig.region = process.env.AWS_REGION || "us-east-1";
  }

  const client = new S3Client(clientConfig);

  return {
    async put(key, data, mimeType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: mimeType || "application/octet-stream",
        })
      );
    },

    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async presign(key, expiresInSeconds = 3600) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
    },
  };
}

// ─── Singleton factory ────────────────────────────────────────────────────────

let _backend: StorageBackend | null = null;

export async function getStorageBackend(): Promise<StorageBackend> {
  if (_backend) return _backend;

  const type = (process.env.STORAGE_TYPE || "local").toLowerCase() as "local" | "supabase" | "s3" | "r2";

  if (type === "local") {
    const dir = process.env.STORAGE_LOCAL_DIR || "./data/files";
    _backend = new LocalStorage(dir);
  } else if (type === "supabase") {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || "retaindb-files";
    if (!url) throw new Error("SUPABASE_URL env var is required for supabase storage");
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var is required for supabase storage");
    _backend = new SupabaseStorage(url, key, bucket);
  } else if (type === "s3" || type === "r2") {
    _backend = await buildS3Backend(type);
  } else {
    throw new Error(`Unknown STORAGE_TYPE="${type}". Valid values: local, supabase, s3, r2`);
  }

  return _backend;
}

/** Build the canonical storage key for an org's file. */
export function buildStorageKey(orgId: string, fileId: string, name: string): string {
  // Sanitise filename — keep extension, replace unsafe chars
  const ext = name.includes(".") ? "." + name.split(".").pop()!.replace(/[^a-z0-9]/gi, "") : "";
  return `orgs/${orgId}/files/${fileId}${ext}`;
}

/** Build the rdb:// URI used in API responses so agents can reference files. */
export function buildRdbUri(orgId: string, path: string): string {
  return `rdb://files/${orgId}${path.startsWith("/") ? path : "/" + path}`;
}
