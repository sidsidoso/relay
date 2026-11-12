import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { getConversation, type CoreDeps } from '../core/conversations'
import { transcriptionEnabled } from '../core/settings'
import type { Message } from '../core/types'
import { messages, type Transcription } from '../db/schema'
import { HISTORY_LIMIT } from '../agent/engine'
import { mediaFile } from '../media/store'
import type { Transcriber } from './client'

/** Spec §5: per-audio deadline and per-turn total. */
export const PER_AUDIO_MS = 40_000
export const PER_TURN_MS = 40_000

export type TranscriptionDeps = CoreDeps & { transcriber: Transcriber | null; mediaDir: string; perAudioMs?: number; perTurnMs?: number }
export type TranscribeOutcome = { attempted: number; offline: boolean }

const now = () => new Date().toISOString()

function store(deps: CoreDeps, message: Message, transcription: Transcription): void {
  const updated = deps.db.update(messages).set({ transcription }).where(eq(messages.id, message.id)).returning().get()
  if (updated) deps.bus.emit('message.updated', { conversationId: updated.conversationId, message: updated })
}

/**
 * Transcribes the customer's recent voice messages that have no transcription yet.
 * `offline` means the service could not be reached: nothing was stored, so the same audio is tried again later.
 */
export async function transcribePending(deps: TranscriptionDeps, conversationId: number): Promise<TranscribeOutcome> {
  const outcome: TranscribeOutcome = { attempted: 0, offline: false }
  if (!deps.transcriber || !transcriptionEnabled(deps.db)) return outcome
  const found = getConversation(deps, conversationId)
  if (!found) return outcome
  const pending = found.messages.slice(-HISTORY_LIMIT)
    .filter((m) => m.sender === 'contact' && m.type === 'audio' && m.transcription === null)
  const perAudio = deps.perAudioMs ?? PER_AUDIO_MS
  const deadline = Date.now() + (deps.perTurnMs ?? PER_TURN_MS)

  for (const m of pending) {
    const left = deadline - Date.now()
    if (left <= 0) break
    const file = mediaFile(deps.mediaDir, m.mediaPath)
    let audio: Buffer<ArrayBuffer>
    try {
      if (!file) throw new Error('no file')
      audio = await readFile(file)
    } catch {
      store(deps, m, { status: 'failed', error: 'missing_file', at: now() })
      continue
    }
    const timeoutMs = Math.min(perAudio, left)
    outcome.attempted++
    const r = await deps.transcriber.transcribe(audio, { mime: m.mediaMime ?? 'application/octet-stream', timeoutMs })
    if (r.ok) {
      const text = r.text.trim()
      store(deps, m, text
        ? { status: 'ok', text, model: r.model, durationS: r.durationS, at: now() }
        : { status: 'empty', model: r.model, durationS: r.durationS, at: now() })
      // Never log the text: it is the customer's speech.
      console.log(`[relay] transcribed message ${m.id}: ${r.durationS}s of audio in ${r.processingS}s`)
      continue
    }
    console.warn(`[relay] transcription of message ${m.id} failed: ${r.error}`)
    if (r.error === 'offline') { outcome.offline = true; break }
    // Cut short by the turn budget, not by its own deadline: leave it for a later turn.
    if (r.error === 'timeout' && timeoutMs < perAudio) break
    store(deps, m, { status: 'failed', error: r.error, at: now() })
  }
  return outcome
}
