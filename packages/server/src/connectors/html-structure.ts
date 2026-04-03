import * as cheerio from "cheerio";

export interface SourceDesign {
  colors: string[];
  fonts: string[];
  themeColor: string;
  favicon: string;
}

export interface PageImage {
  src: string;
  alt: string;
  title?: string;
}

export interface StructuredHtmlResult {
  title: string;
  content: string;
  metadata: Record<string, any>;
  design: SourceDesign;
  images: PageImage[];
  structuredData: any[];
  navigation: string[];
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function emitNode($: cheerio.CheerioAPI, element: any, lines: string[], depth = 0) {
  if (element.type === "text") {
    const text = cleanText($(element).text());
    if (text) lines.push(text);
    return;
  }

  if (element.type !== "tag") return;
  const tag = element.tagName.toLowerCase();
  const node = $(element);

  if (tag.match(/^h[1-6]$/)) {
    const level = Number(tag[1]);
    const text = cleanText(node.text());
    if (text) lines.push(`${"#".repeat(level)} ${text}`);
    return;
  }

  if (tag === "pre") {
    const codeText = node.text().trim();
    if (codeText) lines.push(`\`\`\`\n${codeText}\n\`\`\``);
    return;
  }

  if (tag === "code") {
    const codeText = cleanText(node.text());
    if (codeText) lines.push(`\`${codeText}\``);
    return;
  }

  if (tag === "table") {
    const rows = node.find("tr").toArray().map((row) => {
      const cells = $(row).find("th,td").toArray().map((cell) => cleanText($(cell).text())).filter(Boolean);
      return cells.length > 0 ? `| ${cells.join(" | ")} |` : "";
    }).filter(Boolean);
    if (rows.length > 0) lines.push(rows.join("\n"));
    return;
  }

  if (tag === "ul" || tag === "ol") {
    const items = node.children("li").toArray().map((child) => cleanText($(child).text())).filter(Boolean);
    if (items.length > 0) {
      lines.push(items.map((item) => `- ${item}`).join("\n"));
    }
    return;
  }

  if (tag === "img") {
    const alt = cleanText(node.attr("alt") || "");
    const src = node.attr("src") || "";
    if (alt) lines.push(`[Image: ${alt}]`);
    return;
  }

  if (tag === "p" || tag === "blockquote") {
    const text = cleanText(node.text());
    if (text) lines.push(text);
    return;
  }

  const children = node.contents().toArray();
  if (children.length === 0 && depth < 3) {
    const text = cleanText(node.text());
    if (text) lines.push(text);
    return;
  }

  for (const child of children) {
    emitNode($, child, lines, depth + 1);
  }
}

// Extract hex colors, rgb/hsl from raw CSS text
function extractColorsFromCss(css: string): string[] {
  const colors = new Set<string>();

  // Hex colors
  const hexMatches = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  for (const c of hexMatches) {
    const lower = c.toLowerCase();
    // Skip pure white/black and very light grays (typically not brand colors)
    if (!["#fff", "#ffffff", "#000", "#000000", "#fafafa", "#f9f9f9", "#f5f5f5", "#ebebeb", "#e5e5e5"].includes(lower)) {
      colors.add(lower);
    }
  }

  // rgb/rgba colors
  const rgbMatches = css.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g) || [];
  for (const c of rgbMatches) {
    const normalized = c.replace(/\s+/g, "").toLowerCase();
    if (!["rgb(255,255,255)", "rgb(0,0,0)", "rgba(0,0,0,0)", "rgba(255,255,255,0)"].includes(normalized)) {
      colors.add(normalized);
    }
  }

  // hsl/hsla
  const hslMatches = css.match(/hsla?\([^)]+\)/g) || [];
  for (const c of hslMatches) {
    colors.add(c.replace(/\s+/g, "").toLowerCase());
  }

  return [...colors].slice(0, 20);
}

function extractFontsFromCss(css: string): string[] {
  const fonts = new Set<string>();
  const genericFamilies = new Set([
    "inherit", "initial", "unset", "revert",
    "sans-serif", "serif", "monospace", "cursive", "fantasy",
    "system-ui", "-apple-system", "blinkmacsystemfont",
    "arial", "helvetica", "times", "georgia", "verdana", "trebuchet ms",
  ]);

  const matches = css.match(/font-family\s*:\s*([^;}{]+)/gi) || [];
  for (const m of matches) {
    const val = m.replace(/font-family\s*:\s*/i, "").trim();
    // Take the first font in the stack
    const first = val.split(",")[0].replace(/['"]/g, "").trim();
    if (first && !genericFamilies.has(first.toLowerCase())) {
      fonts.add(first);
    }
  }

  return [...fonts].slice(0, 8);
}

function extractJsonLd(html: string): any[] {
  const results: any[] = [];
  // Match all JSON-LD script blocks
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed) results.push(parsed);
    } catch {
      // malformed JSON-LD — skip
    }
  }
  return results;
}

function jsonLdToText(items: any[]): string {
  if (!items.length) return "";
  const parts: string[] = [];
  for (const item of items) {
    const type = item["@type"] || "";
    const name = item.name || item.headline || "";
    const desc = item.description || "";
    const url = item.url || item["@id"] || "";
    if (name) parts.push(`${type ? `[${type}] ` : ""}${name}${desc ? ": " + desc : ""}${url ? ` (${url})` : ""}`);
  }
  return parts.join("\n");
}

export function extractStructuredHtml(html: string, pageUrl: string, selector?: string): StructuredHtmlResult {
  // ── Extract design tokens from CSS BEFORE Cheerio removes style tags ──
  const styleTagContent: string[] = [];
  const styleTagRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleTagRe.exec(html)) !== null) {
    styleTagContent.push(styleMatch[1]);
  }
  const allCss = styleTagContent.join("\n");
  const cssColors = extractColorsFromCss(allCss);
  const cssFonts = extractFontsFromCss(allCss);

  // Extract inline style colors/fonts from root elements
  const inlineColorRe = /style="[^"]*(?:color|background)[^"]*#([0-9a-fA-F]{3,8})/gi;
  const inlineColors: string[] = [];
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineColorRe.exec(html)) !== null) {
    inlineColors.push(`#${inlineMatch[1].toLowerCase()}`);
  }

  // Extract JSON-LD BEFORE removing script tags
  const structuredData = extractJsonLd(html);

  const $ = cheerio.load(html);

  // ── Meta & page-level data ──
  const titleEl = $("title").text().trim();
  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const metaDesc = $('meta[name="description"]').attr("content") || "";
  const ogDesc = $('meta[property="og:description"]').attr("content") || "";
  const siteName = $('meta[property="og:site_name"]').attr("content") || "";
  const canonicalUrl = $('link[rel="canonical"]').attr("href") || pageUrl;
  const articlePublished = $('meta[property="article:published_time"]').attr("content") || $("time[datetime]").attr("datetime") || "";
  const articleUpdated =
    $('meta[property="article:modified_time"]').attr("content") ||
    $('meta[name="last-modified"]').attr("content") ||
    $('meta[property="og:updated_time"]').attr("content") ||
    "";
  const themeColor = $('meta[name="theme-color"]').attr("content") || "";
  const language = $("html").attr("lang") || "";
  const keywords = $('meta[name="keywords"]').attr("content") || "";
  const author = $('meta[name="author"]').attr("content") || "";
  const robots = $('meta[name="robots"]').attr("content") || "";
  const ogImage = $('meta[property="og:image"]').attr("content") || "";
  const ogType = $('meta[property="og:type"]').attr("content") || "";
  const twitterCard = $('meta[name="twitter:card"]').attr("content") || "";
  const twitterSite = $('meta[name="twitter:site"]').attr("content") || "";

  // Favicon
  const favicon =
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    $('link[rel="apple-touch-icon"]').attr("href") ||
    "";

  // CSS font vars from <link> tags (Google Fonts etc.)
  const fontLinks: string[] = [];
  $('link[rel="stylesheet"][href]').each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href.includes("fonts.googleapis.com") || href.includes("fonts.bunny.net") || href.includes("typekit")) {
      fontLinks.push(href);
    }
  });
  // Extract font names from Google Fonts URLs
  const googleFonts: string[] = [];
  for (const link of fontLinks) {
    const familyMatch = link.match(/family=([^&?]+)/);
    if (familyMatch) {
      const families = decodeURIComponent(familyMatch[1]).split("|").map((f) => f.split(":")[0].replace(/\+/g, " ")).filter(Boolean);
      googleFonts.push(...families);
    }
  }

  // ── Navigation ──
  const navLinks: string[] = [];
  $("nav a[href], header a[href], [role='navigation'] a[href]").each((_, el) => {
    const text = cleanText($(el).text());
    const href = $(el).attr("href") || "";
    if (text && text.length < 60) navLinks.push(href ? `${text} (${href})` : text);
  });
  const uniqueNavLinks = [...new Set(navLinks)].slice(0, 30);

  // Social links
  const socialLinks: Record<string, string> = {};
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const socialPatterns: Record<string, string> = {
      twitter: "twitter.com", x: "x.com", linkedin: "linkedin.com",
      github: "github.com", youtube: "youtube.com", instagram: "instagram.com",
      facebook: "facebook.com", discord: "discord.gg", slack: "slack.com",
    };
    for (const [name, domain] of Object.entries(socialPatterns)) {
      if (href.includes(domain) && !socialLinks[name]) socialLinks[name] = href;
    }
  });

  // Contact info
  const emailLinks: string[] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const email = ($(el).attr("href") || "").replace("mailto:", "").split("?")[0];
    if (email && !emailLinks.includes(email)) emailLinks.push(email);
  });

  // ── Images ──
  const pageImages: PageImage[] = [];
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    const alt = cleanText($(el).attr("alt") || "");
    const title = cleanText($(el).attr("title") || "");
    if (src && !src.startsWith("data:")) {
      pageImages.push({ src, alt, ...(title ? { title } : {}) });
    }
  });

  // ── Remove noise before content extraction ──
  $("script, style, noscript, template, svg, path, symbol, clipPath, defs, pattern, mask, filter").remove();
  $("nav, footer, header, aside").remove();

  // ── Main content ──
  const candidates = selector
    ? [selector]
    : [
        "main",
        "article",
        "[role='main']",
        ".docs-content",
        ".documentation",
        ".article",
        ".post-content",
        "#content",
        "body",
      ];

  let root: cheerio.Cheerio<any> | null = null;
  for (const candidate of candidates) {
    const next = $(candidate).first();
    if (next.length > 0) {
      root = next;
      if (cleanText(next.text()).length > 80) break;
    }
  }

  const lines: string[] = [];
  if (root) {
    for (const child of root.contents().toArray()) {
      emitNode($, child, lines);
    }
  }

  let content = lines
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // ── Append supplementary sections to content (makes them searchable) ──

  if (pageImages.length > 0) {
    const imageLines = pageImages
      .filter((img) => img.alt || img.title)
      .slice(0, 20)
      .map((img) => `- ${img.alt || img.title || img.src}`);
    if (imageLines.length > 0) {
      content += `\n\n[Images]\n${imageLines.join("\n")}`;
    }
  }

  if (uniqueNavLinks.length > 0) {
    content += `\n\n[Navigation]\n${uniqueNavLinks.join(" | ")}`;
  }

  const allColors = [...new Set([...cssColors, ...inlineColors.slice(0, 5)])].slice(0, 15);
  const allFonts = [...new Set([...cssFonts, ...googleFonts])].slice(0, 8);
  const designParts: string[] = [];
  if (allColors.length > 0) designParts.push(`Colors: ${allColors.join(", ")}`);
  if (allFonts.length > 0) designParts.push(`Fonts: ${allFonts.join(", ")}`);
  if (themeColor) designParts.push(`Theme color: ${themeColor}`);
  if (designParts.length > 0) {
    content += `\n\n[Design]\n${designParts.join("\n")}`;
  }

  const jsonLdText = jsonLdToText(structuredData);
  if (jsonLdText) {
    content += `\n\n[Structured Data]\n${jsonLdText}`;
  }

  if (Object.keys(socialLinks).length > 0) {
    const socialLines = Object.entries(socialLinks).map(([k, v]) => `${k}: ${v}`).join("\n");
    content += `\n\n[Social]\n${socialLines}`;
  }

  if (emailLinks.length > 0) {
    content += `\n\n[Contact]\nEmail: ${emailLinks.join(", ")}`;
  }

  // Fallback content
  if (!content) {
    content = [ogDesc, metaDesc].filter(Boolean).join("\n\n");
  }

  return {
    title: ogTitle || titleEl || pageUrl,
    content,
    metadata: {
      source: "web",
      url: pageUrl,
      canonical_url: canonicalUrl,
      siteName,
      publishedAt: articlePublished || null,
      updatedAt: articleUpdated || null,
      source_type: "web_docs",
      language: language || null,
      keywords: keywords || null,
      author: author || null,
      robots: robots || null,
      ogImage: ogImage || null,
      ogType: ogType || null,
      twitterCard: twitterCard || null,
      twitterSite: twitterSite || null,
      description: metaDesc || ogDesc || null,
      structuredDataTypes: structuredData.map((d) => d["@type"]).filter(Boolean),
    },
    design: {
      colors: allColors,
      fonts: allFonts,
      themeColor,
      favicon,
    },
    images: pageImages.slice(0, 50),
    structuredData,
    navigation: uniqueNavLinks,
  };
}
