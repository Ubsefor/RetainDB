/**
 * URL connector — thin alias over syncWeb.
 * Kept for backwards compatibility; prefer using syncWeb directly.
 */
import { syncWeb, type WebConfig } from "./web.js";

export type UrlConfig = Omit<WebConfig, "useSitemap"> & { useSitemap?: boolean };

export async function syncUrl(
  sourceId: string,
  projectId: string,
  config: UrlConfig
): Promise<{ pagesIndexed: number; totalUrls?: number; errors?: string[] }> {
  return syncWeb(sourceId, projectId, { useSitemap: false, ...config });
}
