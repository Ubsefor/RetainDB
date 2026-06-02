import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { brainRoot, listBrainFiles, normalizeBrainPath, resolveBrainPath, toBrainPath } from "./paths.js";
import { renderBrainFiles } from "./render.js";
import type { BrainFile, BrainWriteInput, LocalBrainSnapshot } from "./types.js";

export function syncBrainFilesystem(input: {
  cwd?: string;
  project?: string;
  snapshot: LocalBrainSnapshot;
}) {
  const root = brainRoot(input.cwd);
  mkdirSync(root, { recursive: true });
  const rendered = renderBrainFiles(input.snapshot, input.project || "default");
  for (const file of rendered) {
    const target = resolveBrainPath(input.cwd, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, ensureTrailingNewline(file.content), "utf8");
  }
  const manifest = {
    version: 1,
    project: input.project || "default",
    root,
    generatedAt: new Date().toISOString(),
    files: rendered.map((file) => file.path),
  };
  const manifestPath = resolveBrainPath(input.cwd, "/manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { root, manifest, files: listBrainFiles(input.cwd, false) };
}

export function readBrainFile(input: {
  cwd?: string;
  path?: string;
  includeContents?: boolean;
}): BrainFile {
  const path = input.path || "/README.md";
  const target = resolveBrainPath(input.cwd, path);
  if (!existsSync(target)) throw new Error(`Brain file not found: ${path}`);
  const stat = statSync(target);
  return {
    path: toBrainPath(input.cwd, target),
    absolutePath: target,
    kind: kindForPath(path),
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    content: input.includeContents === false ? undefined : readFileSync(target, "utf8"),
  };
}

export function writeAgentBrainFile(input: BrainWriteInput) {
  if (!input.content?.trim()) throw new Error("content is required");
  const agent = slugPart(input.agentId || "agent");
  const kind = input.kind || "note";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetPath = `/inbox/${stamp}-${agent}-${kind}.md`;
  const target = resolveBrainPath(input.cwd, targetPath);
  mkdirSync(dirname(target), { recursive: true });
  const content = renderAgentWrite(input, targetPath);
  writeFileSync(target, ensureTrailingNewline(content), "utf8");
  return {
    path: targetPath,
    absolutePath: target,
    content,
    memoryContent: renderMemoryFromWrite(input, targetPath),
  };
}

export function listBrainFileTree(cwd?: string, includeContents = false, limit = 250) {
  return {
    root: brainRoot(cwd),
    files: listBrainFiles(cwd, includeContents, limit),
  };
}

function renderAgentWrite(input: BrainWriteInput, path: string) {
  return [
    `# ${input.title || titleForKind(input.kind || "note")}`,
    "",
    `- path: ${path}`,
    `- kind: ${input.kind || "note"}`,
    `- project: ${input.project || "default"}`,
    `- from_agent: ${input.agentId || "agent"}`,
    input.toAgentId ? `- to_agent: ${input.toAgentId}` : "",
    input.sessionId ? `- session: ${input.sessionId}` : "",
    input.taskId ? `- task: ${input.taskId}` : "",
    input.files?.length ? `- files: ${input.files.join(", ")}` : "",
    `- created: ${new Date().toISOString()}`,
    "",
    input.content.trim(),
    "",
  ].filter(Boolean).join("\n");
}

function renderMemoryFromWrite(input: BrainWriteInput, path: string) {
  const target = input.toAgentId ? ` for ${input.toAgentId}` : "";
  return [
    `${input.kind || "note"}${target}: ${input.title || "Agent file note"}`,
    input.content.trim(),
    `Brain file: ${path}`,
    input.files?.length ? `Related files: ${input.files.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function titleForKind(kind: BrainWriteInput["kind"]) {
  if (kind === "handoff") return "Agent Handoff";
  if (kind === "decision") return "Decision";
  if (kind === "file_edit") return "File Edit";
  if (kind === "failure") return "Failure";
  if (kind === "task") return "Task Update";
  return "Agent Note";
}

function slugPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "agent";
}

function kindForPath(path: string): BrainFile["kind"] {
  const normalized = `/${normalizeBrainPath(path)}`;
  if (normalized === "/README.md") return "summary";
  if (normalized.startsWith("/memories/")) return "memory";
  if (normalized.startsWith("/sessions/")) return "session";
  if (normalized.startsWith("/agents/")) return "agent";
  if (normalized.startsWith("/handoffs/")) return "handoff";
  if (normalized.startsWith("/inbox/")) return "inbox";
  return "meta";
}

function ensureTrailingNewline(content: string) {
  return content.endsWith("\n") ? content : `${content}\n`;
}
