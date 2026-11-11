import { describe, it, expect } from 'vitest'
import { WhatsAppChannel } from '../src/channels/whatsapp'
import { ChannelRegistry } from '../src/channels/types'

describe('channel contract', () => {
  it('the WhatsApp channel implements the interface but is disabled in v1', async () => {
    const ch = new WhatsAppChannel()
    expect(ch.id).toBe('whatsapp')
    await expect(ch.send({} as never, {} as never)).rejects.toThrow('WhatsApp channel is not enabled')
  })

  it('the registry returns registered channels by id', () => {
    const r = new ChannelRegistry()
    const ch = new WhatsAppChannel()
    r.register(ch)
    expect(r.get('whatsapp')).toBe(ch)
    expect(r.get('sms')).toBeUndefined()
  })
})
