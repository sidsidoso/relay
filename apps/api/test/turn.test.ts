import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { receiveInbound } from '../src/core/conversations'
import { makeTurnRunner, type TurnDeps } from '../src/agent/turn'
import type { ChatMessage, Provider } from '../src/agent/providers/types'
import { FakeTranscriber, said } from './fake-transcriber'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function setup(transcriber: FakeTranscriber, onTranscriberOffline?: (id: number) => void) {
  const mediaDir = mkdtempSync(join(tmpdir(), 'relay-turn-'))
  dirs.push(mediaDir)
  const db = createDb(':memory:')
  await seed(db)
  const seen: ChatMessage[][] = []
  const provider: Provider = {
    id: 'rec', model: null,
    generate: async (req) => { seen.push(structuredClone(req.messages)); return { kind: 'text', text: 'ok' } },
  }
  const deps: TurnDeps = {
    db, bus: new EventBus(), channels: new ChannelRegistry(), provider, knowledge: () => [], transcriber, mediaDir, onTranscriberOffline,
  }
  writeFileSync(join(mediaDir, 'v.webm'), 'opus')
  const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: 'v.webm', mediaMime: 'audio/webm' })
  return { run: makeTurnRunner(deps), id: conversation.id, seen }
}

describe('makeTurnRunner', () => {
  it('transcribes first, so the provider sees the transcription', async () => {
    const { run, id, seen } = await setup(new FakeTranscriber(() => said('How much is a meeting room?')))
    expect((await run(id)).outcome).toBe('replied')
    expect(seen[0]).toEqual([{ role: 'user', content: '[customer audio, transcribed] How much is a meeting room?' }])
  })

  it('reports an offline transcriber and still runs the turn with [audio]', async () => {
    const offline: number[] = []
    const { run, id, seen } = await setup(new FakeTranscriber(() => ({ ok: false, error: 'offline' })), (cid) => offline.push(cid))
    expect((await run(id)).outcome).toBe('replied')
    expect(offline).toEqual([id])
    expect(seen[0]).toEqual([{ role: 'user', content: '[audio]' }])
  })

  it('a crash in the transcription step is logged and the turn still runs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { run, id } = await setup(new FakeTranscriber(() => { throw new Error('bug') }))
      expect((await run(id)).outcome).toBe('replied')
      expect(err).toHaveBeenCalledWith('[relay] transcription step failed', id, expect.any(Error))
    } finally {
      err.mockRestore()
    }
  })
})
