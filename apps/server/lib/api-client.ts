// The back office's one way to call the server API (docs/api.md). Every failure becomes an ApiError
// carrying the server's { error: { code, message, issues } }, so pages can show the server's own words.

export interface ApiIssue {
  path: string
  message: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly issues: ApiIssue[]

  constructor(status: number, code: string, message: string, issues: ApiIssue[] = []) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.issues = issues
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>

export interface RequestOptions {
  query?: Query
  /** JSON-serialized, or sent as-is when it's FormData (file uploads) */
  body?: unknown
  signal?: AbortSignal
}

// The shell registers this so an expired session sends the user back to /login
let unauthorizedHandler: (() => void) | null = null

/** Called whenever the server answers 401 UNAUTHORIZED; returns a function that unregisters it */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null
  }
}

/** Path plus query string; empty values are left out so `?search=` isn't sent blank */
export function buildUrl(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: "Some fields are invalid",
  401: "Sign in to continue",
  403: "You don't have access to this",
  404: "Not found",
  409: "That conflicts with existing data",
  413: "That file is too large",
  429: "Too many attempts. Try again later.",
}

function fallbackMessage(status: number): string {
  if (FALLBACK_MESSAGES[status]) return FALLBACK_MESSAGES[status]
  if (status >= 500) return "The server had a problem. Try again in a moment."
  return `Request failed (${status})`
}

function asIssues(value: unknown): ApiIssue[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((i): i is { path?: unknown; message?: unknown } => typeof i === "object" && i !== null)
    .map((i) => ({ path: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""), message: String(i.message ?? "Invalid value") }))
}

async function toApiError(res: Response): Promise<ApiError> {
  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    // Not JSON (a proxy error page, an empty body): fall back to a message for the status
  }
  const err = (payload as { error?: { code?: unknown; message?: unknown; issues?: unknown } } | null)?.error
  const error =
    err && typeof err.code === "string"
      ? new ApiError(res.status, err.code, typeof err.message === "string" && err.message ? err.message : fallbackMessage(res.status), asIssues(err.issues))
      : new ApiError(res.status, `HTTP_${res.status}`, fallbackMessage(res.status))
  if (res.status === 401 && error.code === "UNAUTHORIZED") unauthorizedHandler?.()
  return error
}

async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" }
  const init: RequestInit = { method, headers, credentials: "same-origin", signal: opts.signal }
  if (opts.body instanceof FormData) {
    init.body = opts.body
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json"
    init.body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(buildUrl(path, opts.query), init)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    throw new ApiError(0, "NETWORK_ERROR", "Can't reach the server. Check your connection and try again.")
  }
  if (!res.ok) throw await toApiError(res)
  return res
}

async function request<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
  const res = await send(method, path, opts)
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(res.status, "BAD_RESPONSE", "The server sent an unexpected response.")
  }
}

/** A file the server sent (CSV export), with the name from Content-Disposition when it gives one */
async function download(path: string, opts?: RequestOptions): Promise<{ blob: Blob; filename: string | null }> {
  const res = await send("GET", path, opts)
  const disposition = res.headers.get("content-disposition") ?? ""
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  return { blob: await res.blob(), filename: match?.[1] ? decodeURIComponent(match[1]) : null }
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, "body">) => request<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("POST", path, { ...opts, body }),
  patch: <T>(path: string, body: unknown, opts?: Omit<RequestOptions, "body">) => request<T>("PATCH", path, { ...opts, body }),
  delete: <T = { ok: true }>(path: string, opts?: Omit<RequestOptions, "body">) => request<T>("DELETE", path, opts),
  download,
}

/** A message fit to show a person, whatever was thrown */
export function errorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  if (error instanceof ApiError) {
    // "Some fields are invalid" alone says nothing outside a form: add what the server said
    return error.issues.length ? `${error.message}: ${error.issues.map((i) => i.message).join("; ")}` : error.message
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError"

// ---------------------------------------------------------------------------------------------
// Resource shapes (docs/api.md: field names are the database columns; money and quantities are numbers)

export type UserRole = "OWNER" | "ADMIN" | "MANAGER" | "CASHIER"

/** The signed-in back-office user */
export interface SessionUser {
  id: string
  org_id: string
  full_name: string
  role: UserRole
  email: string | null
}

export type StockPolicy = "enforce" | "warn"
export type OfflineCreditMode = "A" | "B" | "C"

export interface Store {
  id: string
  org_id?: string
  name: string
  business_name: string | null
  business_address: string | null
  business_tin: string | null
  receipt_header_lines: string[]
  receipt_footer_lines: string[]
  time_zone: string
  stock_policy: StockPolicy
  offline_credit_mode: OfflineCreditMode
  offline_credit_cap: number | null
  version?: number
}

export interface Category {
  id: string
  name: string
  product_count?: number
  created_at?: string
  updated_at?: string
}

export type UnitType = "QUANTITY" | "WEIGHT"
export type TaxCategory = "VATABLE" | "VAT_EXEMPT" | "ZERO_RATED"
export type SupplierType = "WHOLESALER" | "WET_MARKET" | "DIRECT_DELIVERY"

export interface Product {
  id: string
  category_id: string | null
  name: string
  barcode: string | null
  selling_price: number
  cost_price: number
  unit_type: UnitType
  tax_category: TaxCategory
  supplier_type: SupplierType
  wholesale_price: number | null
  wholesale_threshold: number | null
  low_stock_threshold: number
  notify_low_stock: boolean
  is_promo: boolean
  promo_price: number | null
  deleted_at?: string | null
  /** Only with ?store_id= */
  stock_level?: number
  is_low_stock?: boolean
}

export type StockMovementReason = "SALE" | "VOID" | "RESTOCK" | "ADJUSTMENT"

export interface StockMovement {
  id: string
  store_id: string
  product_id: string
  terminal_id: string | null
  created_by: string | null
  created_at: string
  quantity_delta: number
  reason: StockMovementReason
  note: string | null
}

export interface ImportReport {
  created: number
  updated: number
  skipped: number
  errors: { row: number; message: string }[]
}

export type CreditStatus = "ACTIVE" | "BLOCKED" | "OVERDUE"

export interface Customer {
  id: string
  store_id: string
  full_name: string
  phone_number: string | null
  email: string | null
  address: string | null
  credit_limit: number
  credit_status: CreditStatus
  balance?: number
}

export type PaymentMethod = "CASH" | "GCASH" | "MAYA" | "CARD"

export interface LedgerEntry {
  id: string
  customer_id?: string
  terminal_id: string | null
  created_at: string
  entry_type: "CHARGE" | "PAYMENT" | "ADJUSTMENT"
  amount: number
  running_balance?: number
  notes: string | null
  payment_method: string | null
  reference_number: string | null
  transaction_id?: string | null
  invoice_number?: string | null
}

export interface ManagedUser {
  id: string
  full_name: string
  role: UserRole
  email: string | null
  is_active: boolean
  has_password: boolean
  has_pin: boolean
  /** Owners and admins work in every store; the API may send "ALL" or an empty list for them */
  store_ids: string[] | "ALL"
}

export type TerminalKind = "tablet" | "desktop"

export interface Terminal {
  id: string
  store_id: string
  name: string
  kind: TerminalKind
  ptu_number: string | null
  serial_number: string | null
  min: string | null
  revoked_at: string | null
  created_at?: string
  paired: boolean
  last_seen_at: string | null
}

export interface PairingCode {
  code: string
  expires_at: string
  qr_payload: string
}
