import { ingestDocument } from "../engine/ingest.js";
import { synthesizeDocument, formatSynthesis } from "../engine/synthesis.js";

interface TextConfig {
  title: string;
  content: string;
  metadata?: Record<string, any>;
  sourceType?: string;
}

export async function syncText(
  sourceId: string,
  projectId: string,
  config: TextConfig
) {
  const { title, content, metadata = {}, sourceType = "plain_text" } = config;

  if (!content?.trim()) return { documentsIndexed: 0 };

  let indexed = 0;

  const synthesis = await synthesizeDocument(content, sourceType, title);
  if (synthesis) {
    await ingestDocument({
      sourceId,
      projectId,
      externalId: `text-${title}#synthesis`,
      title: `${title} — Summary`,
      content: formatSynthesis(synthesis, title),
      metadata: { ...metadata, source_type: sourceType, is_synthesis: true },
      sourceType,
      ingestionProfile: "plain_text",
    });
    indexed++;
  }

  await ingestDocument({
    sourceId,
    projectId,
    externalId: `text-${title}`,
    title,
    content,
    metadata: { ...metadata, source_type: sourceType },
    sourceType,
    ingestionProfile: "plain_text",
  });
  indexed++;

  return { documentsIndexed: indexed };
}
