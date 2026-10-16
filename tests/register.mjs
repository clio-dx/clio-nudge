import { register } from "node:module";

// In-memory store, jobs run in place, no Secret Manager, fast AI retries
process.env.NUDGE_STORE = "memory";
process.env.AI_RETRY_BASE_MS = "1";
process.env.SLACK_SIGNING_SECRET ??= "test-signing-secret";

register("./hooks.mjs", import.meta.url);
