export type ToolCall = { id: string; name: string; input: Record<string, unknown> }
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }
export type Usage = { inputTokens?: number; outputTokens?: number }
export type GenerateRequest = { system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal?: AbortSignal }
export type GenerateResult =
  | { kind: 'text'; text: string; usage?: Usage }
  | { kind: 'tool_calls'; calls: ToolCall[]; text?: string; usage?: Usage }
export interface Provider { readonly id: string; readonly model: string | null; generate(req: GenerateRequest): Promise<GenerateResult> }
