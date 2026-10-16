import { NextRequest, NextResponse } from "next/server";
import { isAdminService, verifyIapAssertion } from "@/lib/admin-auth";
import { feedbackJsonl, tuningJsonl } from "@/lib/feedback";

// feedback.jsonl: every feedback with the AI calls about that message
// tuning.jsonl: Vertex AI supervised-tuning examples where the right answer is clear
export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const notFound = () => new NextResponse("Not found", { status: 404 });
  if (!isAdminService() || !(await verifyIapAssertion(req.headers.get("x-goog-iap-jwt-assertion")))) return notFound();
  const { file } = await params;
  const body = file === "feedback.jsonl" ? await feedbackJsonl() : file === "tuning.jsonl" ? await tuningJsonl() : null;
  if (body === null) return notFound();
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="nudge-${file}"`,
      "Cache-Control": "no-store",
    },
  });
}
