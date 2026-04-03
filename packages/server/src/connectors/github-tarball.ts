import { extract } from 'tar';
import { createReadStream, createWriteStream, statSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'fs';
import { generateSourceProfile } from '../engine/source-extraction.js';

const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rb", ".php", ".cs",
  ".rs", ".swift", ".kt", ".scala", ".c", ".cpp", ".h", ".hpp",
  ".md", ".mdx", ".rst", ".txt",
  ".json", ".yaml", ".yml", ".toml",
  ".sql", ".prisma", ".graphql",
  ".sol", ".vy",
  ".dockerfile", ".env.example",
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', '__pycache__',
  '.pytest_cache', 'vendor', 'target', 'bin', 'obj', '.idea', '.vscode',
  'coverage', '.nyc_output', '.cache', 'tmp', 'temp',
]);

const MAX_FILE_SIZE = 500_000;
const MAX_TOTAL_FILES = 5000;

function hasScannableExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const ext of SCANNABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

interface TarballConfig {
  owner: string;
  repo: string;
  branch?: string;
  token?: string;
}

interface TarballProgress {
  stage: 'downloading' | 'extracting' | 'indexing' | 'done';
  current: number;
  total: number;
  message: string;
}

export async function syncGitHubTarball(
  sourceId: string,
  projectId: string,
  config: TarballConfig,
  onProgress?: (progress: TarballProgress) => void,
  signal?: AbortSignal
): Promise<{ indexed: number; errors: string[] }> {
  const { owner, repo, branch = 'main', token } = config;
  
  const tmpDir = join(tmpdir(), `whisper-github-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  
  const errors: string[] = [];
  let indexed = 0;
  
  try {
    onProgress?.({
      stage: 'downloading',
      current: 0,
      total: 100,
      message: `Downloading ${owner}/${repo} tarball...`
    });

    if (signal?.aborted) throw new Error('SYNC_ABORTED');

    // Download tarball
    const tarballUrl = token 
      ? `https://${token}@github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`
      : `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`;
    
    const tarballPath = join(tmpDir, 'repo.tar.gz');
    
    const response = await fetch(tarballUrl);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }
    
    // Write tarball to file
    const stream = createWriteStream(tarballPath);
    await pipeline(Readable.fromWeb(response.body as any), stream);
    
    onProgress?.({
      stage: 'extracting',
      current: 50,
      total: 100,
      message: 'Extracting files...'
    });

    if (signal?.aborted) throw new Error('SYNC_ABORTED');

    // Extract tarball
    const extractDir = join(tmpDir, 'repo');
    mkdirSync(extractDir, { recursive: true });
    
    await pipeline(
      createReadStream(tarballPath),
      createGunzip(),
      extract({ cwd: extractDir })
    );
    
    // Find the repo root (tarball extracts to repo-branch/)
    const entries = readdirSync(extractDir);
    const repoRoot = join(extractDir, entries[0]);
    
    // Collect all files
    const files: { path: string; content: string }[] = [];
    
    function walkDir(dir: string, basePath: string = '') {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
        
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            walkDir(fullPath, relativePath);
          }
        } else if (entry.isFile()) {
          // Check extension
          if (!hasScannableExtension(relativePath)) continue;
          
          // Check size
          const stat = statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) {
            errors.push(`Skipping ${relativePath}: too large (${stat.size} bytes)`);
            return;
          }
          
          try {
            const content = readFileSync(fullPath, 'utf-8');
            files.push({ path: relativePath, content });
          } catch (e: any) {
            errors.push(`Error reading ${relativePath}: ${e.message}`);
          }
        }
      }
    }
    
    walkDir(repoRoot);
    
    // Limit files
    if (files.length > MAX_TOTAL_FILES) {
      errors.push(`Limiting to ${MAX_TOTAL_FILES} files (found ${files.length})`);
      files.length = MAX_TOTAL_FILES;
    }
    
    onProgress?.({
      stage: 'indexing',
      current: 0,
      total: files.length,
      message: `Indexing ${files.length} files...`
    });

    if (signal?.aborted) throw new Error('SYNC_ABORTED');

    // Import and use existing ingest
    const { ingestDocuments } = await import('../engine/ingest.js');
    
    // Ingest in batches
    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      if (signal?.aborted) throw new Error('SYNC_ABORTED');
      
      const batch = files.slice(i, i + BATCH_SIZE);
      
      await ingestDocuments(batch.map(f => ({
        sourceId,
        projectId,
        externalId: f.path,
        title: f.path.split('/').pop() || f.path,
        content: f.content,
        filePath: f.path,
        metadata: { repo: `${owner}/${repo}`, branch, source: 'tarball' }
      })));
      
      indexed += batch.length;
      
      onProgress?.({
        stage: 'indexing',
        current: i + batch.length,
        total: files.length,
        message: `Indexed ${i + batch.length}/${files.length} files`
      });
    }
    
    onProgress?.({
      stage: 'done',
      current: files.length,
      total: files.length,
      message: `Done! Indexed ${indexed} files`
    });

    if (indexed > 0) {
      generateSourceProfile(sourceId, projectId, {
        sourceType: "github",
        rootUrl: `https://github.com/${owner}/${repo}`,
      }).catch(() => {});
    }

    return { indexed, errors };
    
  } finally {
    // Cleanup
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}
