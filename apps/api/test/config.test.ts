import { describe, it, expect } from 'vitest'
import { readFlag, readList, readPort } from '../src/config'
import { redactUrl } from '../src/http/security'

describe('configuration values', () => {
  it('readPort accepts 1-65535 and falls back when blank', () => {
    expect(readPort(undefined)).toBe(3000)
    expect(readPort('  ', 8080)).toBe(8080)
    expect(readPort('3010')).toBe(3010)
    for (const bad of ['0', '65536', '30.5', 'abc', '-1']) expect(() => readPort(bad)).toThrow(/PORT must be an integer/)
  })

  it('readList splits on commas and drops blanks', () => {
    expect(readList(undefined)).toEqual([])
    expect(readList(' http://a.test , ,http://b.test ')).toEqual(['http://a.test', 'http://b.test'])
  })

  it('readFlag understands 1, true and yes', () => {
    for (const on of ['1', 'true', 'TRUE', 'yes']) expect(readFlag(on)).toBe(true)
    for (const off of [undefined, '', '0', 'false', 'no']) expect(readFlag(off)).toBe(false)
  })

  it('redactUrl drops the query string, where visitor tokens travel', () => {
    expect(redactUrl('/ws/widget?token=secret&name=Ana')).toBe('/ws/widget')
    expect(redactUrl('/api/health')).toBe('/api/health')
  })
})
