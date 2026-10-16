import { register } from "node:module";

// Local admin scripts against the production Firestore (read the code before running!):
//   GOOGLE_APPLICATION_CREDENTIALS=<deployer key> node --import ./scripts/register-prod.mjs scripts/<x>.ts
process.env.NUDGE_AI_LOG = "off";
register("../tests/hooks-prod.mjs", import.meta.url);
