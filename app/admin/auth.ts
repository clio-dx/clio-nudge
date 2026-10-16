import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isAdminService, verifyIapAssertion, type Admin } from "@/lib/admin-auth";

// Only on the nudge-admin service, and only for someone IAP signed in (see lib/admin-auth.ts)
export async function requireAdmin(): Promise<Admin> {
  if (!isAdminService()) notFound();
  const admin = await verifyIapAssertion((await headers()).get("x-goog-iap-jwt-assertion"));
  if (!admin) notFound();
  return admin;
}
