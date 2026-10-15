# POS-bir fixture generators

These record POS-bir's (the PC app's) real behaviour into the `../pc-*-parity.json` fixtures that
`@pos/core`'s parity tests replay. They are Jest tests for **POS-bir's** test setup, not this repo's,
so they're named `*.generator.ts` and vitest never runs them.

Run one from a POS-bir checkout, against a scratch SQLite file (never a real `pos.db`):

```bash
cd /path/to/POS-bir
SQLITE_PATH=/tmp/golden.db npx jest -i --rootDir . --roots /path/to/pos-tablet/packages/core/test/fixtures/generators --testRegex 'sale\.generator\.ts$' --modulePaths ./node_modules
```

Paths inside the files are absolute for the machine they were written on (`/Users/drew/Desktop/projects/...`);
adjust them if the repos live elsewhere. Commit a regenerated fixture together with the `@pos/core`
change that matches it, and keep `generatedFrom` (the POS-bir commit) in the file.

The receipt fixture is regenerated differently: `UPDATE_RECEIPT_FIXTURE=1` with a POS-bir checkout
(see `test/receipt-parity.test.ts`).
