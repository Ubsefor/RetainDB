type RemoteRerankRow = {
  index?: number;
  candidate_index?: number;
  score?: number;
  remote_score?: number;
  combined_score?: number;
  similarity?: number;
};

type InferenceRoute = "embedding" | "rerank";

function normalizeUrl(url?: string): string {
  return String(url || "").trim().replace(/\/+$/, "");
}

function resolveBaseUrl(route: InferenceRoute): string {
  if (route === "embedding") {
    return normalizeUrl(
      process.env.EMBEDDING_INFERENCE_BASE_URL ||
      process.env.EMBEDDING_BASE_URL ||
      process.env.INFERENCE_BASE_URL ||
      process.env.INFERENCE_API_URL
    );
  }
  return normalizeUrl(
    process.env.RERANK_INFERENCE_BASE_URL ||
    process.env.RERANK_BASE_URL ||
    process.env.INFERENCE_BASE_URL ||
    process.env.INFERENCE_API_URL
  );
}

const INFERENCE_TIMEOUT_MS = parseInt(process.env.INFERENCE_TIMEOUT_MS || "2500", 10);

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.INFERENCE_API_KEY || process.env.RETAINDB_INFERENCE_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function assertInferenceBaseUrl(route: InferenceRoute, baseUrl: string) {
  if (!baseUrl) {
    throw new Error(
      route === "embedding"
        ? "Embedding inference URL is not set (EMBEDDING_INFERENCE_BASE_URL or INFERENCE_BASE_URL)"
        : "Rerank inference URL is not set (RERANK_INFERENCE_BASE_URL or INFERENCE_BASE_URL)"
    );
  }
}

async function postJson(route: InferenceRoute, path: string, payload: Record<string, any>) {
  const baseUrl = resolveBaseUrl(route);
  assertInferenceBaseUrl(route, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, INFERENCE_TIMEOUT_MS));
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || `Remote inference request failed (${response.status})`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function parseEmbeddings(data: any): number[][] {
  const embeddings = data?.embeddings;
  if (!Array.isArray(embeddings)) {
    throw new Error("Invalid embeddings response shape");
  }
  if (!embeddings.every((row: any) => Array.isArray(row) && row.every((n: any) => typeof n === "number"))) {
    throw new Error("Embeddings response contains non-numeric values");
  }
  return embeddings;
}

export async function embedWithInferenceService(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const data = await postJson("embedding", "/v1/inference/embeddings", { inputs: texts });
  const embeddings = parseEmbeddings(data);
  if (embeddings.length !== texts.length) {
    throw new Error("Embedding count mismatch from inference service");
  }
  return embeddings;
}

export async function rerankWithInferenceService<T extends { content: string; score: number }>(
  query: string,
  candidates: T[],
  topK: number
): Promise<Array<T & { remoteScore: number; combinedScore: number }>> {
  if (!candidates.length) return [];

  const payload = {
    query,
    top_k: topK,
    candidates: candidates.map((candidate, index) => ({
      index,
      content: candidate.content,
      score: candidate.score,
    })),
  };

  const data = await postJson("rerank", "/v1/inference/rerank", payload);
  const rows: RemoteRerankRow[] = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.reranked)
      ? data.reranked
      : [];

  if (!rows.length) {
    throw new Error("Invalid rerank response shape");
  }

  const resolved = rows.map((row, position) => {
    const idx = Number.isInteger(row.index)
      ? Number(row.index)
      : Number.isInteger(row.candidate_index)
        ? Number(row.candidate_index)
        : position;
    const candidate = candidates[idx];
    if (!candidate) return null;
    const remoteScore =
      typeof row.remote_score === "number"
        ? row.remote_score
        : typeof row.combined_score === "number"
          ? row.combined_score
          : typeof row.similarity === "number"
            ? row.similarity
            : typeof row.score === "number"
              ? row.score
              : 0;
    return {
      ...candidate,
      remoteScore,
      combinedScore: remoteScore,
    };
  }).filter(Boolean) as Array<T & { remoteScore: number; combinedScore: number }>;

  if (!resolved.length) {
    throw new Error("Inference rerank returned no usable candidates");
  }

  return resolved
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, topK);
}
