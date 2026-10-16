// The admin pages only exist on the nudge-admin service (NUDGE_ROLE=admin), which sits behind IAP:
// only team-dx@ and yoonchul@ get through. The page checks IAP's signed header as well, so a
// request that somehow bypassed IAP (or a forged header) gets nothing.
import { OAuth2Client } from "google-auth-library";

const IAP_ISSUER = "https://cloud.google.com/iap";
// Who may see the pages once IAP let them in (IAP itself enforces the group membership)
const allowedDomain = () => process.env.NUDGE_ADMIN_DOMAIN || "clio.co.kr";

const client = new OAuth2Client();
let keys: { keys: Record<string, string>; at: number } | null = null;

async function iapKeys(force = false): Promise<Record<string, string>> {
  if (!force && keys && Date.now() - keys.at < 60 * 60 * 1000) return keys.keys;
  const res = await client.getIapPublicKeysAsync();
  keys = { keys: res.pubkeys as unknown as Record<string, string>, at: Date.now() };
  return keys.keys;
}

export const isAdminService = () => process.env.NUDGE_ROLE === "admin";

export interface Admin {
  email: string;
}

// The signed-in admin, or null. `audience` is pinned with NUDGE_IAP_AUDIENCE once known; until
// then the audience seen is logged so it can be set.
export async function verifyIapAssertion(assertion: string | null): Promise<Admin | null> {
  if (!assertion) return null;
  const audience = process.env.NUDGE_IAP_AUDIENCE || undefined;
  try {
    let ticket;
    try {
      ticket = await client.verifySignedJwtWithCertsAsync(assertion, await iapKeys(), audience, [IAP_ISSUER]);
    } catch {
      ticket = await client.verifySignedJwtWithCertsAsync(assertion, await iapKeys(true), audience, [IAP_ISSUER]); // key rotation
    }
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();
    if (!audience) console.log("IAP audience (set NUDGE_IAP_AUDIENCE):", JSON.stringify(payload?.aud));
    if (!email || !email.endsWith(`@${allowedDomain()}`)) return null;
    return { email };
  } catch (err) {
    console.error("IAP assertion rejected:", String(err).slice(0, 200));
    return null;
  }
}
