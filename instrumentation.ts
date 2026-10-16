// Runs once when the server starts (Next.js instrumentation hook)
export async function register() {
  // K_SERVICE is set on Cloud Run
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.K_SERVICE) return;
  const { installStructuredLogging } = await import("./lib/logging");
  installStructuredLogging();
}
