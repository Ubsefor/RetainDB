#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Target = "codex" | "claude-code" | "opencode" | "all";

const target = ((process.argv.find((arg) => arg.startsWith("--target=")) || "").split("=")[1] || "all") as Target;
const write = process.argv.includes("--write");
const baseUrl = process.env.RETAINDB_BASE_URL || "http://localhost:3000";
const project = process.env.RETAINDB_PROJECT || "default";

function mcpEnv() {
  return {
    RETAINDB_BASE_URL: baseUrl,
    RETAINDB_PROJECT: project,
  };
}

function codexConfig() {
  return [
    "[mcp_servers.retaindb]",
    'command = "npx"',
    'args = ["-y", "@retaindb/mcp"]',
    "",
    "[mcp_servers.retaindb.env]",
    `RETAINDB_BASE_URL = "${baseUrl}"`,
    `RETAINDB_PROJECT = "${project}"`,
  ].join("\n");
}

function claudeCodeConfig() {
  return JSON.stringify({
    mcpServers: {
      retaindb: {
        command: "npx",
        args: ["-y", "@retaindb/mcp"],
        env: mcpEnv(),
      },
    },
  }, null, 2);
}

function opencodeConfig() {
  return JSON.stringify({
    mcp: {
      retaindb: {
        type: "local",
        command: ["npx", "-y", "@retaindb/mcp"],
        env: mcpEnv(),
        enabled: true,
      },
    },
  }, null, 2);
}

function selectedTargets(): Exclude<Target, "all">[] {
  if (target === "all") return ["codex", "claude-code", "opencode"];
  if (["codex", "claude-code", "opencode"].includes(target)) return [target as Exclude<Target, "all">];
  throw new Error("Unknown --target. Use codex, claude-code, opencode, or all.");
}

function contentFor(item: Exclude<Target, "all">) {
  if (item === "codex") return codexConfig();
  if (item === "claude-code") return claudeCodeConfig();
  return opencodeConfig();
}

function destinationFor(item: Exclude<Target, "all">) {
  const ext = item === "codex" ? "toml" : "json";
  return join(process.cwd(), ".retaindb", "agent-bridge", `${item}.${ext}`);
}

try {
  const targets = selectedTargets();
  console.log("RetainDB Agent Memory Bridge setup");
  console.log(`Local server: ${baseUrl}`);
  console.log(`Project: ${project}`);
  console.log("");

  for (const item of targets) {
    const content = contentFor(item);
    if (write) {
      const dest = destinationFor(item);
      mkdirSync(join(process.cwd(), ".retaindb", "agent-bridge"), { recursive: true });
      writeFileSync(dest, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      console.log(`Wrote ${item} config snippet: ${dest}`);
      continue;
    }
    console.log(`--- ${item} ---`);
    console.log(content);
    console.log("");
  }

  if (!write) {
    console.log("Run with --write to save snippets under .retaindb/agent-bridge/.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
