export type ToolCall = { id: string; name: string; input: Record<string, unknown> }
export type ChatMessage =
  | { role: 'user'; content: string }
  /** `raw` is opaque provider data from a tool_calls result; only the provider that produced it reads it. */
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }
export type Usage = { inputTokens?: number; outputTokens?: number }
export type GenerateRequest = { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal?: AbortSignal }
export type GenerateResult =
  | { kind: 'text'; text: string; usage?: Usage }
  | { kind: 'tool_calls'; calls: ToolCall[]; text?: string; usage?: Usage; raw?: unknown }
export interface Provider { readonly id: string; readonly model: string | null; generate(req: GenerateRequest): Promise<GenerateResult> }
/** The subset of `fetch` the adapters use; tests pass a stub. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
