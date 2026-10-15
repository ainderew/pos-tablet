import { NextResponse } from "next/server"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { terminals } from "@pos/db"
import { MANAGERS, requireUser } from "@/lib/auth/guard"
import { getDb } from "@/lib/db"
import { notFound, readJson } from "@/lib/http"
import { storeForUser } from "@/lib/stores"

type Params = { params: Promise<{ storeId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")

  const rows = await db
    .select({
      terminal: terminals,
      // Qualified by hand: in a single-table select Drizzle leaves columns unqualified, and "id"
      // would bind to device_tokens.id inside the subquery
      paired: sql<boolean>`exists (select 1 from device_tokens dt where dt.terminal_id = "terminals"."id" and dt.revoked_at is null)`,
      last_seen_at: sql<Date | null>`(select max(dt.last_used_at) from device_tokens dt where dt.terminal_id = "terminals"."id")`,
    })
    .from(terminals)
    .where(and(eq(terminals.store_id, store.id), isNull(terminals.deleted_at)))
    .orderBy(desc(terminals.created_at))
  return NextResponse.json({ terminals: rows.map((r) => ({ ...r.terminal, paired: r.paired, last_seen_at: r.last_seen_at })) })
}

const CreateTerminalSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["tablet", "desktop"]).default("tablet"),
  ptu_number: z.string().trim().max(80).nullish(),
  serial_number: z.string().trim().max(80).nullish(),
  min: z.string().trim().max(80).nullish(),
})

export async function POST(request: Request, { params }: Params) {
  const auth = await requireUser(request, { roles: MANAGERS })
  if (!auth.ok) return auth.response
  const db = getDb()
  const store = await storeForUser(db, auth.user, (await params).storeId)
  if (!store) return notFound("Store not found")
  const body = await readJson(request, CreateTerminalSchema)
  if (!body.ok) return body.response

  const [terminal] = await db
    .insert(terminals)
    .values({
      store_id: store.id,
      name: body.data.name,
      kind: body.data.kind,
      ptu_number: body.data.ptu_number || null,
      serial_number: body.data.serial_number || null,
      min: body.data.min || null,
    })
    .returning()
  return NextResponse.json({ terminal }, { status: 201 })
}
