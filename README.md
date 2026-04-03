<p align="center">
  <img src="https://retaindb.com/retaindb-mark.svg" alt="RetainDB" height="60" />
</p>

<h2 align="center">RetainDB</h2>
<p align="center">Open-source memory and context infrastructure for AI agents</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@retaindb/sdk"><img src="https://img.shields.io/npm/v/@retaindb/sdk?label=%40retaindb%2Fsdk" /></a>
  <a href="https://www.npmjs.com/package/@retaindb/mcp"><img src="https://img.shields.io/npm/v/@retaindb/mcp?label=%40retaindb%2Fmcp" /></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0%20%2F%20BSL%201.1-blue" />
  <img src="https://img.shields.io/badge/postgres-%2B%20pgvector-informational" />
</p>

---

RetainDB is a self-hostable memory layer for AI agents. Give your agents persistent, structured memory that survives across sessions, users, and time — with one `docker compose up`.

## What it does

- **Stores memories** extracted from conversations via LLM — typed, versioned, confidence-scored
- **Retrieves context** in one call — semantic search + BM25 + rerank, packed into a context string ready for your LLM
- **Memory graph** — memories relate to each other (`updates`, `contradicts`, `supports`, `derives`)
- **Temporal validity** — facts have `validFrom`/`validUntil`; stale knowledge gets superseded, not lost
- **MCP server** — works with Claude Desktop and any MCP host out of the box
- **Framework adapters** — Vercel AI SDK, LangChain, LangGraph

## Quickstart

**Requirements:** Docker (or Node 18+ with Postgres + pgvector)

```bash
git clone https://github.com/retaindb/retaindb
cd retaindb
docker compose up
# Server ready at http://localhost:3000
```

No config needed. No API keys required for local use.

To enable embeddings, add your OpenAI key (optional — falls back to a local model otherwise):

```bash
OPENAI_API_KEY=sk-... docker compose up
```

### OSS notes

- The OSS server is single-tenant by default. Requests are scoped to a local default org on the server side, so clients do not need to send `X-Organization-Id`.
- If you do set `RETAINDB_API_KEY`, auth becomes a single shared server key for your deployment. This is for self-hosted protection, not multi-tenant cloud isolation.
- The `playwright` connector degrades to the standard web crawler in OSS instead of relying on the cloud browser-agent stack.

### Core server only

If you only want the self-hosted API right now, use the server-only scripts instead of the full workspace build:

```bash
pnpm install
pnpm build:server
pnpm dev:server
```

This avoids unrelated SDK and MCP workspace failures while the OSS split is still being cleaned up.

---

## SDK

```bash
npm install @retaindb/sdk
```

```ts
import { RetainDBContext } from "@retaindb/sdk";

const db = new RetainDBContext({
  apiKey: "",                        // leave blank if no RETAINDB_API_KEY set
  baseUrl: "http://localhost:3000",
  project: "my-agent",
});
```

### Store a memory

```ts
await db.addMemory({
  project: "my-agent",
  content: "User prefers concise answers and hates bullet points",
  memory_type: "preference",
  user_id: "user_123",
});
```

### Retrieve context before an LLM call

```ts
const { context } = await db.query({
  project: "my-agent",
  query: "What are this user's preferences?",
  user_id: "user_123",
  include_memories: true,
});

// context is a pre-packed string — drop it straight into your system prompt
```

### Extract memories from a conversation

```ts
await db.ingestSession({
  project: "my-agent",
  session_id: "session_abc",
  user_id: "user_123",
  messages: [
    { role: "user", content: "I'm building a SaaS in Next.js" },
    { role: "assistant", content: "Got it! What's the stack?" },
    { role: "user", content: "Next.js, Prisma, Postgres. Deploying on Vercel." },
  ],
});
// Memories like "User is building a Next.js SaaS on Vercel with Prisma + Postgres"
// are extracted and stored automatically.
```

### Vercel AI SDK

```ts
import { withRetainDB } from "@retaindb/sdk/ai-sdk";

const { context } = await db.query({ project: "my-agent", query: userMessage, user_id });

const result = await streamText({
  model: openai("gpt-4o"),
  system: `You are a helpful assistant.\n\n${context}`,
  messages,
});
```

---

## MCP (Claude Desktop)

```bash
npx @retaindb/mcp
```

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "retaindb": {
      "command": "npx",
      "args": ["@retaindb/mcp"],
      "env": {
        "RETAINDB_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

Claude will now call `context`, `remember`, `forget`, `compress`, `index`, and `search` automatically.

---

## REST API

All endpoints require `Authorization: Bearer <RETAINDB_API_KEY>` if you set one. Otherwise open.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/memory` | Store a memory |
| `GET` | `/v1/memory/profile/:userId` | List memories for a user |
| `POST` | `/v1/memory/search` | Semantic search over memories |
| `POST` | `/v1/memory/ingest/session` | Extract + store memories from a conversation |
| `PUT` | `/v1/memory/:id` | Update a memory |
| `DELETE` | `/v1/memory/:id` | Delete a memory |
| `POST` | `/v1/context/query` | Retrieve packed context for an agent turn |
| `GET` | `/v1/projects` | List projects |
| `POST` | `/v1/projects/:id/sources` | Connect a knowledge source |
| `POST` | `/v1/sources/:id/sync` | Trigger a sync |

In OSS, project visibility is server-scoped and single-tenant. The cloud-style org header model is not required for local use.

---

## Memory model

RetainDB's memory model is more structured than most:

```ts
type MemoryType =
  | "factual"       // "User's name is John"
  | "preference"    // "User prefers dark mode"
  | "decision"      // "Project standardises on Bun"
  | "constraint"    // "Must deploy on AWS Lambda"
  | "instruction"   // "Always use formal tone"
  | "goal"          // "User wants to learn Python"
  | "event"         // "User attended conf on Jan 15"
  | "correction"    // Supersedes a stale memory
  | "workflow"      // Reusable agent habit
  | ...             // + relationship, opinion, solution, project_state

type RelationType =
  | "updates"       // New fact supersedes old
  | "extends"       // Adds detail to existing memory
  | "contradicts"   // Conflicts detected
  | "supports"      // Provides evidence for
  | "derives"       // Inferred from other memories
```

Each memory has `validFrom`, `validUntil`, `confidence`, `entityMentions`, and a `version` chain — so the graph stays accurate as your agent learns over time.

---

## Connectors

Index external knowledge into your agent's context:

| Connector | Type |
|-----------|------|
| GitHub | Repos, code, issues |
| Web / Sitemap | Docs sites, pages |
| PDF | Local or remote |
| Notion | Pages and databases |
| Confluence | Spaces and pages |
| Slack | Channel history |
| Discord | Server history |
| arXiv | Papers |
| npm / PyPI | Package docs |
| HuggingFace | Model cards |
| Plain text | Inline content |

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `DATABASE_URL` | — | Postgres connection string (required) |
| `RETAINDB_API_KEY` | unset | Auth key. Unset = open access (fine for localhost). |
| `OPENAI_API_KEY` | unset | Enables OpenAI embeddings (`text-embedding-3-small`). Without it, a local BGE model is used. |
| `EMBEDDING_MODE` | auto | `openai` \| `local` \| `hybrid` |
| `EXTRACTION_MODEL` | `gpt-4o-mini` | LLM used to extract memories from conversations |
| `PORT` | `3000` | HTTP port |
| `DISABLE_SCHEDULER` | `false` | Disable background sync scheduler |

---

## Self-host vs. RetainDB Cloud

This repo is the self-hosted version. [RetainDB Cloud](https://retaindb.com) adds:

- Managed Postgres + pgvector — no ops
- Higher-quality embeddings and proprietary reranking
- Additional connectors (email, video transcription, live streams)
- Memory analytics — recall heatmaps, drift detection
- Team access controls and audit logs
- SLA + support

The cloud is not a crippled version of this — it's this plus the infrastructure and scale layer that most teams don't want to operate.

---

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `packages/server` | — | Self-hostable API server |
| `packages/sdk` | [`@retaindb/sdk`](https://www.npmjs.com/package/@retaindb/sdk) | TypeScript SDK |
| `packages/mcp` | [`@retaindb/mcp`](https://www.npmjs.com/package/@retaindb/mcp) | MCP server |

---

## Contributing

PRs welcome. Open an issue first for anything substantial.

```bash
pnpm install
cp .env.example .env    # edit DATABASE_URL
cd packages/server
pnpm db:push            # apply schema to your local Postgres
pnpm dev                # start the server with hot reload
```

---

## License

- `packages/sdk` — Apache 2.0
- `packages/mcp` — Apache 2.0
- `packages/server` — [Business Source License 1.1](./LICENSE-BSL)
  Free to self-host. Building a hosted service on top requires a commercial license — [reach out](mailto:hi@retaindb.com).
