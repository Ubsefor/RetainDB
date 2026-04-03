import { ingestDocuments, IngestDocumentInput } from "../engine/ingest.js";

interface HuggingFaceConfig {
  repoId: string; // e.g. "facebook/opt-1.3b" or "datasets/squad"
  repoType?: "model" | "dataset" | "space";
  branch?: string;
  token?: string;
  paths?: string[]; // optional path filters
  includeModelCard?: boolean;
  includeConfig?: boolean;
}

const SCANNABLE_EXTENSIONS = new Set([
  ".py", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".cfg", ".ini",
  ".rst", ".ipynb", ".sh", ".dockerfile",
  ".ts", ".js", ".jsx", ".tsx",
]);

const MAX_FILE_SIZE = 500_000; // 500KB

export async function syncHuggingFace(
  sourceId: string,
  projectId: string,
  config: HuggingFaceConfig
) {
  const {
    repoId,
    repoType = "model",
    branch = "main",
    token,
    paths,
    includeModelCard = true,
    includeConfig = true,
  } = config;

  const headers: Record<string, string> = {
    "User-Agent": "whisper-context",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (process.env.HUGGINGFACE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.HUGGINGFACE_TOKEN}`;
  }

  const apiBase = "https://huggingface.co/api";
  const inputs: IngestDocumentInput[] = [];

  const repoUrl =
    repoType === "model"
      ? `${apiBase}/models/${repoId}`
      : repoType === "dataset"
        ? `${apiBase}/datasets/${repoId}`
        : `${apiBase}/spaces/${repoId}`;

  const repoRes = await fetch(repoUrl, { headers });
  if (!repoRes.ok) {
    throw new Error(`HuggingFace API error: ${repoRes.status} ${repoRes.statusText}. For private repos, provide 'token' in config.`);
  }

  const repoMeta = await repoRes.json() as Record<string, any>;

  // 2. Index model/dataset card (README.md) if available
  if (includeModelCard) {
    const cardContent = await fetchFileContent(repoId, repoType, "README.md", branch, headers);
    if (cardContent) {
      inputs.push({
        sourceId,
        projectId,
        externalId: `${repoId}/README.md`,
        title: `${repoId} - Model Card`,
        content: cardContent,
        filePath: "README.md",
        metadata: {
          repoId,
          repoType,
          branch,
          fileType: "model_card",
          ...(repoMeta.tags ? { tags: repoMeta.tags } : {}),
          ...(repoMeta.pipeline_tag ? { pipelineTag: repoMeta.pipeline_tag } : {}),
          ...(repoMeta.library_name ? { library: repoMeta.library_name } : {}),
        },
      });
    }
  }

  // 3. Index config files
  if (includeConfig) {
    const configFiles = ["config.json", "tokenizer_config.json", "dataset_infos.json"];
    for (const configFile of configFiles) {
      const content = await fetchFileContent(repoId, repoType, configFile, branch, headers);
      if (content) {
        inputs.push({
          sourceId,
          projectId,
          externalId: `${repoId}/${configFile}`,
          title: `${repoId} - ${configFile}`,
          content: formatJsonContent(content, configFile),
          filePath: configFile,
          metadata: { repoId, repoType, branch, fileType: "config" },
        });
      }
    }
  }

  // 4. List repo files and index code/docs
  const filesUrl =
    repoType === "model"
      ? `${apiBase}/models/${repoId}/tree/${branch}`
      : repoType === "dataset"
        ? `${apiBase}/datasets/${repoId}/tree/${branch}`
        : `${apiBase}/spaces/${repoId}/tree/${branch}`;

  const allFiles = await fetchAllFiles(filesUrl, headers, repoId, repoType, branch);

  const scannableFiles = allFiles.filter((f) => {
    if (f.type !== "file") return false;
    if (f.size > MAX_FILE_SIZE) return false;
    const ext = "." + f.path.split(".").pop()?.toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(ext)) return false;
    // Skip README (already indexed) and config files (already indexed)
    if (f.path === "README.md") return false;
    if (includeConfig && ["config.json", "tokenizer_config.json", "dataset_infos.json"].includes(f.path)) return false;
    if (paths && paths.length > 0) {
      return paths.some((p) => f.path.startsWith(p));
    }
    return true;
  });

  // Fetch in batches of 10
  const batchSize = 10;
  for (let i = 0; i < scannableFiles.length; i += batchSize) {
    const batch = scannableFiles.slice(i, i + batchSize);

    const contents = await Promise.all(
      batch.map(async (f) => {
        const content = await fetchFileContent(repoId, repoType, f.path, branch, headers);
        return content ? { path: f.path, content } : null;
      })
    );

    for (const file of contents) {
      if (!file) continue;
      inputs.push({
        sourceId,
        projectId,
        externalId: `${repoId}/${file.path}`,
        title: file.path.split("/").pop() || file.path,
        content: file.content,
        filePath: file.path,
        metadata: {
          repoId,
          repoType,
          branch,
          filePath: file.path,
        },
      });
    }
  }

  // 5. Index repo overview as a summary document
  const overview = buildRepoOverview(repoMeta, repoType, scannableFiles.length);
  inputs.push({
    sourceId,
    projectId,
    externalId: `${repoId}/_overview`,
    title: `${repoId} - Overview`,
    content: overview,
    metadata: {
      repoId,
      repoType,
      fileType: "overview",
      downloads: repoMeta.downloads,
      likes: repoMeta.likes,
    },
  });

  await ingestDocuments(inputs);

  return { filesIndexed: inputs.length, totalFiles: scannableFiles.length };
}

// ─── Helpers ──────────────────────────────────────────────────

interface RepoFile {
  type: string;
  path: string;
  size: number;
}

async function fetchAllFiles(
  url: string,
  headers: Record<string, string>,
  repoId: string,
  repoType: string,
  branch: string
): Promise<RepoFile[]> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];

    const items = (await res.json()) as RepoFile[];
    const files: RepoFile[] = [];

    for (const item of items) {
      if (item.type === "file") {
        files.push(item);
      } else if (item.type === "directory") {
        // Recursively fetch subdirectories
        const apiBase = "https://huggingface.co/api";
        const subUrl =
          repoType === "model"
            ? `${apiBase}/models/${repoId}/tree/${branch}/${item.path}`
            : repoType === "dataset"
              ? `${apiBase}/datasets/${repoId}/tree/${branch}/${item.path}`
              : `${apiBase}/spaces/${repoId}/tree/${branch}/${item.path}`;

        const subFiles = await fetchAllFiles(subUrl, headers, repoId, repoType, branch);
        files.push(...subFiles);
      }
    }

    return files;
  } catch {
    return [];
  }
}

async function fetchFileContent(
  repoId: string,
  repoType: string,
  path: string,
  branch: string,
  headers: Record<string, string>
): Promise<string | null> {
  try {
    const prefix =
      repoType === "model"
        ? ""
        : repoType === "dataset"
          ? "datasets/"
          : "spaces/";

    const url = `https://huggingface.co/${prefix}${repoId}/raw/${branch}/${path}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;

    const text = await res.text();
    if (text.length > MAX_FILE_SIZE) return text.slice(0, MAX_FILE_SIZE);
    return text;
  } catch {
    return null;
  }
}

function formatJsonContent(content: string, filename: string): string {
  try {
    const parsed = JSON.parse(content);
    const formatted = JSON.stringify(parsed, null, 2);
    return `# ${filename}\n\n\`\`\`json\n${formatted.slice(0, 50_000)}\n\`\`\``;
  } catch {
    return content;
  }
}

function buildRepoOverview(meta: Record<string, any>, repoType: string, fileCount: number): string {
  const lines: string[] = [];
  lines.push(`# ${meta.id || meta.modelId || "Unknown"}`);
  lines.push("");

  if (meta.pipeline_tag) lines.push(`**Pipeline:** ${meta.pipeline_tag}`);
  if (meta.library_name) lines.push(`**Library:** ${meta.library_name}`);
  if (meta.language) lines.push(`**Language:** ${Array.isArray(meta.language) ? meta.language.join(", ") : meta.language}`);
  if (meta.license) lines.push(`**License:** ${meta.license}`);
  if (meta.downloads !== undefined) lines.push(`**Downloads:** ${meta.downloads.toLocaleString()}`);
  if (meta.likes !== undefined) lines.push(`**Likes:** ${meta.likes}`);
  if (meta.tags) lines.push(`**Tags:** ${meta.tags.join(", ")}`);

  lines.push(`**Type:** ${repoType}`);
  lines.push(`**Files indexed:** ${fileCount}`);

  if (meta.siblings) {
    lines.push("");
    lines.push("## File Structure");
    for (const f of meta.siblings.slice(0, 50)) {
      lines.push(`- ${f.rfilename}`);
    }
  }

  if (meta.cardData) {
    lines.push("");
    lines.push("## Card Metadata");
    lines.push("```yaml");
    lines.push(JSON.stringify(meta.cardData, null, 2));
    lines.push("```");
  }

  return lines.join("\n");
}
