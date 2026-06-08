// Custom LLM integration — 5 lines to ground any AI in the company brain.
//
// Usage:
//   1. Start the local server:  npm start (from packages/local)
//   2. Add a source + sync:     retaindb add github tj/n --sync
//   3. Run this example:
//        set OPENAI_KEY=sk-...
//        node examples/custom-llm.mjs
//        -- or --
//        set ANTHROPIC_KEY=sk-ant-...
//        node examples/custom-llm.mjs
//
// The FeedAgent method:
//   - Takes your messages + a question
//   - Searches the company brain for relevant context
//   - Returns an OpenAI-style system prompt + augmented message array
//   - Returns structured citations so you can surface source attribution

import { RetainDB } from "../packages/sdk/dist/index.js";

const db = new RetainDB({ apiKey: "local-no-auth", baseUrl: "http://localhost:3111" });
const { system_prompt, messages, citations } = await db.feedAgent({
  query: "what is n, the node version manager",
  messages: [{ role: "user", content: "Summarize what this tool does in 3 bullet points" }],
});

console.log("=== System prompt (first 300 chars) ===");
console.log(system_prompt.slice(0, 300) + "...\n");

console.log(`=== Citations (${citations.length}) ===`);
for (const c of citations) {
  console.log(`  [${c.source_type}] ${c.title} — ${c.snippet.slice(0, 100)}...`);
}

// Pipe to any LLM:
if (process.env.OPENAI_KEY) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_KEY}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 500 }),
  });
  const data = await res.json();
  console.log("\n=== OpenAI reply ===");
  console.log(data.choices?.[0]?.message?.content || JSON.stringify(data));
} else if (process.env.ANTHROPIC_KEY) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", messages, system: system_prompt, max_tokens: 500 }),
  });
  const data = await res.json();
  console.log("\n=== Anthropic reply ===");
  console.log(data.content?.[0]?.text || JSON.stringify(data));
} else {
  console.log("\nSet OPENAI_KEY or ANTHROPIC_KEY to see a live LLM reply.");
}
