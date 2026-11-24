import { hash, verify } from '@node-rs/argon2'

// OWASP parameters for argon2id.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

/**
 * Checked when the email does not exist, so a wrong email takes as long as a wrong password.
 * Same parameters as OPTIONS. Written out, not computed at the first unknown email: that
 * first answer would otherwise take a hash longer than the others. The password behind it
 * was random and thrown away.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$jAHwq+GIlmNN0RIrRD9KTw$cfk3QWg7LaPvOh6TAWLukLk25eBzAjMRHvwrDvVjJ3s'

/** Always runs one argon2 verification, also without an account (storedHash null). */
export async function verifyPassword(
  storedHash: string | null,
  password: string,
): Promise<boolean> {
  if (storedHash === null) {
    await verify(DUMMY_HASH, password).catch(() => false)
    return false
  }
  return verify(storedHash, password).catch(() => false)
}
