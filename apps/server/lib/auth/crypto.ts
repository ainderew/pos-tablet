import { createHash, randomBytes, randomInt } from "node:crypto"

/** URL-safe random token (session cookies, device tokens) */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url")

/** Tokens and codes are stored only as their SHA-256 */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

// No 0/O, 1/I/L, so a code read off a screen is typed correctly
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

/** "ABCD-EFGH": 8 characters (~40 bits), only valid for minutes and rate-limited */
export function pairingCode(): string {
  let code = ""
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Normalize what a person typed ("abcd efgh", "ABCDEFGH") before hashing */
export const normalizePairingCode = (input: string) => {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

export const PAIRING_CODE_MINUTES = 10
export const DEVICE_TOKEN_PREFIX = "pdt_"
