import { CONTRACT_METADATA, CONTRACT_REGISTRY, CONTRACT_VERSION } from "./registry.mjs";

export { CONTRACT_METADATA, CONTRACT_REGISTRY, CONTRACT_VERSION };

export function getContractHeaders() {
  return {
    "X-Whisper-Contract-Version": CONTRACT_VERSION,
    "X-Whisper-Contract-Status": CONTRACT_METADATA.status,
    "X-Whisper-Deprecation-Window-Days": String(CONTRACT_METADATA.migration_window_days),
  };
}

export function getPublicContractMetadata() {
  const active_surfaces = Array.from(new Set(
    CONTRACT_REGISTRY.flatMap((entry) => [
      entry.surfaces?.http?.length ? "http" : null,
      entry.surfaces?.sdk?.length ? "sdk" : null,
      (entry.surfaces?.mcp_primary?.length || entry.surfaces?.mcp_compat?.length) ? "mcp" : null,
    ].filter(Boolean))
  ));

  const deprecated_routes = CONTRACT_REGISTRY.flatMap((entry) =>
    (entry.surfaces?.http || [])
      .filter((route) => route.status === "compat")
      .map((route) => ({
        method: route.method,
        route: route.route,
        replacement: route.replacement || null,
      }))
  );

  return {
    contract_version: CONTRACT_VERSION,
    status: CONTRACT_METADATA.status,
    active_surfaces,
    mcp_primary_verbs: CONTRACT_METADATA.mcp_primary_verbs,
    migration_window_days: CONTRACT_METADATA.migration_window_days,
    removal_policy: CONTRACT_METADATA.removal_policy,
    sdk_legacy: CONTRACT_METADATA.sdk_legacy,
    deprecated_routes,
  };
}
