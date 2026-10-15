import type { NextConfig } from "next"
import path from "node:path"

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace workspace packages from the repo root so the standalone build includes them
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@pos/core", "@pos/db"],
}

export default nextConfig
