import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  // Each test file boots PGlite and applies every migration (slower on a busy CI runner)
  test: { environment: "node", hookTimeout: 60_000, testTimeout: 30_000 },
})
