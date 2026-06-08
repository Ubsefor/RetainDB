import type { ConnectorProvider } from "./types.js";
import { fetchWithRetry } from "./fetch.js";

interface GitHubConfig {
  owner: string;
  repo: string;
  branch?: string;
  token?: string;
  paths?: string[];
  maxFiles?: number;
  maxBytesPerFile?: number;
}

const SCANNABLE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".java", ".go", ".rb", ".php", ".cs",
  ".rs", ".swift", ".kt", ".scala", ".c", ".cpp", ".h", ".hpp",
  ".md", ".mdx", ".rst", ".txt",
  ".json", ".yaml", ".yml", ".toml",
  ".sql", ".graphql", ".sol",
]);

function hasScannable(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of SCANNABLE) if (lower.endsWith(ext)) return true;
  return false;
}

function asGhConfig(input: Record<string, unknown>): GitHubConfig {
  return {
    owner: String(input.owner || "").trim(),
    repo: String(input.repo || "").trim(),
    branch: typeof input.branch === "string" ? input.branch : undefined,
    token: typeof input.token === "string" ? input.token : undefined,
    paths: Array.isArray(input.paths) ? input.paths.map(String) : undefined,
    maxFiles: typeof input.maxFiles === "number" ? input.maxFiles : 200,
    maxBytesPerFile: typeof input.maxBytesPerFile === "number" ? input.maxBytesPerFile : 400_000,
  };
}

async function ghJson<T>(path: string, token?: string): Promise<T> {
  const res = await fetchWithRetry(`https://api.github.com${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 403 || res.status === 429) {
    const rem = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(`GitHub API rate-limited (remaining=${rem}, reset=${reset}). Provide a token to raise the limit.`);
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}`);
  return (await res.json()) as T;
}

interface TreeEntry { path: string; type: string; sha: string; size?: number }

export const githubConnector: ConnectorProvider = {
  type: "github",
  requiresAuth: false,
  describe: () => "Index a public GitHub repository (tree of scannable files). Token optional but raises rate limit.",
  schema: () => ({
    type: "github",
    requiresAuth: false,
    summary: "Index a public GitHub repository (tree of scannable files). Token optional but raises rate limit.",
    positionalHint: "<owner>/<repo>",
    fields: [
      { name: "owner", required: true, type: "string", description: "Repository owner (user or org).", positional: "owner" },
      { name: "repo", required: true, type: "string", description: "Repository name.", positional: "repo" },
      { name: "branch", required: false, type: "string", description: "Branch name (defaults to the repo's default branch).", cliFlag: "branch" },
      { name: "token", required: false, type: "string", description: "GitHub PAT (raises rate limit; required for private repos).", cliFlag: "token", secret: true },
      { name: "paths", required: false, type: "string[]", description: "Optional path prefixes to include (comma-separated).", cliFlag: "paths" },
      { name: "maxFiles", required: false, type: "number", description: "Cap on scannable files to index.", default: 200, cliFlag: "max-files" },
      { name: "maxBytesPerFile", required: false, type: "number", description: "Per-file truncation size in bytes.", default: 400000, cliFlag: "max-bytes-per-file" },
    ],
    example: { owner: "tj", repo: "n", maxFiles: 20 },
  }),
  validateConfig(config) {
    const c = asGhConfig(config);
    if (!c.owner || !c.repo) return { ok: false, error: "config.owner and config.repo are required" };
    return { ok: true };
  },
  async sync({ source, signal, onProgress }) {
    const cfg = asGhConfig(source.config);
    const headers = cfg.token ? { Authorization: `Bearer ${cfg.token}` } : undefined;
    onProgress?.({ stage: "fetching", current: 0, total: 0, message: `Resolving ${cfg.owner}/${cfg.repo}` });
    const repo = await ghJson<{ default_branch: string; full_name: string; description: string | null }>(
      `/repos/${cfg.owner}/${cfg.repo}`,
      cfg.token
    );
    const branch = cfg.branch || repo.default_branch;
    onProgress?.({ stage: "fetching", current: 0, total: 0, message: `Loading tree at ${branch}` });
    const treeRes = await ghJson<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      cfg.token
    );
    let candidates = (treeRes.tree || []).filter((e) => e.type === "blob" && hasScannable(e.path));
    if (cfg.paths?.length) {
      const allow = cfg.paths.map((p) => p.replace(/^\/+/, ""));
      candidates = candidates.filter((e) => allow.some((p) => e.path === p || e.path.startsWith(p + "/")));
    }
    if (treeRes.truncated) {
      // huge tree: just take the first N scannable files
    }
    candidates = candidates.slice(0, cfg.maxFiles!);
    onProgress?.({ stage: "fetching", current: 0, total: candidates.length, message: `Found ${candidates.length} scannable files` });

    const docs = [];
    for (let i = 0; i < candidates.length; i++) {
      if (signal?.aborted) throw new Error("SYNC_ABORTED");
      const e = candidates[i];
      onProgress?.({ stage: "extracting", current: i + 1, total: candidates.length, message: e.path });
      try {
        const res = await fetchWithRetry(
          `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${encodeURIComponent(branch)}/${e.path}`,
          { headers, timeoutMs: 15000 }
        );
        if (!res.ok) continue;
        let text = await res.text();
        if (text.length > cfg.maxBytesPerFile!) text = text.slice(0, cfg.maxBytesPerFile!) + "\n…(truncated)";
        docs.push({
          external_id: `github:${cfg.owner}/${cfg.repo}@${branch}:${e.path}`,
          title: `${cfg.owner}/${cfg.repo}/${e.path}`,
          content: text,
          source_type: "github" as const,
          metadata: { owner: cfg.owner, repo: cfg.repo, branch, path: e.path, sha: e.sha, size: e.size },
        });
      } catch {
        // skip individual file failures
      }
    }
    onProgress?.({ stage: "done", current: docs.length, total: docs.length, message: `Indexed ${docs.length} files from ${cfg.owner}/${cfg.repo}` });
    return docs;
  },
};
