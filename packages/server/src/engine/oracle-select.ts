import { Prisma } from "@prisma/client";
import { prisma } from "../db/index.js";

export type OracleSelectScope = {
  seed_hits: Array<{
    chunk_id: string;
    document_id: string;
    section_path: string;
    heading_path?: string | null;
    similarity: number;
  }>;
  documents: Array<{
    document_id: string;
    score: number;
    section_paths: string[];
  }>;
  candidate_chunk_ids: string[];
};

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = String(value || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function safeSectionPath(value: unknown): string {
  const raw = String(value || "").trim();
  return raw.length > 0 ? raw : "Document";
}

export async function selectOracleScope(params: {
  projectId: string;
  queryEmbedding: number[];
  sourceIds?: string[];
  chunkTypes?: string[];
  metadataFilter?: Record<string, any>;
  maxSeedHits?: number;
  maxDocuments?: number;
  maxSectionsPerDoc?: number;
  maxCandidateChunks?: number;
}): Promise<OracleSelectScope> {
  const {
    projectId,
    queryEmbedding,
    sourceIds,
    chunkTypes,
    metadataFilter,
    maxSeedHits = 120,
    maxDocuments = 6,
    maxSectionsPerDoc = 5,
    maxCandidateChunks = 1400,
  } = params;

  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    return { seed_hits: [], documents: [], candidate_chunk_ids: [] };
  }

  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const metadataJson = metadataFilter ? JSON.stringify(metadataFilter) : null;
  const scopedSourceIds = uniqueStrings(sourceIds || []);
  const scopedChunkTypes = uniqueStrings(chunkTypes || []);

  const sourceFilterSql =
    scopedSourceIds.length > 0
      ? Prisma.sql`AND d."sourceId" = ANY(${scopedSourceIds})`
      : Prisma.empty;
  const chunkTypeFilterSql =
    scopedChunkTypes.length > 0
      ? Prisma.sql`AND c."chunkType" = ANY(${scopedChunkTypes})`
      : Prisma.empty;
  const metadataFilterSql =
    metadataJson
      ? Prisma.sql`AND c.metadata @> ${metadataJson}::jsonb`
      : Prisma.empty;

  const seedHits = (await prisma.$queryRaw<Array<{
    id: string;
    documentId: string;
    sectionPath: string | null;
    headingPath: string | null;
    similarity: number;
  }>>(Prisma.sql`
    SELECT
      c.id,
      c."documentId",
      c."sectionPath",
      c."headingPath",
      1 - (c.embedding <=> ${embeddingStr}::vector) as similarity
    FROM chunks c
    WHERE c."projectId" = ${projectId}
      AND c.embedding IS NOT NULL
      AND COALESCE(c.metadata->>'content_kind', '') <> 'parent_context'
      ${chunkTypeFilterSql}
      ${metadataFilterSql}
      AND EXISTS (
        SELECT 1
        FROM documents d
        INNER JOIN sources s ON s.id = d."sourceId"
        WHERE d.id = c."documentId"
          AND d."deletedAt" IS NULL
          ${sourceFilterSql}
          AND (
            s."activeVersionId" IS NULL
            OR d."sourceVersionId" = s."activeVersionId"
          )
      )
    ORDER BY c.embedding <=> ${embeddingStr}::vector
    LIMIT ${Math.max(10, Math.min(maxSeedHits, 400))}
  `)) || [];

  const normalizedSeedHits = seedHits.map((hit) => ({
    chunk_id: hit.id,
    document_id: hit.documentId,
    section_path: safeSectionPath(hit.sectionPath),
    heading_path: hit.headingPath,
    similarity: Number(hit.similarity) || 0,
  }));

  const docScores = new Map<string, { score: number; sectionScores: Map<string, number> }>();
  for (const hit of normalizedSeedHits) {
    const state = docScores.get(hit.document_id) || { score: 0, sectionScores: new Map<string, number>() };
    state.score = Math.max(state.score, hit.similarity);
    state.sectionScores.set(hit.section_path, Math.max(state.sectionScores.get(hit.section_path) || 0, hit.similarity));
    docScores.set(hit.document_id, state);
  }

  const topDocs = [...docScores.entries()]
    .map(([document_id, state]) => ({
      document_id,
      score: state.score,
      section_paths: [...state.sectionScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxSectionsPerDoc)
        .map(([section]) => section),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, maxDocuments));

  const candidateChunkIds: string[] = [];
  const candidateChunkIdSet = new Set<string>();

  if (topDocs.length === 0) {
    return { seed_hits: normalizedSeedHits, documents: [], candidate_chunk_ids: [] };
  }

  for (const doc of topDocs) {
    if (candidateChunkIds.length >= maxCandidateChunks) break;
    if (!doc.section_paths || doc.section_paths.length === 0) continue;

    const remaining = Math.max(1, maxCandidateChunks - candidateChunkIds.length);
    const perDocLimit = Math.max(50, Math.min(remaining, Math.floor(maxCandidateChunks / Math.max(1, topDocs.length))));

    const rows = (await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c.id
      FROM chunks c
      WHERE c."documentId" = ${doc.document_id}
        AND COALESCE(c.metadata->>'content_kind', '') <> 'parent_context'
        AND c."sectionPath" = ANY(${doc.section_paths})
        ${chunkTypeFilterSql}
        ${metadataFilterSql}
      ORDER BY COALESCE(c."chunkIndex", c."chunkOrder", 0) ASC
      LIMIT ${perDocLimit}
    `)) || [];

    for (const row of rows) {
      if (candidateChunkIds.length >= maxCandidateChunks) break;
      const id = String(row.id || "");
      if (!id || candidateChunkIdSet.has(id)) continue;
      candidateChunkIdSet.add(id);
      candidateChunkIds.push(id);
    }
  }

  // Always include seed hits even if they fall outside the selected sections.
  for (const hit of normalizedSeedHits) {
    if (candidateChunkIds.length >= maxCandidateChunks) break;
    if (candidateChunkIdSet.has(hit.chunk_id)) continue;
    candidateChunkIdSet.add(hit.chunk_id);
    candidateChunkIds.push(hit.chunk_id);
  }

  return {
    seed_hits: normalizedSeedHits,
    documents: topDocs,
    candidate_chunk_ids: candidateChunkIds,
  };
}

export async function selectOracleCandidateChunkIds(params: Omit<
  Parameters<typeof selectOracleScope>[0],
  never
>): Promise<string[]> {
  const scope = await selectOracleScope(params);
  return scope.candidate_chunk_ids;
}

