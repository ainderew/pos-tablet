import type { CapacitorConfig } from "@capacitor/cli"

// The Android project (apps/tablet/android) is generated in Phase 4 with `npx cap add android`
const config: CapacitorConfig = {
  appId: "com.generalstore.pos.tablet",
  appName: "General Store POS",
  webDir: "dist",
}

export default config
