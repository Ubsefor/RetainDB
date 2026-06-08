import type { IngestedDocument, Source, SourceConfig, SourceType, SyncProgress } from "../sources/types.js";

export interface ConnectorContext {
  source: Source;
  project: string;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
}

export type ConfigFieldType = "string" | "number" | "boolean" | "string[]";

export interface ConfigField {
  name: string;
  required: boolean;
  type: ConfigFieldType;
  description: string;
  default?: string | number | boolean;
  /** Marks the field as containing a credential; it is redacted in CLI output. */
  secret?: boolean;
  /** The CLI flag (e.g. "--max-files") this maps to under `retaindb add <type>`. */
  cliFlag?: string;
  /** If true, the value is supplied positionally (`add github owner/repo`).
   *  The fields marked positional are consumed in declaration order. */
  positional?: string;
  /** Optional list of allowed values. */
  choices?: string[];
}

export interface ConnectorSchema {
  type: SourceType;
  requiresAuth: boolean;
  summary: string;
  fields: ConfigField[];
  example: SourceConfig;
  /** Suggested CLI positional syntax, e.g. "[owner/repo]" or "<url>". */
  positionalHint?: string;
}

export interface ConnectorProvider {
  type: SourceType;
  requiresAuth: boolean;
  describe(): string;
  schema(): ConnectorSchema;
  validateConfig(config: SourceConfig): { ok: true } | { ok: false; error: string };
  sync(context: ConnectorContext): Promise<IngestedDocument[]>;
}

const registry = new Map<SourceType, ConnectorProvider>();

export function registerConnector(provider: ConnectorProvider): void {
  registry.set(provider.type, provider);
}

export function getConnector(type: SourceType): ConnectorProvider | undefined {
  return registry.get(type);
}

export function listConnectorTypes(): SourceType[] {
  return [...registry.keys()];
}

export function listConnectorDescriptors(): Array<{
  type: SourceType;
  requiresAuth: boolean;
  description: string;
}> {
  return [...registry.values()].map((p) => ({
    type: p.type,
    requiresAuth: p.requiresAuth,
    description: p.describe(),
  }));
}
