// A customer's balance is the sum of their credit_ledger entries (CHARGE adds, PAYMENT and ADJUSTMENT
// deduct), summed in SQL so numeric(14,2) amounts add up exactly, then rounded to centavos
import { eq, getTableName, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import { creditLedger } from "@pos/db"
import type { Db } from "@pos/db"

const ledgerSum = sql`round(coalesce(sum(case when ${creditLedger.entry_type} = 'CHARGE' then ${creditLedger.amount} else -${creditLedger.amount} end), 0), 2)`

// Drizzle leaves column names unqualified in a single-table select, where "id" inside the subquery
// would mean credit_ledger.id; spell out the table
const qualified = (column: PgColumn) => sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`

/** SQL for the balance of the customer in `customerId` (e.g. customers.id), for use in a select */
export const customerBalance = (customerId: PgColumn) =>
  sql<number>`(select ${ledgerSum} from ${creditLedger} where ${qualified(creditLedger.customer_id)} = ${qualified(customerId)})`.mapWith(Number)

export async function currentBalance(db: Db, customerId: string): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`${ledgerSum}`.mapWith(Number) })
    .from(creditLedger)
    .where(eq(creditLedger.customer_id, customerId))
  return row?.balance ?? 0
}
