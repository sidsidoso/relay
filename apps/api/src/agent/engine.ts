import { addTags, getConversation, postOutbound, type CoreDeps } from '../core/conversations'
import { agentSettings } from '../core/settings'
import type { AgentRun, Message } from '../core/types'
import { searchKnowledge, tokenize, type Passage } from './knowledge'
import type { ChatMessage, Provider, ToolCall } from './providers/types'
import { recordRun } from './runs'
import { NO_RESULTS, TOOL_SPECS } from './tools'

export const HISTORY_LIMIT = 20
export const MAX_TOOL_ROUNDS = 3
export const DEFAULT_TIMEOUT_MS = 30_000

/** How audio appears in the history sent to the provider (spec §4). */
export const AUDIO_PLACEHOLDER = '[audio]'
export const TRANSCRIBED_PREFIX = '[customer audio, transcribed] '

export type EngineDeps = CoreDeps & { provider: Provider; knowledge: () => Passage[]; timeoutMs?: number }
export type TurnResult = { outcome: 'replied' | 'transferred' | 'failed' | 'skipped'; run?: AgentRun }

/** Tool-capable models must look facts up instead of answering from memory. */
export const SEARCH_RULE =
  '- Before answering any question about the company, its products, services, prices, opening hours, policies or location, call search_knowledge and answer only from what it returns. Never invent prices or facts.'

const RULES = [
  'Rules:',
  SEARCH_RULE,
  '- If search_knowledge returns nothing useful, if you cannot answer confidently, or if the customer wants a human, a complaint, a cancellation or a refund, call transfer_to_human.',
  '- Reply in the language the customer writes in. Keep answers short.',
].join('\n')

/** For models without tools: facts come only from the passages below, and a person takes over what they do not cover. */
const TEXT_ONLY_RULES = [
  'Rules:',
  '- Answer questions about the company, its products, services, prices, opening hours, policies or location only from the knowledge base passages below. Never invent prices or facts.',
  '- If the passages do not answer the question, say that a person from the team will follow up.',
  '- Reply in the language the customer writes in. Keep answers short.',
].join('\n')

export const KNOWLEDGE_HEADER = 'Knowledge base passages:'

function passagesBlock(passages: Passage[], query: string): string {
  const hits = searchKnowledge(passages, query)
  if (hits.length === 0) return `${KNOWLEDGE_HEADER} none matched.`
  return `${KNOWLEDGE_HEADER}\n\n${hits.map((h) => `### ${h.title}\n${h.text}`).join('\n\n')}`
}

/** The system prompt: the configured instructions, then the rules; text-only models also get the matching passages. */
export function buildSystemPrompt(instructions: string, textOnly: boolean, knowledge: Passage[], query: string): string {
  return textOnly
    ? `${instructions}\n\n${TEXT_ONLY_RULES}\n\n${passagesBlock(knowledge, query)}`
    : `${instructions}\n\n${RULES}`
}

class TimeoutError extends Error { constructor() { super('timeout') } }

/** Moves the conversation to the team queue and tells the customer, so they are never left without an answer. */
export async function handOff(deps: CoreDeps, conversationId: number, reason: string, message: string): Promise<void> {
  await postOutbound(deps, conversationId, { sender: 'agent', text: message }, { status: 'waiting_human', handoffReason: reason })
}

/** The words of a message: its text, or the transcription of an audio message (null when there is none). */
function wordsOf(m: Message): string | null {
  if (m.type !== 'audio') return m.text
  return m.transcription?.status === 'ok' && m.transcription.text ? m.transcription.text : null
}

function contentOf(m: Message): string {
  if (m.type === 'audio') {
    const words = wordsOf(m)
    return words ? `${TRANSCRIBED_PREFIX}${words}` : AUDIO_PLACEHOLDER
  }
  return m.text ?? ''
}

function toChat(m: Message): ChatMessage {
  return m.sender === 'contact' ? { role: 'user', content: contentOf(m) } : { role: 'assistant', content: contentOf(m) }
}

/** Case- and accent-insensitive whole-word match; a multi-word keyword needs all its words. */
function asksForHuman(text: string | null, keywords: string[]): boolean {
  if (!text) return false
  const words = new Set(tokenize(text))
  return keywords.some((k) => {
    const parts = tokenize(k)
    return parts.length > 0 && parts.every((w) => words.has(w))
  })
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new TimeoutError()) }, ms)
  })
  try {
    return await Promise.race([fn(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const isFree = (c: { status: string; assigneeId: number | null } | undefined) => !!c && c.status === 'open' && c.assigneeId === null

export async function runAgentTurn(deps: EngineDeps, conversationId: number): Promise<TurnResult> {
  const found = getConversation(deps, conversationId)
  if (!found || !isFree(found.conversation)) return { outcome: 'skipped' }
  const { conversation, messages } = found
  let lastCompany = -1
  messages.forEach((m, i) => { if (m.sender !== 'contact') lastCompany = i })
  const pending = messages.slice(lastCompany + 1)
  if (pending.length === 0) return { outcome: 'skipped' }

  const settings = agentSettings(deps.db)
  const started = Date.now()
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  const log = (outcome: 'replied' | 'transferred' | 'failed', error: string | null = null): TurnResult => ({
    outcome,
    run: recordRun(deps, {
      conversationId, provider: deps.provider.id, model: deps.provider.model, durationMs: Date.now() - started,
      inputTokens, outputTokens, outcome, error,
    }),
  })
  const stillFree = () => isFree(getConversation(deps, conversationId)?.conversation)
  const transfer = async (reason: string, error: string | null = null): Promise<TurnResult> => {
    if (!stillFree()) return { outcome: 'skipped' }
    await handOff(deps, conversationId, reason, settings.handoffMessage)
    return log('transferred', error)
  }

  if (conversation.agentTurns >= settings.turnLimit) return transfer('Turn limit reached')
  if (pending.some((m) => asksForHuman(wordsOf(m), settings.handoffKeywords))) return transfer('Customer asked for a human')

  const query = pending.map(wordsOf).filter(Boolean).join(' ')
  const textOnly = !!deps.provider.textOnly
  const system = buildSystemPrompt(settings.instructions, textOnly, deps.knowledge(), query)
  // If the provider drops tools mid-request (Ollama), it needs the prompt with the passages.
  const textOnlySystem = textOnly ? undefined : buildSystemPrompt(settings.instructions, true, deps.knowledge(), query)
  const chat: ChatMessage[] = messages.slice(-HISTORY_LIMIT).map(toChat)

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await withTimeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
        deps.provider.generate({ system, ...(textOnlySystem ? { textOnlySystem } : {}), messages: chat, tools: TOOL_SPECS, signal }))
      if (result.usage?.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + result.usage.inputTokens
      if (result.usage?.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + result.usage.outputTokens

      if (result.kind === 'text') {
        const text = result.text.trim()
        if (!text) return transfer('The agent returned an empty reply', 'empty_reply')
        // A person may have taken the conversation while the provider was thinking.
        const now = getConversation(deps, conversationId)?.conversation
        if (!now || !isFree(now)) return { outcome: 'skipped' }
        await postOutbound(deps, conversationId, { sender: 'agent', text }, { agentTurns: now.agentTurns + 1 })
        return log('replied')
      }

      chat.push({
        role: 'assistant',
        content: result.text ?? '',
        toolCalls: result.calls,
        ...(result.raw !== undefined ? { raw: result.raw } : {}),
      })
      for (const call of result.calls) {
        if (call.name === 'transfer_to_human') {
          const reason = typeof call.input.reason === 'string' && call.input.reason.trim() ? call.input.reason.trim() : 'The agent asked for a human'
          return transfer(reason)
        }
        chat.push({ role: 'tool', toolCallId: call.id, name: call.name, content: runTool(deps, conversationId, call) })
      }
    }
    return transfer('The agent did not finish within the tool limit')
  } catch (err) {
    const error = err instanceof TimeoutError ? 'timeout' : String((err as Error)?.message ?? err).slice(0, 200)
    try {
      if (stillFree()) await handOff(deps, conversationId, 'The AI provider failed', settings.handoffMessage)
    } catch (handoffErr) {
      console.error('[relay] handoff after provider failure failed', conversationId, handoffErr)
    }
    return log('failed', error)
  }
}

function runTool(deps: EngineDeps, conversationId: number, call: ToolCall): string {
  if (call.name === 'search_knowledge') {
    const hits = searchKnowledge(deps.knowledge(), String(call.input.query ?? ''))
    return hits.length ? JSON.stringify(hits.map(({ title, text }) => ({ title, text }))) : NO_RESULTS
  }
  if (call.name === 'tag_conversation') {
    addTags(deps, conversationId, Array.isArray(call.input.tags) ? call.input.tags.map(String) : [])
    return 'ok'
  }
  return 'unknown tool'
}
