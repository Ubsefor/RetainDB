/**
 * Load .env before any other module runs (so OPENAI_API_KEY, DATABASE_URL, etc. are set).
 * Must be the first import in index.ts.
 */
import { config } from "dotenv";

config({ path: ".env" });
config({ path: "src/.env" });
