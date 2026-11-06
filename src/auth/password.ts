import { hash, verify } from '@node-rs/argon2'

// OWASP parameters for argon2id.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

// Checked when the email does not exist, so a wrong email takes as long as a wrong password.
let dummyHash: Promise<string> | undefined

export async function verifyPassword(
  storedHash: string | null,
  password: string,
): Promise<boolean> {
  if (storedHash === null) {
    dummyHash ??= hashPassword('not-a-real-password')
    await verify(await dummyHash, password).catch(() => false)
    return false
  }
  return verify(storedHash, password).catch(() => false)
}
