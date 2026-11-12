import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testServer } from './helpers'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-kbr-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('knowledge routes', () => {
  it('require a session', async () => {
    const { app } = await testServer({ fakeWidget: true, knowledgeDir: dir })
    expect((await app.inject({ method: 'GET', url: '/api/knowledge' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/api/knowledge/a.md', payload: { content: 'x' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: '/api/knowledge/a.md' })).statusCode).toBe(401)
  })

  it('create, list, read, replace and delete a file; the agent sees the change', async () => {
    const { app, login, knowledge } = await testServer({ fakeWidget: true, knowledgeDir: dir })
    const headers = { cookie: await login() }
    const put = await app.inject({ method: 'PUT', url: '/api/knowledge/parking.md', headers, payload: { content: '# Parking\n\n## Garage\nFree for members.\n' } })
    expect(put.statusCode).toBe(200)
    expect(put.json().file.name).toBe('parking.md')
    expect(knowledge!.passages().map((p) => p.title)).toEqual(['Garage'])

    const list = await app.inject({ method: 'GET', url: '/api/knowledge', headers })
    expect(list.json().files.map((f: { name: string }) => f.name)).toEqual(['parking.md'])
    const one = await app.inject({ method: 'GET', url: '/api/knowledge/parking.md', headers })
    expect(one.json()).toEqual({ name: 'parking.md', content: '# Parking\n\n## Garage\nFree for members.\n' })

    const del = await app.inject({ method: 'DELETE', url: '/api/knowledge/parking.md', headers })
    expect(del.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/knowledge/parking.md', headers })).json()).toEqual({ error: 'File not found', code: 'not_found' })
    expect((await app.inject({ method: 'DELETE', url: '/api/knowledge/parking.md', headers })).statusCode).toBe(404)
  })

  it('answer stable codes for bad names, big files and bad bodies', async () => {
    const { app, login } = await testServer({ fakeWidget: true, knowledgeDir: dir })
    const headers = { cookie: await login() }
    const badName = await app.inject({ method: 'PUT', url: '/api/knowledge/Notes.md', headers, payload: { content: 'x' } })
    expect(badName.statusCode).toBe(400)
    expect(badName.json().code).toBe('invalid_name')
    const encoded = await app.inject({ method: 'GET', url: '/api/knowledge/..%2Fsecret.md', headers })
    expect(encoded.statusCode).toBe(400)
    const big = await app.inject({ method: 'PUT', url: '/api/knowledge/big.md', headers, payload: { content: 'x'.repeat(100 * 1024 + 1) } })
    expect(big.statusCode).toBe(413)
    expect(big.json().code).toBe('too_large')
    const noContent = await app.inject({ method: 'PUT', url: '/api/knowledge/a.md', headers, payload: {} })
    expect(noContent.json().code).toBe('invalid_request')
  })
})
