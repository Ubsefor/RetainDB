import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { BrainFile } from "./types.js";

const BRAIN_ROOT = join(".retaindb", "files");
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next"]);

export function workspaceRoot(cwd?: string) {
  return resolve(cwd || process.env.RETAINDB_WORKSPACE || process.cwd());
}

export function brainRoot(cwd?: string) {
  return resolve(workspaceRoot(cwd), BRAIN_ROOT);
}

export function normalizeBrainPath(path = "/README.md") {
  const cleaned = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return cleaned || "README.md";
}

export function resolveBrainPath(cwd: string | undefined, path = "/README.md") {
  const root = brainRoot(cwd);
  const target = resolve(root, normalizeBrainPath(path));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error("Path escapes the RetainDB local filesystem root.");
  }
  return target;
}

export function toBrainPath(cwd: string | undefined, absolutePath: string) {
  return `/${relative(brainRoot(cwd), absolutePath).replace(/\\/g, "/")}`;
}

export function listBrainFiles(cwd?: string, includeContents = false, limit = 250): BrainFile[] {
  const root = brainRoot(cwd);
  if (!existsSync(root)) return [];
  const files: BrainFile[] = [];
  const walk = (dir: string) => {
    if (files.length >= limit) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(full);
      const path = toBrainPath(cwd, full);
      files.push({
        path,
        absolutePath: full,
        kind: kindForPath(path),
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        content: includeContents ? safeRead(full) : undefined,
      });
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function safeRead(path: string) {
  try {
    return statSync(path).size > 512_000 ? "[file too large]" : readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function kindForPath(path: string): BrainFile["kind"] {
  if (path === "/README.md") return "summary";
  if (path.startsWith("/memories/")) return "memory";
  if (path.startsWith("/sessions/")) return "session";
  if (path.startsWith("/agents/")) return "agent";
  if (path.startsWith("/handoffs/")) return "handoff";
  if (path.startsWith("/inbox/")) return "inbox";
  return "meta";
}
