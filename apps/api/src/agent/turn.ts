import { runAgentTurn, type EngineDeps, type TurnResult } from './engine'
import { transcribePending, type TranscriptionDeps } from '../transcription/pipeline'

export type TurnDeps = EngineDeps & TranscriptionDeps & { onTranscriberOffline?: (conversationId: number) => void }

/**
 * What the agent queue runs per conversation (spec §3 steps 3–4): transcribe pending voice messages, then the agent turn.
 * Transcription never blocks or breaks the turn.
 */
export function makeTurnRunner(deps: TurnDeps): (conversationId: number) => Promise<TurnResult> {
  return async (conversationId) => {
    try {
      const { offline } = await transcribePending(deps, conversationId)
      if (offline) deps.onTranscriberOffline?.(conversationId)
    } catch (err) {
      console.error('[relay] transcription step failed', conversationId, err)
    }
    return runAgentTurn(deps, conversationId)
  }
}
