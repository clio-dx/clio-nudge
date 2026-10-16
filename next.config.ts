import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run image: .next/standalone + static files (Dockerfile)
  output: "standalone",
  // gRPC + proto files: loaded from node_modules as they are, not bundled
  serverExternalPackages: ["@google-cloud/firestore", "google-auth-library"],
};

export default nextConfig;
