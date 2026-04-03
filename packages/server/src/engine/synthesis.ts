import OpenAI from "openai";

const DEFAULT_MODEL = process.env.SYNTHESIS_MODEL || "gpt-4o-mini";
const MAX_INPUT_CHARS = 40_000;

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export interface SynthesisResult {
  summary: string;
  purpose?: string;
  keyTopics: string[];
  keyEntities: string[];
  sections?: Array<{ title: string; summary: string }>;
  decisions?: string[];
  actionItems?: string[];
  tags?: string[];
  // extended fields (source-specific)
  findings?: string[];
  methodology?: string;
  conclusions?: string[];
  contributions?: string[];
  limitations?: string[];
  datasetInfo?: string;
  // video-specific
  chapters?: Array<{ timestamp: string; topic: string }>;
  speakers?: string[];
  keyMoments?: string[];
}

function buildPrompt(sourceType: string, title: string, content: string, hints?: Record<string, string>): string {
  const hintLines = hints
    ? Object.entries(hints).map(([k, v]) => `${k}: ${v}`).join("\n")
    : "";
  const ctx = hintLines ? `\nContext:\n${hintLines}\n` : "";

  // PDF / document
  if (["pdf", "document"].includes(sourceType)) {
    return `You are analyzing a PDF document titled "${title}".${ctx}
Extract a comprehensive, highly structured synthesis. Every field should be specific and informative — not vague placeholders.

Document content:
${content}

Respond with JSON only:
{
  "summary": "3-5 sentence executive summary of what this document is, its purpose, key arguments, and conclusions",
  "purpose": "one sentence: what problem does this document solve or what does it accomplish",
  "keyTopics": ["specific topic 1", "topic 2", "topic 3", "topic 4", "topic 5"],
  "keyEntities": ["person/org/product/tech mentioned"],
  "sections": [{"title": "exact section name from document", "summary": "what this section covers in detail"}],
  "findings": ["key finding, data point, or fact stated in the document"],
  "methodology": "how was the research/analysis conducted (if applicable)",
  "conclusions": ["specific conclusion drawn in the document"],
  "limitations": ["limitations or caveats mentioned"],
  "decisions": ["key decisions, recommendations, or prescriptions"],
  "actionItems": ["explicit next steps or action items mentioned"],
  "tags": ["category or domain tag"]
}`;
  }

  // ArXiv / research paper
  if (["arxiv", "research_paper", "paper"].includes(sourceType)) {
    return `You are analyzing a research paper titled "${title}".${ctx}
Extract every meaningful aspect of this paper that a researcher would care about.

Paper content:
${content}

Respond with JSON only:
{
  "summary": "4-6 sentence abstract-level summary: problem, approach, results, significance",
  "purpose": "one sentence: what gap or problem does this paper address",
  "contributions": ["specific novel contribution 1", "contribution 2", "contribution 3"],
  "keyTopics": ["research area or technique 1", "topic 2"],
  "keyEntities": ["models, datasets, benchmarks, or frameworks mentioned"],
  "methodology": "detailed description of the experimental setup and methods",
  "findings": ["specific quantitative result or finding (e.g. '94.2% accuracy on X benchmark')"],
  "conclusions": ["key conclusion drawn by the authors"],
  "limitations": ["limitations or future work mentioned by authors"],
  "sections": [{"title": "paper section name", "summary": "what this section contributes"}],
  "tags": ["machine learning", "NLP", etc.]
}`;
  }

  // Video / transcript
  if (["video", "youtube", "loom"].includes(sourceType)) {
    return `You are analyzing a video transcript titled "${title}".${ctx}
Extract a comprehensive synthesis of the video's content.

Transcript:
${content}

Respond with JSON only:
{
  "summary": "3-5 sentence overview of what this video covers and its key message",
  "purpose": "one sentence: what is the goal of this video",
  "keyTopics": ["topic covered in the video"],
  "keyEntities": ["people, products, companies, technologies mentioned"],
  "chapters": [{"timestamp": "MM:SS", "topic": "what is discussed at this point"}],
  "speakers": ["speaker names if identifiable"],
  "keyMoments": ["important quote, demonstration, announcement, or insight"],
  "findings": ["key fact, statistic, or insight stated"],
  "conclusions": ["conclusion or takeaway presented"],
  "actionItems": ["action items or calls to action mentioned"],
  "tags": ["topic tag"]
}`;
  }

  // Notion
  if (sourceType === "notion") {
    return `You are analyzing a Notion page titled "${title}".${ctx}
Extract a comprehensive synthesis.

Content:
${content}

Respond with JSON only:
{
  "summary": "2-4 sentence overview of what this page is about and its key information",
  "purpose": "one sentence: what is the purpose of this Notion page",
  "keyTopics": ["topic or theme covered"],
  "keyEntities": ["people, projects, tools, companies mentioned"],
  "sections": [{"title": "section heading", "summary": "what this section contains"}],
  "decisions": ["decision, agreement, or resolution recorded"],
  "actionItems": ["task, to-do, or action item listed"],
  "findings": ["key fact, metric, or data point"],
  "tags": ["category tag"]
}`;
  }

  // Slack / Discord conversations
  if (["slack", "discord"].includes(sourceType)) {
    return `You are analyzing a ${sourceType === "slack" ? "Slack" : "Discord"} conversation titled "${title}".${ctx}
Extract a concise synthesis of what was discussed.

Messages:
${content}

Respond with JSON only:
{
  "summary": "2-3 sentence description of the main topics and outcomes of this conversation",
  "purpose": "one sentence: what was this conversation about or trying to accomplish",
  "keyTopics": ["main topic or theme discussed"],
  "keyEntities": ["people, projects, tools, products mentioned"],
  "decisions": ["decision, agreement, or resolution reached"],
  "actionItems": ["task or follow-up mentioned"],
  "findings": ["key fact, answer, or piece of information shared"],
  "tags": ["topic tag"]
}`;
  }

  // npm / PyPI packages
  if (["npm_package", "pypi_package", "npm", "pypi"].includes(sourceType)) {
    return `You are analyzing a software package titled "${title}".${ctx}
Extract a comprehensive synthesis.

Content:
${content}

Respond with JSON only:
{
  "summary": "2-3 sentence description of what this package does, its purpose, and primary use cases",
  "purpose": "one sentence: what problem does this package solve",
  "keyTopics": ["capability or feature this package provides"],
  "keyEntities": ["notable dependencies, related packages, or frameworks"],
  "sections": [{"title": "API / Feature", "summary": "what it does"}],
  "tags": ["category or domain tag"]
}`;
  }

  // API specs
  if (["api_spec", "openapi", "swagger"].includes(sourceType)) {
    return `You are analyzing an API specification titled "${title}".${ctx}
Extract a comprehensive synthesis.

Content:
${content}

Respond with JSON only:
{
  "summary": "2-3 sentence description of what this API does, its endpoints, and integration capabilities",
  "purpose": "one sentence: what does this API enable developers to do",
  "keyTopics": ["main resource or capability the API exposes"],
  "keyEntities": ["authentication method, major endpoints, data models"],
  "sections": [{"title": "endpoint group or resource", "summary": "what operations it supports"}],
  "tags": ["API category or integration type"]
}`;
  }

  // Dataset
  if (["dataset", "csv", "jsonl"].includes(sourceType)) {
    return `You are analyzing a dataset titled "${title}".${ctx}
Extract a comprehensive synthesis.

Data sample:
${content}

Respond with JSON only:
{
  "summary": "3-5 sentence overview: what this dataset contains, its structure, coverage, and potential use cases",
  "purpose": "one sentence: what was this dataset created to measure or enable",
  "keyTopics": ["domain or topic this dataset covers"],
  "keyEntities": ["entities, organizations, or subjects in the dataset"],
  "datasetInfo": "detailed description of columns/fields, data types, scale (rows/columns), and any notable patterns",
  "findings": ["interesting statistical property or data characteristic"],
  "limitations": ["known limitations, biases, or gaps in the data"],
  "tags": ["data type or domain tag"]
}`;
  }

  // Generic fallback
  return `You are analyzing a ${sourceType} document titled "${title}".${ctx}
Produce a high-level synthesis that will help someone understand what this document contains and whether it's relevant to their question.

Content:
${content}

Respond with JSON only:
{
  "summary": "2-4 sentence overview of what this document is about and its key purpose",
  "purpose": "one sentence describing what this document accomplishes or explains",
  "keyTopics": ["topic1", "topic2"],
  "keyEntities": ["entity1", "entity2"],
  "sections": [{"title": "section name", "summary": "what this section covers"}],
  "decisions": ["key decision or conclusion mentioned"],
  "actionItems": ["action item or next step mentioned"],
  "tags": ["tag1", "tag2"]
}`;
}

/**
 * Generate a high-level synthesis of a document using an LLM.
 * Returns null if OPENAI_API_KEY is not set or LLM call fails.
 */
export async function synthesizeDocument(
  content: string,
  sourceType: string,
  title: string,
  hints?: Record<string, string>,
): Promise<SynthesisResult | null> {
  const ai = getOpenAI();
  if (!ai) return null;

  const truncated = content.slice(0, MAX_INPUT_CHARS);
  const prompt = buildPrompt(sourceType, title, truncated, hints);

  try {
    const res = await ai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    });
    const text = res.choices[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(text);
    return {
      summary: String(parsed.summary || ""),
      purpose: parsed.purpose ? String(parsed.purpose) : undefined,
      keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.map(String) : [],
      keyEntities: Array.isArray(parsed.keyEntities) ? parsed.keyEntities.map(String) : [],
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
      methodology: parsed.methodology ? String(parsed.methodology) : undefined,
      conclusions: Array.isArray(parsed.conclusions) ? parsed.conclusions.map(String) : [],
      contributions: Array.isArray(parsed.contributions) ? parsed.contributions.map(String) : [],
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations.map(String) : [],
      datasetInfo: parsed.datasetInfo ? String(parsed.datasetInfo) : undefined,
      chapters: Array.isArray(parsed.chapters) ? parsed.chapters : [],
      speakers: Array.isArray(parsed.speakers) ? parsed.speakers.map(String) : [],
      keyMoments: Array.isArray(parsed.keyMoments) ? parsed.keyMoments.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Format a SynthesisResult into a rich markdown document for indexing.
 */
export function formatSynthesis(synthesis: SynthesisResult, title: string): string {
  const lines: string[] = [`# ${title} — Overview\n`];

  if (synthesis.purpose) {
    lines.push(`**Purpose:** ${synthesis.purpose}\n`);
  }

  lines.push(`## Summary\n${synthesis.summary}\n`);

  if (synthesis.contributions && synthesis.contributions.length > 0) {
    lines.push(`## Key Contributions\n${synthesis.contributions.map((c) => `- ${c}`).join("\n")}\n`);
  }

  if (synthesis.keyTopics.length > 0) {
    lines.push(`## Key Topics\n${synthesis.keyTopics.map((t) => `- ${t}`).join("\n")}\n`);
  }

  if (synthesis.keyEntities.length > 0) {
    lines.push(`## Key Entities / Technologies\n${synthesis.keyEntities.map((e) => `- ${e}`).join("\n")}\n`);
  }

  if (synthesis.methodology) {
    lines.push(`## Methodology\n${synthesis.methodology}\n`);
  }

  if (synthesis.findings && synthesis.findings.length > 0) {
    lines.push(`## Key Findings\n${synthesis.findings.map((f) => `- ${f}`).join("\n")}\n`);
  }

  if (synthesis.conclusions && synthesis.conclusions.length > 0) {
    lines.push(`## Conclusions\n${synthesis.conclusions.map((c) => `- ${c}`).join("\n")}\n`);
  }

  if (synthesis.limitations && synthesis.limitations.length > 0) {
    lines.push(`## Limitations\n${synthesis.limitations.map((l) => `- ${l}`).join("\n")}\n`);
  }

  if (synthesis.decisions && synthesis.decisions.length > 0) {
    lines.push(`## Decisions & Conclusions\n${synthesis.decisions.map((d) => `- ${d}`).join("\n")}\n`);
  }

  if (synthesis.actionItems && synthesis.actionItems.length > 0) {
    lines.push(`## Action Items\n${synthesis.actionItems.map((a) => `- ${a}`).join("\n")}\n`);
  }

  if (synthesis.chapters && synthesis.chapters.length > 0) {
    lines.push(`## Chapters / Timeline\n${synthesis.chapters.map((c) => `- **${c.timestamp}** — ${c.topic}`).join("\n")}\n`);
  }

  if (synthesis.speakers && synthesis.speakers.length > 0) {
    lines.push(`## Speakers\n${synthesis.speakers.join(", ")}\n`);
  }

  if (synthesis.keyMoments && synthesis.keyMoments.length > 0) {
    lines.push(`## Key Moments\n${synthesis.keyMoments.map((m) => `- ${m}`).join("\n")}\n`);
  }

  if (synthesis.datasetInfo) {
    lines.push(`## Dataset Structure\n${synthesis.datasetInfo}\n`);
  }

  if (synthesis.sections && synthesis.sections.length > 0) {
    lines.push(`## Sections\n${synthesis.sections.map((s) => `- **${s.title}**: ${s.summary}`).join("\n")}\n`);
  }

  if (synthesis.tags && synthesis.tags.length > 0) {
    lines.push(`## Tags\n${synthesis.tags.join(", ")}\n`);
  }

  return lines.join("\n").trim();
}
