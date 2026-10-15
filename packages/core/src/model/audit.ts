// Audit trail written by terminals (voids, shift events, logins); photos travel separately
import { z } from "zod"
import { id, TerminalRecordSchema } from "./common"

export const AUDIT_ACTIONS = [
  "SHIFT_OPEN",
  "SHIFT_CLOSE",
  "CASH_IN",
  "CASH_OUT",
  "SAFE_DROP",
  "Z_READING",
  "MANUAL_AUDIT",
  "USER_LOGIN",
  "TRANSACTION_VOID",
  "LINE_VOID",
] as const

export const AuditLogRecordSchema = TerminalRecordSchema.extend({
  action_type: z.enum(AUDIT_ACTIONS),
  user_id: id.nullable(),
  shift_id: id.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  // Audit photo in the media upload queue (POS-bir stored the image inline as a BLOB)
  audit_image_id: id.nullable(),
})
export type AuditLogRecord = z.infer<typeof AuditLogRecordSchema>
