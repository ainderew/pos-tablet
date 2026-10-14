import { VAT_RATE } from "@pos/core"

export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
      <h1>General Store POS — Tablet</h1>
      <p>Phase 0 scaffold. The offline POS arrives in Phase 4; see docs/architecture.md.</p>
      <p>Shared rules loaded from @pos/core (VAT {VAT_RATE * 100}%).</p>
    </main>
  )
}
