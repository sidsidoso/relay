import { mergeRefresh } from '../src/inboxList'
import type { ConversationSummary } from '../src/api'

const row = (id: number, updatedAt: string): ConversationSummary => ({
  id, contactId: id, channel: 'widget', status: 'open', assigneeId: null, agentTurns: 0, tags: [], handoffReason: null,
  createdAt: updatedAt, updatedAt, contactName: null, lastMessage: null, assigneeName: null,
})

describe('mergeRefresh', () => {
  it('takes the fresh page when nothing beyond it was loaded', () => {
    const fresh = [row(2, '2026-11-12T10:02:00Z'), row(1, '2026-11-12T10:01:00Z')]
    expect(mergeRefresh([row(1, '2026-11-12T10:01:00Z')], null, fresh, null)).toEqual({ items: fresh, nextCursor: null })
  })

  it('keeps the loaded rows older than the fresh page, without duplicates, and the loaded cursor', () => {
    const loaded = [row(5, '2026-11-12T10:05:00Z'), row(4, '2026-11-12T10:04:00Z'), row(3, '2026-11-12T10:03:00Z'), row(2, '2026-11-12T10:02:00Z')]
    // Conversation 3 got a new message: it is now first; the fresh page holds two rows.
    const fresh = [row(3, '2026-11-12T11:00:00Z'), row(5, '2026-11-12T10:05:00Z')]
    const merged = mergeRefresh(loaded, 'cursor-after-2', fresh, 'cursor-after-5')
    expect(merged.items.map((c) => c.id)).toEqual([3, 5, 4, 2])
    expect(merged.nextCursor).toBe('cursor-after-2')
  })
})
