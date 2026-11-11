import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/core/events'
import { AgentQueue } from '../src/agent/queue'

const msg = (conversationId: number, sender: string) => ({ conversationId, message: { sender } as never })

describe('AgentQueue', () => {
  it('runs only for contact messages, never synchronously, and drains', async () => {
    const bus = new EventBus()
    const run = vi.fn(async () => {})
    const q = new AgentQueue(run, bus)
    q.start()
    bus.emit('message.created', msg(1, 'contact'))
    bus.emit('message.created', msg(2, 'agent'))
    expect(run).not.toHaveBeenCalled()
    await q.drain()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(1)
  })

  it('serializes per conversation and coalesces messages that arrive during a turn', async () => {
    const bus = new EventBus()
    let active = 0
    let maxActive = 0
    const run = vi.fn(async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active-- })
    const q = new AgentQueue(run, bus)
    q.start()
    bus.emit('message.created', msg(1, 'contact'))
    await new Promise((r) => setTimeout(r, 2))
    bus.emit('message.created', msg(1, 'contact'))
    bus.emit('message.created', msg(1, 'contact'))
    await q.drain()
    expect(maxActive).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs different conversations in parallel', async () => {
    const bus = new EventBus()
    let active = 0
    let maxActive = 0
    const run = vi.fn(async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active-- })
    const q = new AgentQueue(run, bus)
    q.start()
    bus.emit('message.created', msg(1, 'contact'))
    bus.emit('message.created', msg(2, 'contact'))
    await q.drain()
    expect(maxActive).toBe(2)
  })

  it('a crashing turn is logged and the queue keeps working; stop unsubscribes', async () => {
    const bus = new EventBus()
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const q = new AgentQueue(run, bus)
      q.start()
      bus.emit('message.created', msg(1, 'contact'))
      await q.drain()
      expect(spy).toHaveBeenCalledWith('[relay] agent turn crashed', 1, expect.any(Error))
      bus.emit('message.created', msg(1, 'contact'))
      await q.drain()
      expect(run).toHaveBeenCalledTimes(2)
      q.stop()
      bus.emit('message.created', msg(1, 'contact'))
      await q.drain()
      expect(run).toHaveBeenCalledTimes(2)
    } finally { spy.mockRestore() }
  })
})
