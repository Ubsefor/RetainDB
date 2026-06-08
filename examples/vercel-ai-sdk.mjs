// Vercel AI SDK integration — 3 lines to add bidirectional memory.
//
// Usage:
//   1. Start the local server:  npm start (from packages/local)
//   2. Run:
//        set OPENAI_KEY=sk-...
//        node examples/vercel-ai-sdk.mjs
//
// The withRetainDB wrapper:
//   - Before each LLM call, retrieves relevant memories for the user/session
//     and injects them into the conversation.
//   - After each call, stores the user's message in the background.
//   - Scoped to `userId`, `sessionId`, or `agentId` passed in the call input.

import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { withRetainDB } from "../packages/sdk/dist/adapters/ai-sdk.js";

const result = streamText({
  model: withRetainDB(openai("gpt-4o-mini"), { apiKey: "local-no-auth", baseUrl: "http://localhost:3111" }),
  messages: [{ role: "user", content: "What does the company brain say about our stack?" }],
  userId: "demo-user",
  // The first call may have no memories yet; add a source first:
  // retaindb add github tj/n --sync
});

let reply = "";
for await (const chunk of result.textStream) {
  reply += chunk;
  process.stdout.write(chunk);
}
console.log("\n\nDone. The user message was auto-stored for future turns.");
