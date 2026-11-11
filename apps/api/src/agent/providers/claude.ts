import Anthropic from '@anthropic-ai/sdk'
import { ProviderError } from './errors'
import type { ChatMessage, FetchLike, GenerateRequest, GenerateResult, Provider, ToolCall, ToolSpec } from './types'

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5'
/** Room for adaptive thinking plus a short chat answer; non-streaming requests stay well under SDK timeouts. */
export const CLAUDE_MAX_TOKENS = 16_000
const EMPTY_MESSAGE = '[empty message]'

export type ClaudeOptions = { apiKey: string; model?: string; maxRetries?: number; fetch?: FetchLike }

const toAnthropicTool = (t: ToolSpec): Anthropic.Tool => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters as Anthropic.Tool['input_schema'],
})

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Neutral chat history -> Messages API turns (see the rules in plan 3, Task 2). */
export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content.trim() ? m.content : EMPTY_MESSAGE })
      continue
    }
    if (out.length === 0) continue // the first message must come from the user
    if (m.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const prev = out.at(-1)!
      if (prev.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => b.type === 'tool_result')) {
        prev.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (m.raw !== undefined) {
      out.push({ role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] })
      continue
    }
    if (m.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.content.trim()) out.push({ role: 'assistant', content: m.content })
  }
  return out
}

/** SDK errors -> ProviderError with a stable code. An abort is returned as is: the engine already timed out. */
export function toProviderError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err
  const detail = String((err as Error)?.message ?? err)
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('claude_rate_limited', detail)
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ProviderError('claude_auth', detail)
  if (err instanceof Anthropic.NotFoundError) return new ProviderError('claude_model_not_found', detail)
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('claude_timeout', detail)
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('claude_offline', detail)
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') return new ProviderError(`claude_http_${err.status}`, detail)
  return new ProviderError('claude_error', detail)
}

/** Claude through the Anthropic Messages API, with the agent's tools as client tools. */
export class ClaudeProvider implements Provider {
  readonly id = 'claude'
  readonly model: string
  private readonly client: Anthropic

  constructor({ apiKey, model, maxRetries = 2, fetch }: ClaudeOptions) {
    this.model = model ?? DEFAULT_CLAUDE_MODEL
    this.client = new Anthropic({ apiKey, maxRetries, ...(fetch ? { fetch } : {}) })
  }

  async generate({ system, messages, tools, signal }: GenerateRequest): Promise<GenerateResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system,
      messages: toAnthropicMessages(messages),
      ...(tools.length ? { tools: tools.map(toAnthropicTool) } : {}),
      // Short support answers: low effort keeps latency and cost down (Sonnet 5.5 defaults to high);
      // thinking stays adaptive (Sonnet 5.5 rejects disabled thinking).
      output_config: { effort: 'low' },
    }
    let res: Anthropic.Message
    try {
      res = await this.client.messages.create(params, { signal })
    } catch (err) {
      throw toProviderError(err)
    }
    if (res.stop_reason === 'refusal') throw new ProviderError('claude_refusal', res.stop_details?.category ?? '')
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
    const calls: ToolCall[] = res.content.flatMap((b) =>
      b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: asRecord(b.input) }] : [])
    if (calls.length) return { kind: 'tool_calls', calls, ...(text ? { text } : {}), usage, raw: res.content }
    if (res.stop_reason === 'max_tokens' || res.stop_reason === 'model_context_window_exceeded') {
      throw new ProviderError(`claude_${res.stop_reason}`)
    }
    return { kind: 'text', text, usage }
  }
}
