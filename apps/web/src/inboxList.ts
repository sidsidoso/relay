import type { ConversationSummary } from './api'

/** Same order as the API: newest `updatedAt` first, then highest id. */
const olderThan = (a: ConversationSummary, b: ConversationSummary) =>
  a.updatedAt < b.updatedAt || (a.updatedAt === b.updatedAt && a.id < b.id)

/**
 * A live refresh reloads only the first page (at most 100 rows). Rows the user loaded beyond it are kept, without
 * duplicates, and so is the cursor that continues after them.
 */
export function mergeRefresh(
  loaded: ConversationSummary[], loadedCursor: string | null,
  fresh: ConversationSummary[], freshCursor: string | null,
): { items: ConversationSummary[]; nextCursor: string | null } {
  const last = fresh.at(-1)
  if (!freshCursor || !last) return { items: fresh, nextCursor: freshCursor }
  const seen = new Set(fresh.map((c) => c.id))
  const tail = loaded.filter((c) => !seen.has(c.id) && olderThan(c, last))
  if (tail.length === 0) return { items: fresh, nextCursor: freshCursor }
  return { items: [...fresh, ...tail], nextCursor: loadedCursor }
}
