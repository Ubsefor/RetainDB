#!/usr/bin/env node
import { capture, printContextPack } from "./_capture.mjs";

const BASE_URL = (process.env.RETAINDB_BASE_URL || "http://localhost:3111").replace(/\/+$/, "");

let input = "";
for await (const chunk of process.stdin) input += chunk;
let data = {};
try { data = input.trim() ? JSON.parse(input) : {}; } catch {}

try {
  const res = await fetch(`${BASE_URL}/retaindb/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: data.session_id || data.sessionId || process.env.RETAINDB_SESSION_ID,
      project: process.env.RETAINDB_PROJECT || data.cwd || data.project || "default",
      cwd: data.cwd || process.cwd(),
    }),
    signal: AbortSignal.timeout(1500),
  });
  if (process.env.RETAINDB_INJECT_CONTEXT === "true" && res.ok) {
    const body = await res.json();
    if (body.context) process.stdout.write(body.context);
  }
  await printContextPack(data, "session_start", "project decisions workflows open tasks relevant files");
} catch {
  await capture("session_start");
}
