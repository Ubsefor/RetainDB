import { registerConnector } from "./types.js";
import { webConnector } from "./web.js";
import { urlConnector } from "./url.js";
import { sitemapConnector } from "./sitemap.js";
import { githubConnector } from "./github.js";
import { slackConnector } from "./slack.js";
import { notionConnector } from "./notion.js";
import { confluenceConnector } from "./confluence.js";

let registered = false;

export function ensureConnectorsRegistered(): void {
  if (registered) return;
  registered = true;
  registerConnector(webConnector);
  registerConnector(urlConnector);
  registerConnector(sitemapConnector);
  registerConnector(githubConnector);
  registerConnector(slackConnector);
  registerConnector(notionConnector);
  registerConnector(confluenceConnector);
}
