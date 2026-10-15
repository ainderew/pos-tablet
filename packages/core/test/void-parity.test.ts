// Golden parity: fixtures/pc-void-parity.json records POS-bir's real sale + void routes. buildVoid
// must issue the same credit notes, restore the same stock, reverse store credit identically, and
// refuse the same voids.
import { describe, expect, it } from "vitest"
import {
  AuditLogRecordSchema,
  buildVoid,
  CreditLedgerEntryRecordSchema,
  StockMovementRecordSchema,
  TransactionRecordSchema,
} from "../src"
import type { TransactionItemRecord, TransactionRecord, VoidErrorCode } from "../src"
import fixtures from "./fixtures/pc-void-parity.json"

type Row = Record<string, any>
interface Step {
  reason: string | null
  before: { stock: Record<string, number>; customers: Record<string, number>; original: Row }
  status: number
  response: Row
  stockAfter: Record<string, number>
  customersAfter: Record<string, number>
  ledger: Row[]
}
interface Scenario { name: string; sales: Row[]; items: Row[]; steps: Step[] }

const PC_ERRORS: [RegExp, VoidErrorCode][] = [
  [/already voided/, "ALREADY_VOIDED"],
  [/Only completed sales/, "NOT_A_SALE"],
  [/Customer for store credit sale not found/, "CUSTOMER_NOT_FOUND"],
]

// A POS-bir transactions row as a pos-tablet record (POS-bir stores VOIDED on the row; here it's derived).
// A credit note row links back to its sale through the sale's invoice number.
const toRecord = (row: Row, sales: Row[]): TransactionRecord => {
  const isCreditNote = row.transaction_type === "VOID_REFUND"
  const record = {
  id: row.id,
  store_id: "store-1",
  terminal_id: "terminal-1",
  device_seq: 1,
  created_at: new Date(row.created_at.replace(" ", "T") + "Z").toISOString(),
  shift_id: "shift-1",
  cashier_id: null,
  invoice_number: row.invoice_number,
  transaction_type: row.transaction_type,
  status: isCreditNote ? "REFUND" : "PAID",
  original_transaction_id: isCreditNote ? sales.find((s) => s.invoice_number === row.reference_number)!.id : null,
  void_reason: isCreditNote ? row.void_reason : null,
  authorized_by: isCreditNote ? row.void_authorized_by : null,
  gross_sales: row.gross_sales,
  vatable_sales: row.vatable_sales,
  vat_amount: row.vat_amount,
  vat_exempt_sales: row.vat_exempt_sales,
  zero_rated_sales: row.zero_rated_sales,
  total_discount: row.total_discount,
  net_sales: row.net_sales,
  pax_count: row.pax_count,
  senior_count: row.senior_count,
  sc_pwd_id: row.sc_pwd_id,
  sc_pwd_name: row.sc_pwd_name,
  payment_method: row.payment_method,
  amount_tendered: row.amount_tendered,
  change_amount: row.change_amount,
  reference_number: row.reference_number,
  }
  return TransactionRecordSchema.parse(record)
}

const scenarios = (fixtures as unknown as { manager: string; scenarios: Scenario[] }).scenarios
const manager = (fixtures as unknown as { manager: string }).manager

describe(`buildVoid matches POS-bir (${(fixtures as any).generatedFrom})`, () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    let issued = 0
    for (const step of s.steps) {
      const original = toRecord(step.before.original, s.sales)
      const items: TransactionItemRecord[] = s.items
        .filter((i) => i.transaction_id === original.id)
        .map((i) => ({
          id: i.id,
          store_id: "store-1",
          terminal_id: "terminal-1",
          device_seq: 2,
          created_at: original.created_at,
          transaction_id: i.transaction_id,
          product_id: i.product_id,
          product_name: i.product_name,
          unit_type: i.unit_type,
          quantity_sold: i.quantity_sold,
          price_at_sale: i.price_at_sale,
          cost_at_sale: i.cost_at_sale,
          tax_category: i.tax_category,
        }))
      const customerId = original.payment_method === "STORE_CREDIT" ? original.reference_number : null
      let n = 0
      let seq = 500
      const result = buildVoid(
        { authorizedBy: manager, reason: step.reason },
        {
          openShift: { id: "shift-2", store_id: "store-1", terminal_id: "terminal-1" },
          original,
          items,
          alreadyVoided: step.before.original.status === "VOIDED",
          customer: customerId ? { id: customerId, current_debt_balance: step.before.customers[customerId] } : null,
        },
        {
          storeId: "store-1",
          terminalId: "terminal-1",
          cashierId: "user-1",
          now: new Date("2026-10-15T02:00:00.000Z"),
          newId: () => `void-id-${++n}`,
          nextSeq: () => ++seq,
          nextCreditNoteNumber: issued + 1,
        }
      )

      if (step.status !== 200) {
        const code = PC_ERRORS.find(([re]) => re.test(step.response.error))?.[1]
        expect(code, `unmapped POS-bir error: ${step.response.error}`).toBeDefined()
        expect(result).toMatchObject({ ok: false, code })
        continue
      }
      if (!result.ok) throw new Error(`expected a credit note, got ${result.code}`)
      issued++

      const pc = step.response.transaction
      const cn = result.creditNote
      for (const field of [
        "invoice_number", "transaction_type", "status", "void_reason", "gross_sales", "vatable_sales", "vat_amount",
        "vat_exempt_sales", "zero_rated_sales", "total_discount", "net_sales", "pax_count", "senior_count",
        "sc_pwd_id", "sc_pwd_name", "payment_method", "amount_tendered", "change_amount", "reference_number",
      ] as const) {
        expect(cn[field], field).toEqual(pc[field])
      }
      expect(cn.authorized_by).toBe(pc.void_authorized_by)
      // Linkage: the credit note belongs to this terminal and the shift it was issued in
      expect(cn).toMatchObject({
        original_transaction_id: original.id,
        shift_id: "shift-2",
        terminal_id: "terminal-1",
        store_id: "store-1",
        cashier_id: "user-1",
      })
      for (const m of result.stockMovements) expect(m).toMatchObject({ ref_id: cn.id, reason: "VOID", terminal_id: "terminal-1" })
      expect(result.auditLog).toMatchObject({ shift_id: "shift-2", user_id: manager, action_type: "TRANSACTION_VOID" })
      const all = [cn, ...result.stockMovements, ...(result.ledgerEntry ? [result.ledgerEntry] : []), result.auditLog]
      expect(all.map((r) => r.device_seq)).toEqual(all.map((_, k) => 501 + k))
      TransactionRecordSchema.parse(cn)
      AuditLogRecordSchema.parse(result.auditLog)
      for (const m of result.stockMovements) StockMovementRecordSchema.parse(m)

      const stock = { ...step.before.stock }
      for (const m of result.stockMovements) stock[m.product_id] = (stock[m.product_id] ?? 0) + m.quantity_delta
      for (const [id, level] of Object.entries(step.stockAfter)) expect(stock[id], `stock ${id}`).toBeCloseTo(level, 9)

      if (customerId) {
        expect(result.customerBalanceAfter).toBe(step.customersAfter[customerId])
        const pcEntry = step.ledger.at(-1)!
        expect(result.ledgerEntry).toMatchObject({
          entry_type: pcEntry.entry_type,
          amount: pcEntry.amount,
          running_balance: pcEntry.running_balance,
          notes: pcEntry.notes,
          transaction_id: cn.id,
          shift_id: "shift-2",
        })
        CreditLedgerEntryRecordSchema.parse(result.ledgerEntry)
      } else {
        expect(result.ledgerEntry).toBeNull()
      }
    }
  })
})
