# Golden parity fixtures

Recorded from POS-bir (the PC app) so `@pos/core` provably computes the same results. Each file
says which POS-bir commit produced it (`generatedFrom`).

- `pc-sale-parity.json`: 24 scenarios run through POS-bir's real `POST /api/transactions` against a
  fresh SQLite database. They cover mixed tax categories, wholesale thresholds, weighed items,
  SC/PWD splits, e-wallet/card references, store credit, and every rejection path. Each records the
  request, response, stock afterwards, and credit ledger.

To regenerate after a pricing or tax change in POS-bir, run the generator test from a POS-bir
checkout with `SQLITE_PATH` set to a scratch database, then commit the new JSON together with the
`@pos/core` change that matches it.
