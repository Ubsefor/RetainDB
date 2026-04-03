import { ingestDocuments, finalizeSourceCounts, IngestDocumentInput } from "../engine/ingest.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rb", ".php", ".cs",
  ".rs", ".swift", ".kt", ".scala", ".c", ".cpp", ".h", ".hpp",
  ".md", ".mdx", ".rst", ".txt",
  ".json", ".yaml", ".yml", ".toml",
  ".sql", ".prisma", ".graphql",
  ".sol", ".vy",
  ".dockerfile", ".env.example",
]);

const MAX_FILE_SIZE = 500_000;
const MAX_TOTAL_FILES = 5000;  // Increased for large repos
const MAX_CONCURRENT_FETCHES = 20;
const BATCH_INGEST_SIZE = 50;  // Ingest in batches to manage memory

function hasScannableExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const ext of SCANNABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

interface GitHubConfig {
  owner: string;
  repo: string;
  branch?: string;
  token?: string;
  paths?: string[];
  maxFiles?: number;  // Allow override
  ingestion_profile?: "auto" | "repo";
  strategy_override?: "fixed" | "recursive" | "semantic" | "hierarchical" | "adaptive";
  profile_config?: Record<string, any>;
}

interface SyncProgress {
  stage: 'fetching_tree' | 'filtering' | 'fetching_content' | 'ingesting';
  current: number;
  total: number;
  message: string;
}

async function fetchGitHubHeadFreshness(
  owner: string,
  repo: string,
  branch: string,
  headers: Record<string, string>
): Promise<{ commit?: string; commit_timestamp?: string }> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      { headers }
    );
    if (!res.ok) return {};
    const data = await res.json() as any;
    return {
      commit: data?.sha || undefined,
      commit_timestamp:
        data?.commit?.committer?.date ||
        data?.commit?.author?.date ||
        undefined,
    };
  } catch {
    return {};
  }
}

export async function syncGitHub(
  sourceId: string,
  projectId: string,
  config: GitHubConfig,
  onProgress?: (progress: SyncProgress) => void,
  signal?: AbortSignal
) {
  const { owner, repo, branch = "main", token, paths, maxFiles = MAX_TOTAL_FILES } = config;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "whisper-context",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const headFreshness = await fetchGitHubHeadFreshness(owner, repo, branch, headers);

  console.log(`[GitHub] Fetching repository tree for ${owner}/${repo} (${branch})`);
  
  onProgress?.({
    stage: 'fetching_tree',
    current: 0,
    total: 0,
    message: 'Fetching repository tree...'
  });

  // Check for abort
  if (signal?.aborted) throw new Error('SYNC_ABORTED');

  // Get the tree recursively
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers }
  );

  if (!treeRes.ok) {
    const errorText = await treeRes.text();
    throw new Error(`GitHub API error: ${treeRes.status} ${treeRes.statusText} - ${errorText}`);
  }

  const tree = await treeRes.json();
  console.log(`[GitHub] Repository tree contains ${tree.tree?.length || 0} items`);

  // Filter to scannable files
  let files = (tree.tree as any[]).filter((f: any) => {
    if (f.type !== "blob") return false;
    if (f.size > MAX_FILE_SIZE) return false;
    if (!hasScannableExtension(f.path || "")) return false;
    if (paths && paths.length > 0) {
      return paths.some((p) => f.path.startsWith(p));
    }
    return true;
  });

  // Limit total files
  const totalFiles = Math.min(files.length, maxFiles);
  if (files.length > maxFiles) {
    console.log(`[GitHub] Limiting to ${maxFiles} files (from ${files.length})`);
    files = files.slice(0, maxFiles);
  }

  console.log(`[GitHub] Files to index: ${files.length}`);
  
  onProgress?.({
    stage: 'filtering',
    current: files.length,
    total: tree.tree?.length || 0,
    message: `Filtered to ${files.length} scannable files`
  });

  // Fetch and ingest in streaming batches with pipelining:
  // while ingesting batch N, fetch batch N+1 in parallel.
  let totalIndexed = 0;
  let processedCount = 0;
  const errors: string[] = [];

  const fetchBatchInputs = async (batch: any[]): Promise<IngestDocumentInput[]> => {
    const batchInputs: IngestDocumentInput[] = [];
    for (let j = 0; j < batch.length; j += MAX_CONCURRENT_FETCHES) {
      const chunk = batch.slice(j, j + MAX_CONCURRENT_FETCHES);
      const contents = await Promise.all(
        chunk.map(async (f: any) => {
          try {
            const res = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/git/blobs/${f.sha}`,
              { headers }
            );
            if (!res.ok) {
              errors.push(`Failed to fetch ${f.path}: ${res.status}`);
              return null;
            }
            const data = await res.json();
            if (!data.content) return null;
            const content = Buffer.from(data.content, "base64").toString("utf-8");
            return { path: f.path, content };
          } catch (err: any) {
            errors.push(`Error fetching ${f.path}: ${err.message}`);
            return null;
          }
        })
      );
      for (const file of contents) {
        if (!file) continue;
        batchInputs.push({
          sourceId,
          projectId,
          externalId: file.path,
          title: file.path.split("/").pop() || file.path,
          content: file.content,
          filePath: file.path,
          metadata: {
            repo: `${owner}/${repo}`,
            branch,
            source_type: "repo",
            ...(headFreshness.commit ? { commit: headFreshness.commit } : {}),
            ...(headFreshness.commit_timestamp ? { commit_timestamp: headFreshness.commit_timestamp } : {}),
          },
          sourceType: "repo",
          ingestionProfile: config.ingestion_profile || "repo",
          strategyOverride: config.strategy_override,
          profileConfig: config.profile_config,
          skipSourceCountUpdate: true,
        });
      }
      processedCount += chunk.length;
    }
    return batchInputs;
  };

  const batches: any[][] = [];
  for (let i = 0; i < files.length; i += BATCH_INGEST_SIZE) {
    batches.push(files.slice(i, Math.min(i + BATCH_INGEST_SIZE, files.length)));
  }

  // Pipeline: fetch batch[i+1] while ingesting batch[i]
  let pendingIngest: Promise<void> = Promise.resolve();
  let prefetchPromise: Promise<IngestDocumentInput[]> | null = batches.length > 0
    ? fetchBatchInputs(batches[0])
    : null;

  for (let i = 0; i < batches.length; i++) {
    if (signal?.aborted) throw new Error('SYNC_ABORTED');

    onProgress?.({
      stage: 'fetching_content',
      current: processedCount,
      total: totalFiles,
      message: `Fetching batch ${i + 1}/${batches.length}...`,
    });

    // Await current batch fetch and start next fetch in parallel
    const batchInputs = await prefetchPromise!;
    prefetchPromise = i + 1 < batches.length ? fetchBatchInputs(batches[i + 1]) : null;

    onProgress?.({
      stage: 'ingesting',
      current: processedCount,
      total: totalFiles,
      message: `Ingesting batch ${i + 1} (${batchInputs.length} files)...`,
    });

    // Wait for previous ingest to finish, then start this one
    await pendingIngest;
    if (batchInputs.length > 0) {
      pendingIngest = ingestDocuments(batchInputs).then(() => {
        totalIndexed += batchInputs.length;
        console.log(`[GitHub] Ingested batch: ${totalIndexed}/${totalFiles} files`);
      });
    }
  }
  await pendingIngest;

  console.log(`[GitHub] Total ingested: ${totalIndexed} files`);

  if (totalIndexed > 0) {
    // Update source counts once for the entire sync (not once per batch)
    await finalizeSourceCounts(sourceId);
  }

  if (totalIndexed > 0) {
    generateSourceProfile(sourceId, projectId, {
      sourceType: "github",
      rootUrl: `https://github.com/${owner}/${repo}`,
    }).catch((err) => {
      console.warn("[GitHub] Source profile generation failed (non-critical):", err?.message ?? err);
    });
  }

  return {
    filesIndexed: totalIndexed,
    totalFiles: files.length,
    errors: errors.slice(0, 20),
    truncated: errors.length > 20
  };
}
