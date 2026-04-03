-- Change vector dimensions from 1536 (OpenAI) to 1024 (BGE-large)

-- Drop existing vector columns and recreate with correct dimensions
-- Note: This will delete existing embeddings, but keeps the content

-- Memories table
ALTER TABLE memories DROP COLUMN IF EXISTS embedding CASCADE;
ALTER TABLE memories ADD COLUMN embedding vector(1024);
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Chunks table
ALTER TABLE chunks DROP COLUMN IF EXISTS embedding CASCADE;
ALTER TABLE chunks ADD COLUMN embedding vector(1024);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Entities table (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'embedding') THEN
    ALTER TABLE entities DROP COLUMN embedding CASCADE;
    ALTER TABLE entities ADD COLUMN embedding vector(1024);
    CREATE INDEX IF NOT EXISTS entities_embedding_idx ON entities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  END IF;
END $$;
