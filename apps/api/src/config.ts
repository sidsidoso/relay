/** Environment values, validated once at startup so a typo fails loudly instead of misbehaving later. */

export function readPort(raw: string | undefined, fallback = 3000): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`)
  return n
}

export function readList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

export function readFlag(raw: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((raw ?? '').trim().toLowerCase())
}
