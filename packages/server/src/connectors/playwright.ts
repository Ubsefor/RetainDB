/**
 * OSS Playwright connector shim.
 *
 * The cloud codebase used a browser-agent helper that is not part of the OSS
 * server package. For self-hosted builds, we degrade gracefully by routing the
 * "playwright" connector through the standard web crawler instead of failing
 * the entire server build.
 */
import { syncWeb } from "./web.js";

interface PlaywrightConfig {
  url: string;
  maxPages?: number;
  extractMode?: "text" | "structured" | "markdown";
  maxDepth?: number;
}

export async function syncPlaywright(
  sourceId: string,
  projectId: string,
  config: PlaywrightConfig,
) {
  const result = await syncWeb(sourceId, projectId, {
    url: config.url,
    maxPages: config.maxPages ?? 10,
    maxDepth: config.maxDepth ?? 1,
    followLinks: true,
  });

  return {
    documentsIndexed: result.pagesIndexed,
    pagesVisited: result.totalUrls,
    errors: [
      "Playwright browser rendering is not bundled in OSS; used the standard web crawler fallback.",
      ...result.errors,
    ].slice(0, 10),
    partialFailure: false,
  };
}
