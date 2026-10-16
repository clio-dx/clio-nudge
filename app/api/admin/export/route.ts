import { NextRequest, NextResponse } from "next/server";
import { bearerIsGoogleCaller } from "@/lib/google-id-token";
import { buildExport, GCP_RUNTIME_SA, isExportLocked, isFrozen, setMigrationState } from "@/lib/migration";
import { APP_URL } from "@/lib/messages";

// The GCP side of the move (docs/gcp-migration.md) pulls all data and the Slack app secrets
// here, then freezes this deployment. Only the GCP runtime service account can call it.
export const maxDuration = 60;

const authorized = (req: NextRequest) =>
  bearerIsGoogleCaller(req.headers.get("authorization"), {
    audience: `${APP_URL}/api/admin/export`,
    email: GCP_RUNTIME_SA,
  });

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (await isExportLocked()) return NextResponse.json({ error: "Export is locked" }, { status: 410 });
  const data = await buildExport();
  console.log("export", JSON.stringify({ users: data.users.length, followups: data.followups.length }));
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action !== "freeze" && action !== "unfreeze" && action !== "lock") {
    return NextResponse.json({ error: "action must be freeze, unfreeze or lock" }, { status: 400 });
  }
  await setMigrationState(action);
  console.log("migration state", action);
  return NextResponse.json({ ok: true, action, frozen: await isFrozen(), locked: await isExportLocked() });
}
