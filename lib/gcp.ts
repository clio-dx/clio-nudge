// GCP plumbing shared by the store, background tasks, AI and admin pages. On Cloud Run every call
// runs as the nudge-runtime service account (metadata server); locally, as whatever
// GOOGLE_APPLICATION_CREDENTIALS points to.
import { GoogleAuth } from "google-auth-library";

export const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "clio-nudge";
export const REGION = process.env.NUDGE_REGION || "asia-northeast3";
export const RUNTIME_SA = process.env.NUDGE_RUNTIME_SA || `nudge-runtime@${PROJECT_ID}.iam.gserviceaccount.com`;

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

export class GcpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// JSON call to a Google REST API as this service
export async function gcpFetch<T>(url: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new GcpError(`${init.method ?? "GET"} ${url.split("?")[0]} → ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

// A Google-signed ID token for calling `audience` (e.g. the old Vercel deployment) as this service
export async function idTokenFor(audience: string): Promise<string> {
  const client = await auth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const value = headers instanceof Headers ? headers.get("authorization") : (headers as Record<string, string>).Authorization;
  if (!value?.startsWith("Bearer ")) throw new Error("no ID token");
  return value.slice("Bearer ".length);
}

// ---------------------------------------------------------------------------
// Secret Manager. Env vars win (local dev, tests); otherwise the latest version, cached briefly.

const SECRET_TTL_MS = 10 * 60 * 1000;
const secretCache = new Map<string, { value: string; at: number }>();

export async function getSecret(name: string, envVar: string): Promise<string | undefined> {
  if (process.env[envVar]) return process.env[envVar];
  if (process.env.NUDGE_SECRETS !== "gcp") return undefined;
  const cached = secretCache.get(name);
  if (cached && Date.now() - cached.at < SECRET_TTL_MS) return cached.value;
  try {
    const res = await gcpFetch<{ payload?: { data?: string } }>(
      `https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${name}/versions/latest:access`
    );
    const value = Buffer.from(res.payload?.data ?? "", "base64").toString("utf8");
    if (value) secretCache.set(name, { value, at: Date.now() });
    return value || undefined;
  } catch (err) {
    // No version yet (before the migration copied it), or Secret Manager is unreachable
    console.error(`secret ${name} unavailable:`, String(err).slice(0, 300));
    return cached?.value;
  }
}

export async function putSecret(name: string, value: string): Promise<boolean> {
  const current = await getSecret(name, "__never__").catch(() => undefined);
  if (current === value) return false;
  await gcpFetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${name}:addVersion`, {
    body: { payload: { data: Buffer.from(value, "utf8").toString("base64") } },
  });
  secretCache.set(name, { value, at: Date.now() });
  return true;
}

export const slackSigningSecret = () => getSecret("slack-signing-secret", "SLACK_SIGNING_SECRET");
export const slackClientId = () => getSecret("slack-client-id", "SLACK_CLIENT_ID");
export const slackClientSecret = () => getSecret("slack-client-secret", "SLACK_CLIENT_SECRET");
