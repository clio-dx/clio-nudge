// Module resolution for tests run with plain node (type stripping):
//  - "@/x" → <repo>/x.ts, extension-less relative imports → .ts
//  - external services (Slack, Vertex AI) → in-memory fakes in tests/mocks; the store runs in
//    memory (NUDGE_STORE=memory, lib/store/backend.ts)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCKS = {
  "@slack/web-api": "tests/mocks/slack-web-api.ts",
  "@/lib/vertex": "tests/mocks/ai.ts",
};

function asTs(file) {
  if (path.extname(file)) return file;
  if (fs.existsSync(`${file}.ts`)) return `${file}.ts`;
  if (fs.existsSync(`${file}.tsx`)) return `${file}.tsx`;
  return file;
}

export async function resolve(specifier, context, next) {
  if (MOCKS[specifier]) {
    return { url: pathToFileURL(path.join(root, MOCKS[specifier])).href, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    return { url: pathToFileURL(asTs(path.join(root, specifier.slice(2)))).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parent = path.dirname(fileURLToPath(context.parentURL));
    return { url: pathToFileURL(asTs(path.resolve(parent, specifier))).href, shortCircuit: true };
  }
  return next(specifier, context);
}
