import type { NextConfig } from "next"
import path from "node:path"

// Every response: no framing (clickjacking), no MIME sniffing, no full URLs leaked to other sites
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
]

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }]
  },
  // Trace workspace packages from the repo root so the standalone build includes them
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@pos/core", "@pos/db"],
}

export default nextConfig
