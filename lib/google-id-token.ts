import crypto from "crypto";

// Google-signed ID tokens: a GCP service account (Cloud Run, Cloud Tasks, Cloud Scheduler) calling
// us. RS256, keys from Google's JWKS; the caller is pinned by audience and service account email.

const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

let cache: { keys: Jwk[]; fetchedAt: number } | null = null;
let lastForced = 0;

// `force` (an unknown key id) refetches at most once a minute, so junk tokens can't make us
// hammer Google; a failed fetch keeps the keys we had
async function googleKeys(force: boolean): Promise<Jwk[]> {
  const fresh = cache && Date.now() - cache.fetchedAt < 60 * 60 * 1000;
  if (cache && (force ? Date.now() - lastForced < 60_000 : fresh)) return cache.keys;
  if (force) lastForced = Date.now();
  try {
    const res = await fetch(GOOGLE_CERTS, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`google certs ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    cache = { keys: body.keys ?? [], fetchedAt: Date.now() };
  } catch (err) {
    if (!cache) throw err;
    console.error("google certs refresh failed, keeping the old keys:", String(err).slice(0, 200));
  }
  return cache.keys;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function verifyGoogleIdToken(
  token: string,
  expected: { audience: string; email: string }
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return false;

  let jwk = (await googleKeys(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid); // key rotation
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false;

  const key = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"))) return false;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return (
    ISSUERS.has(String(payload.iss)) &&
    aud.includes(expected.audience) &&
    typeof payload.exp === "number" && payload.exp > now - 30 &&
    payload.email === expected.email &&
    payload.email_verified === true
  );
}

export async function bearerIsGoogleCaller(
  authHeader: string | null,
  expected: { audience: string; email: string }
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    return await verifyGoogleIdToken(authHeader.slice("Bearer ".length).trim(), expected);
  } catch (err) {
    console.error("Google ID token verification failed:", err);
    return false;
  }
}
