import bcrypt from "bcryptjs"

const PASSWORD_ROUNDS = 12
// PINs are checked on the tablet too (offline login), so their hashes must stay fast on a cheap tablet
const PIN_ROUNDS = 10

export const PIN_PATTERN = /^\d{4,6}$/
export const MIN_PASSWORD_LENGTH = 10

export const hashPassword = (password: string) => bcrypt.hash(password, PASSWORD_ROUNDS)
export const hashPin = (pin: string) => bcrypt.hash(pin, PIN_ROUNDS)

// Compared against when the user doesn't exist, so a wrong email takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", PASSWORD_ROUNDS)

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH)
  return ok && !!hash
}
