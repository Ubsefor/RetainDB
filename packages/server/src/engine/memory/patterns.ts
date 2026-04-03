import type { MemoryType } from "./types.js";

export interface PatternMatch {
  type: MemoryType;
  content: string;
  confidence: number;
  matchedPattern: string;
  entities: string[];
  /** Retention hint for downstream storage decisions */
  retention: "durable" | "session" | "short";
}

interface PatternDef {
  type: MemoryType;
  priority: number;
  /** Base confidence for every match from this definition */
  baseConfidence: number;
  retention: "durable" | "session" | "short";
  patterns: RegExp[];
  /**
   * Build a canonical memory statement from a regex match.
   * Return null to discard the match (e.g. vague/short capture).
   * Confidence override is optional — defaults to baseConfidence.
   */
  buildMemory: (match: RegExpMatchArray) => {
    content: string;
    entities?: string[];
    confidence?: number;
  } | null;
}

// ── Tech-entity helpers ───────────────────────────────────────────────────────

const TECH_TERMS = [
  "Python","JavaScript","TypeScript","Java","Kotlin","Swift","Go","Golang","Rust",
  "Ruby","PHP","Elixir","Scala","C#","C\\+\\+","Haskell","Clojure","Dart","R",
  "React","Next\\.?js","Vue","Angular","Svelte","Solid","Remix","Nuxt",
  "Node(?:\\.js)?","Deno","Bun","Express","Fastify","Hono","NestJS","Django","FastAPI","Flask","Rails",
  "PostgreSQL","MySQL","SQLite","MongoDB","Redis","Cassandra","DynamoDB","Supabase","PlanetScale","Neon",
  "Firebase","Firestore","CockroachDB","Turso",
  "Docker","Kubernetes","Terraform","Ansible","Pulumi",
  "AWS","GCP","Azure","Vercel","Netlify","Cloudflare","Railway","Fly\\.io","Render",
  "GitHub","GitLab","Bitbucket","Linear","Notion","Jira","Slack","Discord",
  "OpenAI","Anthropic","LangChain","LlamaIndex","Pinecone","Weaviate","Qdrant","Milvus","Chroma",
  "Stripe","Twilio","Resend","SendGrid","Plaid","Algolia",
  "Prisma","Drizzle","Sequelize","TypeORM",
  "GraphQL","gRPC","tRPC","REST","WebSocket",
  "Kafka","RabbitMQ","NATS","SQS","Pub/Sub",
  "Elasticsearch","OpenSearch","Meilisearch","Typesense",
  "Tailwind","shadcn","Radix","Chakra","MUI","Ant Design",
  "Figma","Storybook","Playwright","Cypress","Vitest","Jest",
];

const TECH_PATTERN = new RegExp(
  `\\b(${TECH_TERMS.join("|")})\\b`,
  "gi"
);

export function extractTechEntities(text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(TECH_PATTERN.source, TECH_PATTERN.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return [...new Set(found)].slice(0, 6);
}

function containsTechEntity(text: string): boolean {
  const re = new RegExp(TECH_PATTERN.source, TECH_PATTERN.flags);
  return re.test(text);
}

// ── Guard helpers ─────────────────────────────────────────────────────────────

/** Words that indicate a match captured something useless */
const VAGUE_WORDS = new Set([
  "it","this","that","things","stuff","something","anything","everything",
  "a bit","a lot","more","less","better","worse","fine","good","bad","great",
]);

const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","in","on","at","to","for",
  "of","and","or","but","so","not","no","yes","if","as","by","up","out","new",
]);

/** True when the captured group is too vague to store as a memory */
function isVague(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 3) return true;
  if (VAGUE_WORDS.has(t)) return true;
  if (STOP_WORDS.has(t)) return true;
  // Single common word with no specific content
  if (/^(doing|working|trying|getting|using|making|building|learning|going|coming|having|going)$/.test(t)) return true;
  return false;
}

// ── Job role allowlist (for "I am a/an X" → factual memory) ──────────────────

const ROLE_PATTERN = /^(?:senior\s+|junior\s+|lead\s+|principal\s+|staff\s+|mid\s+)?(?:software\s+(?:engineer|developer)|(?:backend|frontend|fullstack|full[- ]stack)\s+(?:engineer|developer)?|mobile\s+developer|ios\s+developer|android\s+developer|web\s+developer|devops\s+engineer|sre|site\s+reliability\s+engineer|data\s+(?:scientist|engineer|analyst)|ml\s+engineer|ai\s+engineer|machine\s+learning\s+engineer|product\s+manager|ux\s+(?:designer|researcher)|ui\s+designer|designer|architect|solutions\s+architect|tech\s+lead|engineering\s+manager|vp\s+of\s+engineering|head\s+of\s+engineering|director\s+of\s+engineering|cto|ceo|coo|cpo|founder|co-founder|indie\s+hacker|freelancer|consultant|contractor|researcher|analyst|programmer|developer|engineer)$/i;

// ── Pattern definitions ───────────────────────────────────────────────────────

const IDENTITY_PATTERNS: PatternDef[] = [
  {
    type: "factual", priority: 15, baseConfidence: 0.97, retention: "durable",
    patterns: [
      /\bmy\s+name\s+is\s+([A-Za-z][A-Za-z\s\-']{0,40}?)(?=[,.]|$)/gi,
      /\bcall\s+me\s+([A-Za-z][A-Za-z\s\-']{0,25}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const name = m[1]?.trim();
      if (!name || name.length < 2 || STOP_WORDS.has(name.toLowerCase())) return null;
      return { content: `User's name is ${name}`, entities: [name] };
    },
  },
  {
    type: "factual", priority: 14, baseConfidence: 0.95, retention: "durable",
    patterns: [
      /\bI\s+work\s+(?:at|for|in)\s+([A-Za-z][A-Za-z0-9\s.\-&']{1,60}?)(?:\s+as\s+|[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const company = m[1]?.trim();
      if (!company || company.length < 2 || STOP_WORDS.has(company.toLowerCase())) return null;
      return { content: `User works at ${company}`, entities: [company] };
    },
  },
  {
    type: "factual", priority: 13, baseConfidence: 0.93, retention: "durable",
    patterns: [
      /\bI\s+am\s+(?:a|an)\s+([A-Za-z][A-Za-z\s\-]{2,50}?)\s+(?:at|for|working\s+at|with)\s+([A-Za-z][A-Za-z0-9\s.\-&']{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const role = m[1]?.trim();
      const company = m[2]?.trim();
      if (!role || !company) return null;
      return { content: `User is a ${role} at ${company}`, entities: [role, company] };
    },
  },
  // "I am a/an X" — only match known job roles to avoid noise
  {
    type: "factual", priority: 12, baseConfidence: 0.88, retention: "durable",
    patterns: [
      /\bI(?:'m|\s+am)\s+(?:a|an)\s+((?:(?:senior|junior|lead|principal|staff|mid)\s+)?[A-Za-z][A-Za-z\s\-]{3,60}?)(?=[,.\s]|$)/gi,
    ],
    buildMemory: (m) => {
      const role = m[1]?.trim();
      if (!role || !ROLE_PATTERN.test(role)) return null;
      return { content: `User is a ${role}`, entities: [role] };
    },
  },
  {
    type: "factual", priority: 11, baseConfidence: 0.95, retention: "durable",
    patterns: [
      /\bI\s+live\s+in\s+([A-Za-z][A-Za-z\s,\-]{2,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const place = m[1]?.trim();
      if (!place || isVague(place)) return null;
      return { content: `User lives in ${place}`, entities: [place] };
    },
  },
  {
    type: "factual", priority: 10, baseConfidence: 0.93, retention: "durable",
    patterns: [
      /\b(?:my|our)\s+(?:company|startup|org|organization)\s+is\s+(?:called\s+)?([A-Za-z][A-Za-z0-9\s.\-&']{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const name = m[1]?.trim();
      if (!name || STOP_WORDS.has(name.toLowerCase())) return null;
      return { content: `User's company is called ${name}`, entities: [name] };
    },
  },
  {
    type: "factual", priority: 10, baseConfidence: 0.92, retention: "durable",
    patterns: [
      /\b(?:my|our)\s+(?:product|app|service|project)\s+is\s+(?:called\s+)?([A-Za-z][A-Za-z0-9\s.\-&']{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const name = m[1]?.trim();
      if (!name || isVague(name)) return null;
      return { content: `User's product is called ${name}`, entities: [name] };
    },
  },
  {
    type: "factual", priority: 9, baseConfidence: 0.92, retention: "durable",
    patterns: [
      /\bI(?:'ve|\s+have)\s+(\d{1,2})\s+years?\s+(?:of\s+)?experience\s+(?:with|in|using)\s+([A-Za-z][A-Za-z0-9\s.\-+#]{1,50}?)(?=[,.]|$)/gi,
      /\b(\d{1,2})\s+years?\s+(?:of\s+)?experience\s+(?:with|in|using)\s+([A-Za-z][A-Za-z0-9\s.\-+#]{1,50}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const years = m[1]?.trim();
      const tech = m[2]?.trim();
      if (!years || !tech || isVague(tech)) return null;
      return { content: `User has ${years} years of experience with ${tech}`, entities: extractTechEntities(tech) };
    },
  },
  {
    type: "factual", priority: 9, baseConfidence: 0.90, retention: "durable",
    patterns: [
      /\bI\s+am\s+(?:the\s+)?(?:creator|owner|founder|co-founder|author)\s+of\s+([A-Za-z][A-Za-z0-9\s.\-&']{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const project = m[1]?.trim();
      if (!project || isVague(project)) return null;
      return { content: `User is the founder/creator of ${project}`, entities: [project] };
    },
  },
];

const SKILL_PATTERNS: PatternDef[] = [
  {
    type: "factual", priority: 8, baseConfidence: 0.88, retention: "durable",
    patterns: [
      /\bI\s+(?:code|program|develop|build)\s+(?:in|with|using)\s+([A-Za-z][A-Za-z0-9\s.,\-+#]{1,80}?)(?:\s+for\s+|\s+since\s+|[,.]|$)/gi,
      /\bI\s+specialize\s+in\s+([A-Za-z][A-Za-z0-9\s.\-+#]{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const tech = m[1]?.trim();
      if (!tech || tech.length < 2 || isVague(tech)) return null;
      return { content: `User codes in ${tech}`, entities: extractTechEntities(tech) };
    },
  },
  {
    type: "factual", priority: 8, baseConfidence: 0.88, retention: "durable",
    patterns: [
      /\b(?:my|our)\s+(?:tech\s+)?stack\s+(?:includes?|is|contains|uses?)\s+([A-Za-z][A-Za-z0-9\s.,\-+#]{2,120}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const stack = m[1]?.trim();
      if (!stack || isVague(stack)) return null;
      return { content: `User's tech stack includes ${stack}`, entities: extractTechEntities(stack) };
    },
  },
  // "I/we use X" — only when X contains a known tech entity (prevents generic noise)
  {
    type: "factual", priority: 7, baseConfidence: 0.82, retention: "durable",
    patterns: [
      /\b(?:I|we)\s+(?:use|run|operate|deploy)\s+([A-Za-z][A-Za-z0-9\s.,\-+#]{1,80}?)(?:\s+(?:for|as|in\s+production)|[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const tech = m[1]?.trim();
      if (!tech || !containsTechEntity(tech)) return null;
      return { content: `User uses ${tech}`, entities: extractTechEntities(tech) };
    },
  },
  {
    type: "factual", priority: 7, baseConfidence: 0.85, retention: "durable",
    patterns: [
      /\bbeen\s+using\s+([A-Za-z][A-Za-z0-9\s.\-+#]{1,50}?)\s+(?:for\s+\d|since\s+\d{4})/gi,
    ],
    buildMemory: (m) => {
      const tech = m[1]?.trim();
      if (!tech || isVague(tech)) return null;
      return { content: `User has been using ${tech}`, entities: extractTechEntities(tech) };
    },
  },
  {
    type: "factual", priority: 7, baseConfidence: 0.85, retention: "durable",
    patterns: [
      /\bcurrently\s+(?:using|running|deploying|built\s+on)\s+([A-Za-z][A-Za-z0-9\s.\-+#]{1,60}?)\s+(?:for|as|in\s+production)/gi,
      /\bwe\s+(?:are\s+)?(?:using|running|deploying)\s+([A-Za-z][A-Za-z0-9\s.\-+#]{1,60}?)\s+(?:for|as|in\s+production)/gi,
    ],
    buildMemory: (m) => {
      const tech = m[1]?.trim();
      if (!tech || !containsTechEntity(tech)) return null;
      return { content: `User's team uses ${tech} in production`, entities: extractTechEntities(tech) };
    },
  },
];

const PREFERENCE_PATTERNS: PatternDef[] = [
  {
    type: "preference", priority: 9, baseConfidence: 0.88, retention: "durable",
    patterns: [
      /\bI\s+(?:like|love|prefer|am\s+a\s+(?:big\s+)?fan\s+of)\s+([A-Za-z0-9][A-Za-z0-9\s.\-+'#]{1,80}?)(?:\s+over\s+|\s+instead\s+|[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const thing = m[1]?.trim();
      if (!thing || thing.length < 3 || isVague(thing)) return null;
      return { content: `User prefers ${thing}`, entities: extractTechEntities(thing) };
    },
  },
  {
    type: "preference", priority: 9, baseConfidence: 0.88, retention: "durable",
    patterns: [
      /\bI\s+(?:hate|dislike|can't\s+stand|don't\s+like|avoid|stopped\s+using)\s+([A-Za-z0-9][A-Za-z0-9\s.\-+'#]{1,80}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const thing = m[1]?.trim();
      if (!thing || thing.length < 3 || isVague(thing)) return null;
      return { content: `User dislikes ${thing}`, entities: extractTechEntities(thing) };
    },
  },
  {
    type: "preference", priority: 10, baseConfidence: 0.92, retention: "durable",
    patterns: [
      /\bmy\s+favorite\s+([A-Za-z][A-Za-z\s]{2,30}?)\s+is\s+([A-Za-z0-9][A-Za-z0-9\s.\-+'#]{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const category = m[1]?.trim();
      const thing = m[2]?.trim();
      if (!category || !thing || isVague(thing)) return null;
      return { content: `User's favorite ${category} is ${thing}`, entities: extractTechEntities(thing) };
    },
  },
  // Dark/light mode — only when the user is the subject
  {
    type: "preference", priority: 9, baseConfidence: 0.90, retention: "durable",
    patterns: [
      /\bI\s+(?:use|prefer|love|like|switched?\s+to)\s+(dark|light)\s+mode\b/gi,
    ],
    buildMemory: (m) => {
      const mode = m[1]?.trim().toLowerCase();
      return mode ? { content: `User uses ${mode} mode`, entities: [] } : null;
    },
  },
  {
    type: "preference", priority: 7, baseConfidence: 0.83, retention: "durable",
    patterns: [
      /\bI\s+(?:never|don't|won't)\s+(?:use|touch)\s+([A-Za-z0-9][A-Za-z0-9\s.\-+'#]{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const thing = m[1]?.trim();
      if (!thing || isVague(thing)) return null;
      return { content: `User never uses ${thing}`, entities: extractTechEntities(thing) };
    },
  },
];

const GOAL_PATTERNS: PatternDef[] = [
  {
    type: "goal", priority: 8, baseConfidence: 0.87, retention: "durable",
    patterns: [
      /\bI(?:'m|\s+am)\s+(?:currently\s+)?building\s+([A-Za-z][A-Za-z0-9\s.\-+#:']{3,100}?)(?=[,.]|$)/gi,
      /\bwe(?:'re|\s+are)\s+(?:currently\s+)?building\s+([A-Za-z][A-Za-z0-9\s.\-+#:']{3,100}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const thing = m[1]?.trim();
      if (!thing || thing.length < 4 || isVague(thing)) return null;
      const isWe = /^we/i.test(m[0] || "");
      return {
        content: `${isWe ? "User's team" : "User"} is building ${thing}`,
        entities: extractTechEntities(thing),
      };
    },
  },
  {
    type: "goal", priority: 7, baseConfidence: 0.83, retention: "durable",
    patterns: [
      /\bI\s+(?:want|would\s+like|am\s+planning|intend)\s+to\s+([A-Za-z][A-Za-z0-9\s.\-+#]{5,100}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const goal = m[1]?.trim();
      if (!goal || goal.length < 5 || isVague(goal)) return null;
      return { content: `User wants to ${goal}`, entities: extractTechEntities(goal) };
    },
  },
  {
    type: "goal", priority: 8, baseConfidence: 0.90, retention: "durable",
    patterns: [
      /\b(?:my|our)\s+goal\s+is\s+(?:to\s+)?([A-Za-z][A-Za-z0-9\s.\-+#]{5,100}?)(?=[,.]|$)/gi,
      /\b(?:my|our)\s+objective\s+is\s+(?:to\s+)?([A-Za-z][A-Za-z0-9\s.\-+#]{5,100}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const goal = m[1]?.trim();
      if (!goal || isVague(goal)) return null;
      return { content: `User's goal is to ${goal}`, entities: extractTechEntities(goal) };
    },
  },
  {
    type: "goal", priority: 6, baseConfidence: 0.80, retention: "session",
    patterns: [
      /\bI(?:'m|\s+am)\s+(?:trying|working)\s+to\s+(?:learn|build|create|fix|implement|migrate)\s+([A-Za-z][A-Za-z0-9\s.\-+#]{3,80}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const thing = m[1]?.trim();
      if (!thing || isVague(thing)) return null;
      return { content: `User is trying to build/learn ${thing}`, entities: extractTechEntities(thing) };
    },
  },
];

// Instructions: only patterns that are clearly directing the assistant
const INSTRUCTION_PATTERNS: PatternDef[] = [
  {
    type: "instruction", priority: 12, baseConfidence: 0.95, retention: "durable",
    patterns: [
      /\bfrom\s+now\s+on,?\s+(?:always\s+)?([A-Za-z][A-Za-z0-9\s.\-+'#,]{5,120}?)(?=[,.]|$)/gi,
      /\bgoing\s+forward,?\s+(?:always\s+)?([A-Za-z][A-Za-z0-9\s.\-+'#,]{5,120}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const instruction = m[1]?.trim();
      if (!instruction || instruction.length < 5) return null;
      return { content: `[Instruction] From now on: ${instruction}`, entities: [] };
    },
  },
  {
    type: "instruction", priority: 11, baseConfidence: 0.95, retention: "durable",
    patterns: [
      /\balways\s+(?:use|include|start|end|respond\s+(?:with|in)|write\s+in|format)\s+([A-Za-z0-9][A-Za-z0-9\s.\-+'#,]{2,80}?)\s+(?:in\s+(?:your\s+)?(?:responses?|replies?|answers?)|when\s+(?:respond|answer|reply))(?=[,.]|$)/gi,
      /\bnever\s+(?:use|include|add|write|say)\s+([A-Za-z0-9][A-Za-z0-9\s.\-+'#,]{2,80}?)\s+(?:in\s+(?:your\s+)?(?:responses?|replies?|answers?))(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const instruction = m[0]?.trim();
      if (!instruction || instruction.length < 10) return null;
      return { content: `[Instruction] ${instruction}`, entities: [] };
    },
  },
  {
    type: "instruction", priority: 10, baseConfidence: 0.90, retention: "durable",
    patterns: [
      /\bplease\s+(?:always\s+)?(?:respond\s+(?:in|with)|use|write\s+in|format\s+(?:your\s+)?(?:responses?|answers?)\s+(?:as|in|with))\s+([A-Za-z0-9][A-Za-z0-9\s.\-+'#]{2,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const instruction = m[0]?.trim();
      if (!instruction || instruction.length < 15) return null;
      return { content: `[Instruction] ${instruction}`, entities: [] };
    },
  },
];

const OPINION_PATTERNS: PatternDef[] = [
  {
    type: "opinion", priority: 6, baseConfidence: 0.80, retention: "durable",
    patterns: [
      /\bI\s+(?:think|believe)\s+(?:that\s+)?([A-Za-z][A-Za-z0-9\s.\-+#:,'"]{8,150}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const opinion = m[1]?.trim();
      if (!opinion || opinion.length < 8 || isVague(opinion)) return null;
      return { content: `User believes ${opinion}`, entities: extractTechEntities(opinion) };
    },
  },
  {
    type: "opinion", priority: 7, baseConfidence: 0.82, retention: "durable",
    patterns: [
      /\bin\s+my\s+(?:opinion|view|experience),?\s+([A-Za-z][A-Za-z0-9\s.\-+#:,'"]{8,150}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const opinion = m[1]?.trim();
      if (!opinion || isVague(opinion)) return null;
      return { content: `User's opinion: ${opinion}`, entities: extractTechEntities(opinion) };
    },
  },
];

const RELATIONSHIP_PATTERNS: PatternDef[] = [
  {
    type: "relationship", priority: 7, baseConfidence: 0.90, retention: "durable",
    patterns: [
      /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\s+reports\s+to\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)(?=[,.]|$)/g,
    ],
    buildMemory: (m) => {
      const from = m[1]?.trim();
      const to = m[2]?.trim();
      if (!from || !to) return null;
      return { content: `${from} reports to ${to}`, entities: [from, to] };
    },
  },
  {
    type: "relationship", priority: 7, baseConfidence: 0.88, retention: "durable",
    patterns: [
      /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\s+is\s+(?:my|the\s+team's)\s+(?:manager|boss|lead|tech\s+lead|head)(?=[,.]|$)/g,
    ],
    buildMemory: (m) => {
      const name = m[1]?.trim();
      if (!name) return null;
      return { content: `${name} is user's manager`, entities: [name] };
    },
  },
  {
    type: "relationship", priority: 6, baseConfidence: 0.85, retention: "durable",
    patterns: [
      /\bI\s+(?:manage|lead|am\s+the\s+lead\s+of)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9\s\-]{2,50}?)\s+(?:team|project|squad|group)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const team = m[1]?.trim();
      if (!team || isVague(team)) return null;
      return { content: `User manages the ${team} team`, entities: [team] };
    },
  },
];

const EVENT_PATTERNS: PatternDef[] = [
  {
    type: "event", priority: 5, baseConfidence: 0.87, retention: "session",
    patterns: [
      /\bI\s+(?:just\s+)?(?:joined|moved\s+to|left|started\s+at)\s+([A-Za-z][A-Za-z0-9\s.\-&']{1,60}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const full = m[0]?.trim();
      const place = m[1]?.trim();
      if (!full || !place) return null;
      return { content: `User recently: ${full}`, entities: [place] };
    },
  },
  {
    type: "event", priority: 5, baseConfidence: 0.83, retention: "session",
    patterns: [
      /\bwe\s+(?:just\s+)?(?:shipped|launched|released|deployed)\s+([A-Za-z][A-Za-z0-9\s.\-+#:'"]{2,100}?)(?=[,.]|$)/gi,
    ],
    buildMemory: (m) => {
      const thing = m[1]?.trim();
      if (!thing || isVague(thing)) return null;
      return { content: `User's team shipped ${thing}`, entities: extractTechEntities(thing) };
    },
  },
];

const SESSION_STATE_PATTERNS: PatternDef[] = [
  {
    type: "decision", priority: 11, baseConfidence: 0.9, retention: "durable",
    patterns: [
      /\b(?:we|i)\s+(?:decided|choose|chose|are\s+going\s+with|will\s+use)\s+(.+?)(?=[.!?]|$)/gi,
    ],
    buildMemory: (m) => {
      const decision = m[1]?.trim();
      if (!decision || isVague(decision)) return null;
      return { content: `Decision: ${decision}`, entities: extractTechEntities(decision) };
    },
  },
  {
    type: "constraint", priority: 11, baseConfidence: 0.88, retention: "durable",
    patterns: [
      /\b(?:we|it|this|the project)\s+(?:must|has to|needs to|cannot|can't)\s+(.+?)(?=[.!?]|$)/gi,
    ],
    buildMemory: (m) => {
      const constraint = m[1]?.trim();
      if (!constraint || isVague(constraint)) return null;
      return { content: `Constraint: ${constraint}`, entities: extractTechEntities(constraint) };
    },
  },
  {
    type: "solution", priority: 10, baseConfidence: 0.86, retention: "durable",
    patterns: [
      /\b(?:we|i)\s+(?:fixed|resolved|solved)\s+(?:it\s+)?(?:by|with)\s+(.+?)(?=[.!?]|$)/gi,
    ],
    buildMemory: (m) => {
      const solution = m[1]?.trim();
      if (!solution || isVague(solution)) return null;
      return { content: `Solution: ${solution}`, entities: extractTechEntities(solution) };
    },
  },
  {
    type: "workflow", priority: 9, baseConfidence: 0.84, retention: "durable",
    patterns: [
      /\b(?:my|our)\s+workflow\s+(?:is|uses|relies on)\s+(.+?)(?=[.!?]|$)/gi,
    ],
    buildMemory: (m) => {
      const workflow = m[1]?.trim();
      if (!workflow || isVague(workflow)) return null;
      return { content: `Workflow: ${workflow}`, entities: extractTechEntities(workflow) };
    },
  },
  {
    type: "project_state", priority: 9, baseConfidence: 0.82, retention: "session",
    patterns: [
      /\b(?:the|our)\s+project\s+(?:is|currently|now)\s+(.+?)(?=[.!?]|$)/gi,
    ],
    buildMemory: (m) => {
      const state = m[1]?.trim();
      if (!state || isVague(state)) return null;
      return { content: `Project state: ${state}`, entities: extractTechEntities(state) };
    },
  },
  {
    type: "correction", priority: 12, baseConfidence: 0.9, retention: "durable",
    patterns: [
      /\b(?:actually|correction|update)[:,]?\s+(.+?)(?=[.!?]|$)/gi,
    ],
    buildMemory: (m) => {
      const correction = m[1]?.trim();
      if (!correction || isVague(correction)) return null;
      return { content: `Correction: ${correction}`, entities: extractTechEntities(correction) };
    },
  },
];

// ── All patterns sorted by priority (high → low) ─────────────────────────────

const ALL_PATTERN_DEFS: PatternDef[] = [
  ...IDENTITY_PATTERNS,
  ...SKILL_PATTERNS,
  ...PREFERENCE_PATTERNS,
  ...GOAL_PATTERNS,
  ...INSTRUCTION_PATTERNS,
  ...OPINION_PATTERNS,
  ...RELATIONSHIP_PATTERNS,
  ...EVENT_PATTERNS,
  ...SESSION_STATE_PATTERNS,
].sort((a, b) => b.priority - a.priority);

// ── Deduplification key ───────────────────────────────────────────────────────

const DEDUPE_STOP = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall","can",
  "to","of","in","for","on","with","at","by","from","as","into","about",
  "i","my","me","user","users",
]);

function normalizeDedupeKey(type: string, content: string): string {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2 && !DEDUPE_STOP.has(w))
    .sort()
    .slice(0, 8);
  return `${type}:${words.join(":")}`;
}

// ── Main extraction ───────────────────────────────────────────────────────────

export function extractExplicitMemory(message: string): PatternMatch[] {
  // Cap input length to protect against ReDoS on huge messages
  const input = message.length > 4000 ? message.slice(0, 4000) : message;

  const seen = new Map<string, PatternMatch>();

  for (const def of ALL_PATTERN_DEFS) {
    for (const regex of def.patterns) {
      // Always create a fresh copy of the regex to reset lastIndex
      const re = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;

      while ((match = re.exec(input)) !== null) {
        // Prevent infinite loop on zero-length matches
        if (match[0].length === 0) { re.lastIndex++; continue; }

        const built = def.buildMemory(match);
        if (!built) continue;

        const content = built.content.trim();
        if (content.length < 10) continue;

        const confidence = Math.min(1, Math.max(0, built.confidence ?? def.baseConfidence));
        const key = normalizeDedupeKey(def.type, content);

        const existing = seen.get(key);
        if (!existing || confidence > existing.confidence) {
          seen.set(key, {
            type: def.type,
            content,
            confidence,
            matchedPattern: regex.source,
            entities: built.entities ?? [],
            retention: def.retention,
          });
        }
      }
    }
  }

  // Return sorted by confidence descending
  return Array.from(seen.values()).sort((a, b) => b.confidence - a.confidence);
}

/**
 * Returns true only if there is at least one high-confidence explicit match.
 * Avoids treating every vague regex hit as a "confirmed explicit memory."
 */
export function isExplicitMemory(message: string): boolean {
  return extractExplicitMemory(message).some(m => m.confidence >= 0.82);
}
