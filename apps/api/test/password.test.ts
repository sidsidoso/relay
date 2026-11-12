import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password'

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('relay-demo')
    expect(stored).toMatch(/^scrypt\$/)
    expect(await verifyPassword('relay-demo', stored)).toBe(true)
    expect(await verifyPassword('wrong', stored)).toBe(false)
  })

  it('salts: the same password hashes differently', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'))
  })

  it('a malformed stored value is just "false", never a throw', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false)
  })

  it('a stored hash with an empty or non-hex key never matches', async () => {
    expect(await verifyPassword('anything', 'scrypt$00$')).toBe(false)
    expect(await verifyPassword('anything', 'scrypt$00$zz')).toBe(false)
  })
})
