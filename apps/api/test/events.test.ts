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
      bus.on('message.created', async () => { throw boom })
      bus.emit('message.created', payload)
      await new Promise((r) => setImmediate(r))
      expect(err).toHaveBeenCalledWith('[relay] event listener failed', 'message.created', boom)
    } finally { err.mockRestore() }
  })
  it('ignores a second registration of the same listener; one off removes it', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.on('message.created', fn)
    bus.on('message.created', fn)
    bus.emit('message.created', payload)
    expect(fn).toHaveBeenCalledTimes(1)
    bus.off('message.created', fn)
    bus.emit('message.created', payload)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('logs a rejecting non-native thenable', async () => {
    const bus = new EventBus()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const boom = new Error('thenable boom')
      const thenable = { then: (_ok: unknown, fail: (e: unknown) => void) => fail(boom) }
      bus.on('message.created', () => thenable as unknown as Promise<void>)
      bus.emit('message.created', payload)
      await new Promise((r) => setImmediate(r))
      expect(err).toHaveBeenCalledWith('[relay] event listener failed', 'message.created', boom)
    } finally { err.mockRestore() }
  })

  it('accepts async listeners without casts', async () => {
    const bus = new EventBus()
    const seen: number[] = []
    bus.on('message.created', async ({ conversationId }) => { seen.push(conversationId) })
    bus.emit('message.created', payload)
    await new Promise((r) => setImmediate(r))
    expect(seen).toEqual([1])
  })
})
