# Golden parity fixtures

Recorded from POS-bir (the PC app) so `@pos/core` provably computes the same results. Each file
says which POS-bir commit produced it (`generatedFrom`).

- `pc-sale-parity.json`: 24 scenarios run through POS-bir's real `POST /api/transactions` against a
  fresh SQLite database. They cover mixed tax categories, wholesale thresholds, weighed items,
  SC/PWD splits, e-wallet/card references, store credit, and every rejection path. Each records the
  request, response, stock afterwards, and credit ledger.
- `pc-void-parity.json`: 9 scenarios run through POS-bir's real sale route, then
  `POST /api/transactions/void`. They cover mixed categories, SC/PWD, weighed + wholesale lines,
  e-wallet, store credit (including a reversal that leaves the store owing the customer), sequential
  CN numbering, and both rejections (already voided, voiding a credit note). Each step records the
  original row before the void, the credit note, stock, balances and ledger afterwards.
- `pc-shift-z-parity.json`: one continuous run through POS-bir's real `POST /api/shifts/current`,
  `POST /api/transactions`, `POST /api/transactions/void`, `POST /api/cash-movements`,
  `POST /api/shifts/close` and `GET`/`POST /api/reports/z-reading`, over three business days. It
  covers three shifts with CASH/GCASH/MAYA/CARD/STORE_CREDIT and SC/PWD sales, voids in the same
  shift, of a previous shift's sale, and of a sale from before the previous Z, every cash movement
  type, four Z-readings (the GT accumulates and goes down, the counter increments, one is empty, one
  continues an upgraded install's chain), and the open/movement/close rejections. Each step records
  the request, status, response or resulting row, the shift that was open, and for a close its audit
  log (per-method variances, counters at close). The final tables are included. Because SQLite's
  `datetime('now')` has one-second resolution, the generator re-stamps each step's rows on a
  synthetic clock one minute apart, and stubs `crypto.randomUUID` with a counter so ids are stable.

To regenerate after a pricing or tax change in POS-bir, run the generator test from a POS-bir
checkout with `SQLITE_PATH` set to a scratch database, then commit the new JSON together with the
`@pos/core` change that matches it.

- `pc-payment-parity.json`: 9 scenarios run through POS-bir's real `POST /api/customers/payment`:
  cash during a shift (adds CASH_IN), e-wallet with reference and notes, overpayment, a blocked
  customer paying back within the limit, and rejections. Two scenarios record POS-bir bugs that
  `buildCreditPayment` deliberately fixes (an unrounded balance, and a negative amount increasing the
  debt); the test lists them in `INTENDED_DIFFERENCES`.

