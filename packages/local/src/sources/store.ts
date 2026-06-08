import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Source, SourceConfig, SourceType } from "./types.js";

function getStorePath(home: string): string {
  return join(home, "sources.json");
}

function load(home: string): Source[] {
  const path = getStorePath(home);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(home: string, sources: Source[]): void {
  const path = getStorePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(sources, null, 2), "utf8");
  renameSync(tmp, path);
}

export class SourceStore {
  constructor(private home: string) {}

  list(project?: string): Source[] {
    const all = load(this.home);
    return project ? all.filter((s) => s.project === project) : all;
  }

  get(id: string): Source | undefined {
    return load(this.home).find((s) => s.id === id);
  }

  create(input: {
    type: SourceType;
    name: string;
    project: string;
    config: SourceConfig;
  }): Source {
    const all = load(this.home);
    const now = new Date().toISOString();
    const source: Source = {
      id: `src_${randomUUID()}`,
      type: input.type,
      name: input.name,
      project: input.project,
      config: input.config,
      status: "connected",
      created_at: now,
      updated_at: now,
    };
    all.push(source);
    persist(this.home, all);
    return source;
  }

  update(id: string, patch: Partial<Source>): Source | undefined {
    const all = load(this.home);
    const idx = all.findIndex((s) => s.id === id);
    if (idx < 0) return undefined;
    all[idx] = { ...all[idx], ...patch, updated_at: new Date().toISOString() };
    persist(this.home, all);
    return all[idx];
  }

  delete(id: string): boolean {
    const all = load(this.home);
    const next = all.filter((s) => s.id !== id);
    if (next.length === all.length) return false;
    persist(this.home, next);
    return true;
  }
}
