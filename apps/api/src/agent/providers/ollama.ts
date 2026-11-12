import { ProviderError } from './errors'
import type { ChatMessage, FetchLike, GenerateRequest, GenerateResult, Provider, ToolSpec } from './types'

export const DEFAULT_OLLAMA_MODEL = 'llama3.2'
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

type OllamaToolCall = { id?: string; function: { name: string; arguments: Record<string, unknown> | string } }
export type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}
type OllamaChatResponse = {
  model: string
  message?: { role: 'assistant'; content?: string; tool_calls?: OllamaToolCall[] }
  done: boolean
  prompt_eval_count?: number
  eval_count?: number
}

/** Reasoning models may inline their thinking; the customer must never see it. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g
const NO_TOOLS = /does not support tools/i

export function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'tool') out.push({ role: 'tool', content: m.content, tool_name: m.name })
    else if (m.toolCalls?.length) {
      out.push({ role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) })
    } else out.push({ role: 'assistant', content: m.content })
  }
  return out
}

const toOllamaTool = (t: ToolSpec) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })

function parseArguments(args: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args
  if (typeof args !== 'string') return {}
  try {
    const v: unknown = JSON.parse(args)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : ''
  } catch {
    return ''
  }
}

/** A local model through Ollama's /api/chat. Models without tool support fall back to text-only mode. */
export class OllamaProvider implements Provider {
  readonly id = 'ollama'
  readonly model: string
  private readonly url: string
  private readonly fetch: FetchLike
  private toolsSupported = true

  constructor({ url, model, fetch }: { url: string; model?: string; fetch?: FetchLike }) {
    this.url = url.replace(/\/+$/, '')
    this.model = model ?? DEFAULT_OLLAMA_MODEL
    this.fetch = fetch ?? globalThis.fetch
  }

  get textOnly(): boolean {
    return !this.toolsSupported
  }

  async generate({ system, textOnlySystem, messages, tools, signal }: GenerateRequest): Promise<GenerateResult> {
    const withTools = this.toolsSupported && tools.length > 0
    let res = await this.chat(system, messages, withTools ? tools : [], signal)
    if (withTools && res.status === 400) {
      const detail = await errorText(res)
      if (!NO_TOOLS.test(detail)) throw new ProviderError('ollama_http_400', detail)
      this.toolsSupported = false
      console.warn(`[relay] ollama model "${this.model}" does not support tools; running in text-only mode`)
      res = await this.chat(textOnlySystem ?? system, messages, [], signal)
    }
    if (!res.ok) {
      const detail = await errorText(res)
      throw new ProviderError(res.status === 404 ? 'ollama_model_not_found' : `ollama_http_${res.status}`, detail)
    }
    const data = (await res.json()) as OllamaChatResponse
    const usage = { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count }
    const text = (data.message?.content ?? '').replace(THINK_BLOCK, '').trim()
    const calls = data.message?.tool_calls ?? []
    if (calls.length) {
      return {
        kind: 'tool_calls',
        calls: calls.map((c, i) => ({ id: c.id ?? `ollama-${messages.length}-${i}`, name: c.function.name, input: parseArguments(c.function.arguments) })),
        ...(text ? { text } : {}),
        usage,
      }
    }
    return { kind: 'text', text, usage }
  }

  private async chat(system: string, messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<Response> {
    const body = {
      model: this.model,
      stream: false,
      messages: toOllamaMessages(system, messages),
      ...(tools.length ? { tools: tools.map(toOllamaTool) } : {}),
    }
    try {
      return await this.fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new ProviderError('ollama_offline', String((err as Error)?.message ?? err))
    }
  }
}
