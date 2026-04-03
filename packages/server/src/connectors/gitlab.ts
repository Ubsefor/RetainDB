import { ingestDocuments, type IngestDocumentInput } from "../engine/ingest.js";

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
const MAX_TOTAL_FILES = 5000;
const FETCH_CONCURRENCY = 8;
const INGEST_BATCH_SIZE = 50;

interface GitLabConfig {
  host?: string;
  projectPath: string;
  branch?: string;
  token?: string;
  paths?: string[];
  maxFiles?: number;
}

interface GitLabProgress {
  stage: "fetching_tree" | "fetching_content" | "ingesting" | "done";
  current: number;
  total: number;
  message: string;
}

function hasScannableExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const ext of SCANNABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

async function fetchRepositoryTree(
  baseUrl: string,
  encodedPath: string,
  branch: string,
  headers: Record<string, string>,
  signal?: AbortSignal
) {
  const tree: any[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    if (signal?.aborted) throw new Error("SYNC_ABORTED");
    const res = await fetch(
      `${baseUrl}/projects/${encodedPath}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=${perPage}&page=${page}`,
      { headers }
    );

    if (!res.ok) {
      throw new Error(`GitLab API error: ${res.status} ${res.statusText}`);
    }

    const pageItems: any[] = await res.json();
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    tree.push(...pageItems);

    const nextPage = res.headers.get("x-next-page");
    if (!nextPage || nextPage === "0") break;
    const parsed = Number(nextPage);
    if (!Number.isFinite(parsed) || parsed <= 0) break;
    page = parsed;
  }

  return tree;
}

export async function syncGitLab(
  sourceId: string,
  projectId: string,
  config: GitLabConfig,
  onProgress?: (progress: GitLabProgress) => void,
  signal?: AbortSignal
) {
  const { host = "gitlab.com", projectPath, branch = "main", token, paths, maxFiles = MAX_TOTAL_FILES } = config;

  if (!token) {
    throw new Error("GitLab requires 'token' in config. Get a personal access token from GitLab settings.");
  }

  const encodedPath = encodeURIComponent(projectPath);
  const baseUrl = `https://${host}/api/v4`;
  const headers: Record<string, string> = {
    "PRIVATE-TOKEN": token,
  };

  onProgress?.({
    stage: "fetching_tree",
    current: 0,
    total: 0,
    message: "Fetching GitLab repository tree...",
  });

  const tree = await fetchRepositoryTree(baseUrl, encodedPath, branch, headers, signal);

  let files = tree.filter((f) => {
    if (f.type !== "blob") return false;
    if (typeof f.size === "number" && f.size > MAX_FILE_SIZE) return false;
    if (!hasScannableExtension(f.path || "")) return false;
    if (paths?.length) return paths.some((p) => String(f.path || "").startsWith(p));
    return true;
  });

  if (files.length > maxFiles) {
    files = files.slice(0, maxFiles);
  }

  const totalFiles = files.length;
  const errors: string[] = [];
  let indexed = 0;
  let processed = 0;

  for (let i = 0; i < files.length; i += INGEST_BATCH_SIZE) {
    if (signal?.aborted) throw new Error("SYNC_ABORTED");

    const batch = files.slice(i, i + INGEST_BATCH_SIZE);
    const inputs: IngestDocumentInput[] = [];

    onProgress?.({
      stage: "fetching_content",
      current: processed,
      total: totalFiles,
      message: `Fetching files ${i + 1}-${Math.min(i + INGEST_BATCH_SIZE, totalFiles)} of ${totalFiles}...`,
    });

    for (let j = 0; j < batch.length; j += FETCH_CONCURRENCY) {
      const fetchBatch = batch.slice(j, j + FETCH_CONCURRENCY);
      const contents = await Promise.all(
        fetchBatch.map(async (f) => {
          if (signal?.aborted) throw new Error("SYNC_ABORTED");
          try {
            const encodedFile = encodeURIComponent(f.path);
            const res = await fetch(
              `${baseUrl}/projects/${encodedPath}/repository/files/${encodedFile}/raw?ref=${encodeURIComponent(branch)}`,
              { headers }
            );
            if (!res.ok) {
              errors.push(`Failed ${f.path}: ${res.status}`);
              return null;
            }
            const content = await res.text();
            if (content.length > MAX_FILE_SIZE) return null;
            return { path: f.path, content };
          } catch (error: any) {
            errors.push(`Error ${f.path}: ${error?.message || "unknown error"}`);
            return null;
          }
        })
      );

      for (const file of contents) {
        if (!file) continue;
        inputs.push({
          sourceId,
          projectId,
          externalId: file.path,
          title: file.path.split("/").pop() || file.path,
          content: file.content,
          filePath: file.path,
          metadata: { projectPath, branch, filePath: file.path, source: "gitlab" },
        });
      }

      processed += fetchBatch.length;
    }

    onProgress?.({
      stage: "ingesting",
      current: processed,
      total: totalFiles,
      message: `Ingesting ${inputs.length} files from current batch...`,
    });

    if (inputs.length > 0) {
      await ingestDocuments(inputs);
      indexed += inputs.length;
    }
  }

  onProgress?.({
    stage: "done",
    current: indexed,
    total: totalFiles,
    message: `Indexed ${indexed} files`,
  });

  return {
    filesIndexed: indexed,
    totalFiles,
    errors: errors.slice(0, 20),
    truncated: errors.length > 20,
  };
}

