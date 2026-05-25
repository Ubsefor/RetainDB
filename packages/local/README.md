# RetainDB Local

Persistent memory for coding agents. Runs on your machine.

RetainDB Local is the zero-external-database runtime for the local product. It starts one HTTP process on `:3111`, stores an atomic snapshot plus an append-only journal under `~/.retaindb/`, and exposes the memory endpoints used by the RetainDB MCP bridge.

## Quick Start

```bash
npx -y @retaindb/local
```

In another terminal:

```bash
npx -y @retaindb/local demo
npx -y @retaindb/local connect all
RETAINDB_BASE_URL=http://localhost:3111 npx -y @retaindb/local mcp
```

## Commands

```bash
retaindb                 # start the local memory server
retaindb demo            # seed demo memories and prove recall
retaindb benchmark       # run local recall/latency proof and write a report
retaindb install-embeddings  # warm the local transformer model cache
retaindb connect all     # write Codex, Claude Code, and OpenCode snippets
retaindb connect all --install  # merge Codex/Claude Code user configs with backups
retaindb hook            # capture a hook payload from stdin
retaindb import-jsonl    # import Claude-style JSONL transcripts
retaindb consolidate     # dedupe and roll up sessions into semantic/procedural memory
retaindb reembed         # refresh vectors with the configured embedding provider
retaindb doctor          # print local runtime status
```

## Context Router

RetainDB Local can reduce normal coding-agent token use, not just memory tokens.

- `POST /v1/context/pack` builds a token-budgeted pack from memory, relevant file chunks, code map, and compressed tool output.
- `POST /v1/context/delta` returns only what changed since a previous `context_hash`.
- `POST /v1/context/compress-output` keeps errors, failing tests, and stack traces while dropping log noise.
- `POST /v1/context/code-map` returns relevant files and symbols without dumping the repo.

The bundled MCP bridge exposes `context_pack`, `context_delta`, `compress_output`, and `code_map`.

Optional local model embeddings:

```bash
retaindb install-embeddings
RETAINDB_EMBEDDING_PROVIDER=local-transformers retaindb reembed
```

## Runtime Shape

- `POST /v1/memory` stores one durable memory.
- `POST /v1/memory/search` searches local memories.
- `POST /v1/context/query` returns a context block for agents.
- `POST /v1/memory/ingest/session` captures prompts, tool results, file edits, failures, and summaries.
- `POST /v1/agent-events` is the hook-friendly capture endpoint.
- `GET /retaindb/replay/:sessionId` returns replayable session events.
- `GET /retaindb/graph` returns the local concept graph.

Search uses BM25, vector similarity, graph signals, RRF fusion, and a final rerank pass. The viewer runs on `:3113` with a memory browser, step-through replay timeline, and clickable concept graph.

Memory quality is not just raw capture. RetainDB Local skips low-signal events, infers semantic/procedural/correction memories, reinforces memories that get recalled, and decays stale weak raw observations during consolidation.

Benchmark reports are written to `~/.retaindb/benchmarks/`.

This is intentionally separate from RetainDB Cloud. Cloud remains the hosted API, dashboard, auth, billing, SDK, and Convex-backed product track.
