import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/core/events'

const payload = { conversationId: 1, message: {} as any }

describe('EventBus', () => {
  it('a throwing listener does not stop others and emit does not throw', () => {
    const bus = new EventBus()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const boom = new Error('boom')
      const second = vi.fn()
      bus.on('message.created', () => { throw boom })
      bus.on('message.created', second)
      expect(() => bus.emit('message.created', payload)).not.toThrow()
      expect(second).toHaveBeenCalledWith(payload)
      expect(err).toHaveBeenCalledWith('[relay] event listener failed', 'message.created', boom)
    } finally { err.mockRestore() }
  })

  it('off removes a listener registered with on', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.on('message.created', fn)
    bus.off('message.created', fn)
    bus.emit('message.created', payload)
    expect(fn).not.toHaveBeenCalled()
  })

  it('logs a rejecting async listener', async () => {
    const bus = new EventBus()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const boom = new Error('async boom')
      bus.on('message.created', (async () => { throw boom }) as any)
      bus.emit('message.created', payload)
      await new Promise((r) => setImmediate(r))
      expect(err).toHaveBeenCalledWith('[relay] event listener failed', 'message.created', boom)
    } finally { err.mockRestore() }
  })
})
