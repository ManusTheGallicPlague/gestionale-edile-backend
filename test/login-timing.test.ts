/**
 * Sign-in must not tell an unknown email from a wrong password or a disabled account, not
 * even by how long it takes. Milliseconds are too noisy to measure in a test, so this checks
 * the cause instead: every attempt runs exactly one argon2 verification, with the same
 * parameters as a real password, and none computes a hash on the way.
 */
import * as argon2 from '@node-rs/argon2'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser, Fixtures, PASSWORD, startApp, type TestContext } from './helpers.js'

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const original = await importOriginal<typeof import('@node-rs/argon2')>()
  return { ...original, hash: vi.fn(original.hash), verify: vi.fn(original.verify) }
})

const verify = vi.mocked(argon2.verify)
const hash = vi.mocked(argon2.hash)

let ctx: TestContext
let fx: Fixtures
let user: { id: string; email: string }
let disabled: { id: string; email: string }

beforeAll(async () => {
  ctx = await startApp()
  fx = new Fixtures(ctx.owner)
  user = await fx.user()
  disabled = await fx.user({ active: false })
})
afterAll(() => ctx.close())
beforeEach(() => {
  verify.mockClear()
  hash.mockClear()
})

/** The argon2 parameters of a stored hash: everything before the salt. */
function parameters(encoded: string): string {
  return encoded.split('$').slice(0, 4).join('$')
}

async function storedHash(userId: string): Promise<string> {
  const { rows } = await ctx.owner.query<{ password_hash: string }>(
    'select password_hash from auth.users where id = $1',
    [userId],
  )
  return rows[0]?.password_hash ?? ''
}

async function signIn(email: string, password: string) {
  const browser = new Browser(ctx.app)
  await browser.request('GET', '/api/auth/csrf')
  verify.mockClear()
  hash.mockClear()
  return browser.call('POST', '/api/auth/login', { body: { email, password } })
}

describe('sign-in takes the same work whatever is wrong', () => {
  // First, so that nothing earlier in the file has prepared anything for it.
  it('an unknown email verifies one password, on a hash like the real ones', async () => {
    const res = await signIn('nessuno-ancora@example.test', PASSWORD)
    expect(res.statusCode).toBe(422)
    expect(verify).toHaveBeenCalledTimes(1)
    // No hash computed now: the first unknown email answers as fast as the others
    expect(hash).not.toHaveBeenCalled()
    const [checked] = verify.mock.calls[0] ?? []
    expect(parameters(String(checked))).toBe(parameters(await storedHash(user.id)))
  })

  const cases: [string, () => string, string][] = [
    ['an unknown email', () => 'nessuno@example.test', PASSWORD],
    ['a wrong password', () => user.email, 'sbagliata'],
    ['a disabled account with its right password', () => disabled.email, PASSWORD],
    ['a disabled account with a wrong password', () => disabled.email, 'sbagliata'],
  ]
  it.each(cases)('%s: one verification, no hash, the same answer', async (_, email, password) => {
    const res = await signIn(email(), password)
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      message: 'Accesso non riuscito.',
      errors: { email: ['Email o password non corretti.'] },
    })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(hash).not.toHaveBeenCalled()
  })

  it('the right password verifies once too', async () => {
    const res = await signIn(user.email, PASSWORD)
    expect(res.statusCode).toBe(204)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(hash).not.toHaveBeenCalled()
  })
})

describe('a disabled account', () => {
  it('loses the sessions it had open', async () => {
    const someone = await fx.user()
    const browser = new Browser(ctx.app)
    await browser.signIn(someone.email)
    expect((await browser.call('GET', '/api/me')).statusCode).toBe(200)
    await ctx.owner.query('update auth.users set active = false where id = $1', [someone.id])
    expect((await browser.call('GET', '/api/me')).statusCode).toBe(401)
  })
})
