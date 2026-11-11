import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry, type Channel } from '../src/channels/types'
import {
  receiveInbound, listConversations, getConversation, assign, handBack, close, teamReply,
  historyForContact, NotFoundError, ConflictError, postOutbound, addTags, type CoreDeps,
} from '../src/core/conversations'

let deps: CoreDeps
let sent: Channel['send'] & ReturnType<typeof vi.fn>

beforeEach(async () => {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  sent = vi.fn(async () => {}) as never
  channels.register({ id: 'widget', send: sent })
  deps = { db, bus: new EventBus(), channels }
})

const hello = { channel: 'widget' as const, contactKey: 'v-1', contactName: 'Ana', type: 'text' as const, text: 'Hi!' }

describe('receiveInbound', () => {
  it('creates contact, open conversation and message, and emits both events', () => {
    const onMsg = vi.fn(); const onConv = vi.fn()
    deps.bus.on('message.created', onMsg); deps.bus.on('conversation.updated', onConv)
    const { conversation, message } = receiveInbound(deps, hello)
    expect(conversation).toMatchObject({ status: 'open', channel: 'widget', assigneeId: null })
    expect(message).toMatchObject({ sender: 'contact', type: 'text', text: 'Hi!' })
    expect(onMsg).toHaveBeenCalledWith({ conversationId: conversation.id, message })
    expect(onConv).toHaveBeenCalledWith({ conversation: expect.objectContaining({ id: conversation.id }) })
  })

  it('reuses the open conversation of the same contact', () => {
    const a = receiveInbound(deps, hello)
    const b = receiveInbound(deps, { ...hello, text: 'Again' })
    expect(b.conversation.id).toBe(a.conversation.id)
  })

  it('starts a new conversation after the previous one was closed', () => {
    const a = receiveInbound(deps, hello)
    close(deps, a.conversation.id)
    const b = receiveInbound(deps, hello)
    expect(b.conversation.id).not.toBe(a.conversation.id)
  })
})

describe('inbox actions', () => {
  it('lists with contact name and last message, newest first, filtered by status', () => {
    receiveInbound(deps, hello)
    const second = receiveInbound(deps, { ...hello, contactKey: 'v-2', contactName: 'Bruno', text: 'Price?' })
    const list = listConversations(deps, {})
    expect(list.map((c) => c.contactName)).toEqual(['Bruno', 'Ana'])
    expect(list[0]!.lastMessage).toBe('Price?')
    close(deps, second.conversation.id)
    expect(listConversations(deps, { status: 'closed' })).toHaveLength(1)
  })

  it('assign, hand back and close change status and assignee', () => {
    const { conversation } = receiveInbound(deps, hello)
    expect(assign(deps, conversation.id, 1)).toMatchObject({ assigneeId: 1, status: 'open' })
    expect(listConversations(deps, { assigneeId: 1 })[0]!.assigneeName).toBe('Demo Agent')
    expect(handBack(deps, conversation.id)).toMatchObject({ assigneeId: null, status: 'open' })
    expect(close(deps, conversation.id)).toMatchObject({ status: 'closed' })
  })

  it('team reply stores a user message and sends it through the channel', async () => {
    const { conversation } = receiveInbound(deps, hello)
    const msg = await teamReply(deps, conversation.id, 1, 'Hello Ana')
    expect(msg).toMatchObject({ sender: 'user', userId: 1, text: 'Hello Ana' })
    expect(sent).toHaveBeenCalledWith(
      { conversation: expect.objectContaining({ id: conversation.id }), contact: expect.objectContaining({ contactKey: 'v-1' }) },
      msg,
    )
    expect(getConversation(deps, conversation.id)!.messages.map((m) => m.sender)).toEqual(['contact', 'user'])
  })

  it('history for a contact returns the current conversation only', () => {
    const a = receiveInbound(deps, hello)
    close(deps, a.conversation.id)
    receiveInbound(deps, { ...hello, text: 'New' })
    expect(historyForContact(deps, 'widget', 'v-1').map((m) => m.text)).toEqual(['New'])
    expect(historyForContact(deps, 'widget', 'nobody')).toEqual([])
  })

  it('unknown conversation throws NotFoundError', () => {
    expect(() => assign(deps, 999, 1)).toThrow(NotFoundError)
    expect(getConversation(deps, 999)).toBeNull()
  })
})

describe('outbound path and status rules', () => {
  it('postOutbound stores an agent message, applies changes atomically and delivers it', async () => {
    const { conversation } = receiveInbound(deps, hello)
    const events: string[] = []
    deps.bus.on('message.created', () => { events.push('message.created') })
    deps.bus.on('conversation.updated', () => { events.push('conversation.updated') })
    const msg = await postOutbound(deps, conversation.id, { sender: 'agent', text: 'Hello from the agent' }, { agentTurns: 1 })
    expect(msg).toMatchObject({ sender: 'agent', userId: null, text: 'Hello from the agent' })
    expect(getConversation(deps, conversation.id)!.conversation.agentTurns).toBe(1)
    expect(events).toEqual(['message.created', 'conversation.updated'])
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('a delivery failure is logged, not thrown, and the message stays stored once', async () => {
    const { conversation } = receiveInbound(deps, hello)
    sent.mockRejectedValueOnce(new Error('socket gone'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(postOutbound(deps, conversation.id, { sender: 'agent', text: 'x' })).resolves.toMatchObject({ text: 'x' })
      expect(spy).toHaveBeenCalledWith('[relay] delivery failed', 'widget', expect.any(Error))
      expect(getConversation(deps, conversation.id)!.messages.filter((m) => m.text === 'x')).toHaveLength(1)
    } finally { spy.mockRestore() }
  })

  it('replying to or assigning a closed conversation is a 409-style ConflictError', async () => {
    const { conversation } = receiveInbound(deps, hello)
    close(deps, conversation.id)
    await expect(teamReply(deps, conversation.id, 1, 'late')).rejects.toBeInstanceOf(ConflictError)
    expect(() => assign(deps, conversation.id, 1)).toThrow(ConflictError)
  })

  it('handBack resets the agent turn counter and clears the handoff reason', async () => {
    const { conversation } = receiveInbound(deps, hello)
    await postOutbound(deps, conversation.id, { sender: 'agent', text: 'a' }, { agentTurns: 7, status: 'waiting_human', handoffReason: 'r' })
    assign(deps, conversation.id, 1)
    expect(handBack(deps, conversation.id)).toMatchObject({ agentTurns: 0, handoffReason: null, status: 'open' })
  })

  it('addTags merges, normalizes and caps tags', () => {
    const { conversation } = receiveInbound(deps, hello)
    addTags(deps, conversation.id, ['Pricing', ' pricing ', 'virtual-office', ''])
    const c = addTags(deps, conversation.id, ['x'.repeat(31), 'meeting-room'])
    expect(c.tags).toEqual(['pricing', 'virtual-office', 'meeting-room'])
  })

  it('NotFoundError for close, handBack, addTags and teamReply on an unknown id', async () => {
    expect(() => close(deps, 999)).toThrow(NotFoundError)
    expect(() => handBack(deps, 999)).toThrow(NotFoundError)
    expect(() => addTags(deps, 999, ['a'])).toThrow(NotFoundError)
    await expect(teamReply(deps, 999, 1, 'x')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('an audio message without text is listed as [audio]', () => {
    receiveInbound(deps, { channel: 'widget', contactKey: 'v-9', type: 'audio', mediaPath: 'a.webm', mediaMime: 'audio/webm' })
    expect(listConversations(deps, {})[0]!.lastMessage).toBe('[audio]')
  })

  it('an inbound message updates the contact name', () => {
    receiveInbound(deps, hello)
    const { conversation } = receiveInbound(deps, { ...hello, contactName: 'Ana Maria' })
    expect(getConversation(deps, conversation.id)!.contact.name).toBe('Ana Maria')
  })
})
