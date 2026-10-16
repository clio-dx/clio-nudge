import { register } from "node:module";

// Real Firestore, in the separate "nudge-test" database (never the production one)
process.env.FIRESTORE_DATABASE = "nudge-test";
process.env.NUDGE_AI_LOG = "off";
register("../hooks.mjs", import.meta.url);
