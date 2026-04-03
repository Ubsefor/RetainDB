-- Add async ingestion job tables
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id VARCHAR(255) PRIMARY KEY,
  org_id VARCHAR(255) NOT NULL,
  project_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  total_documents INT NOT NULL DEFAULT 0,
  processed_documents INT NOT NULL DEFAULT 0,
  total_chunks INT NOT NULL DEFAULT 0,
  processed_chunks INT NOT NULL DEFAULT 0,
  webhook_url TEXT,
  metadata JSONB DEFAULT '{}',
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_org_id ON ingestion_jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_project_id ON ingestion_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created_at ON ingestion_jobs(created_at);

CREATE TABLE IF NOT EXISTS ingestion_documents (
  id VARCHAR(255) PRIMARY KEY,
  job_id VARCHAR(255) NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  project_id VARCHAR(255) NOT NULL,
  title TEXT,
  content TEXT,
  url TEXT,
  metadata JSONB DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  document_id VARCHAR(255),
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_documents_job_id ON ingestion_documents(job_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_documents_status ON ingestion_documents(status);
CREATE INDEX IF NOT EXISTS idx_ingestion_documents_project_id ON ingestion_documents(project_id);

-- Add embedding job table for async embedding generation
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id VARCHAR(255) PRIMARY KEY,
  document_id VARCHAR(255),
  chunk_ids JSONB DEFAULT '[]',
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  total_chunks INT NOT NULL DEFAULT 0,
  processed_chunks INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embedding_jobs_document_id ON embedding_jobs(document_id);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status ON embedding_jobs(status);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_created_at ON embedding_jobs(created_at);
