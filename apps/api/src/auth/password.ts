import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const KEY_LEN = 64

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(plain, salt, KEY_LEN)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [algo, saltHex, keyHex] = stored.split('$')
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false
  const expected = Buffer.from(keyHex, 'hex')
  if (expected.length === 0) return false // an empty or non-hex key would compare two empty buffers as equal
  const actual = await scrypt(plain, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
