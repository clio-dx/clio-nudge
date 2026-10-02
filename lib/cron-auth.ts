import crypto from "crypto";

// Two callers may trigger /api/cron/tick:
//  - Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`
//  - the hourly GitHub Actions workflow, which sends a short-lived GitHub OIDC token —
//    no shared secret to configure, and only this repo's main-branch workflow can mint it.

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_AUDIENCE = "clio-nudge-tick";
const GITHUB_REPOSITORY = process.env.NUDGE_GITHUB_REPOSITORY || "clio-dx/clio-nudge";
const GITHUB_WORKFLOW = ".github/workflows/nudge-tick.yml";

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function githubKeys(force: boolean): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch(`${GITHUB_ISSUER}/.well-known/jwks`);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function verifyGithubOidc(token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return false;

  let jwk = (await githubKeys(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await githubKeys(true)).find((k) => k.kid === header.kid); // key rotation
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false;

  const key = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  const valid = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"));
  if (!valid) return false;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return (
    payload.iss === GITHUB_ISSUER &&
    aud.includes(GITHUB_OIDC_AUDIENCE) &&
    typeof payload.exp === "number" && payload.exp > now - 30 &&
    (typeof payload.nbf !== "number" || payload.nbf <= now + 60) &&
    payload.repository === GITHUB_REPOSITORY &&
    payload.ref === "refs/heads/main" &&
    typeof payload.workflow_ref === "string" &&
    payload.workflow_ref.startsWith(`${GITHUB_REPOSITORY}/${GITHUB_WORKFLOW}@`) &&
    (payload.event_name === "schedule" || payload.event_name === "workflow_dispatch")
  );
}

// Returns which trigger called us, or null if unauthorized
export async function authorizeCron(authHeader: string | null): Promise<"vercel-cron" | "github-actions" | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const a = Buffer.from(token);
    const b = Buffer.from(secret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return "vercel-cron";
  }

  try {
    if (await verifyGithubOidc(token)) return "github-actions";
  } catch (err) {
    console.error("GitHub OIDC verification failed:", err);
  }
  return null;
}
