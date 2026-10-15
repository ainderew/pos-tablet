import { defineConfig } from "vitest/config"

// Each test file boots PGlite (Postgres in WebAssembly) and applies every migration: a few seconds,
// more on a busy CI runner, so allow more than vitest's 10 s default for setup
export default defineConfig({
  test: { hookTimeout: 60_000, testTimeout: 30_000 },
})
