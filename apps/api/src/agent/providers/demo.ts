import { NO_RESULTS } from '../tools'
import { AUDIO_PLACEHOLDER, TRANSCRIBED_PREFIX } from '../engine'
import type { ChatMessage, GenerateRequest, GenerateResult, Provider } from './types'

const GREETING = "Hi! I'm the Acme Coworking assistant. Ask me about plans, prices, meeting rooms, opening hours or the virtual office."
export const AUDIO_FALLBACK = "Sorry, I couldn't listen to your voice message. Could you type your question?"
const GREETINGS = /^(hi|hello|hey|oi|ola|bom dia|boa tarde|boa noite)\b/
const HANDOFF_WORDS = /\b(complain|complaint|refund|cancel|reclamacao|reembolso|cancelar)\b/
const MAX_ANSWER = 600

const plain = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

/** Scripted provider: shows the whole agent flow (answer, search, handoff) with no API key. */
export class DemoProvider implements Provider {
  readonly id = 'demo'
  readonly model = 'scripted'

  async generate({ messages }: GenerateRequest): Promise<GenerateResult> {
    const id = `demo-${messages.length}`
    const last = messages.at(-1)
    if (last?.role === 'tool' && last.name === 'search_knowledge') {
      if (last.content === NO_RESULTS) {
        return { kind: 'tool_calls', calls: [{ id, name: 'transfer_to_human', input: { reason: 'No answer in the knowledge base' } }] }
      }
      const [first] = JSON.parse(last.content) as Array<{ title: string; text: string }>
      const text = first!.text.length > MAX_ANSWER ? `${first!.text.slice(0, MAX_ANSWER)}…` : first!.text
      return { kind: 'text', text: `Here is what I found about "${first!.title}":\n\n${text}` }
    }
    const user = [...messages].reverse().find((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user')
    if (!user) return { kind: 'text', text: GREETING }
    if (user.content === AUDIO_PLACEHOLDER) return { kind: 'text', text: AUDIO_FALLBACK }
    const said = user.content.startsWith(TRANSCRIBED_PREFIX) ? user.content.slice(TRANSCRIBED_PREFIX.length) : user.content
    const q = plain(said)
    if (GREETINGS.test(q) && q.split(/\s+/).length <= 4) return { kind: 'text', text: GREETING }
    if (HANDOFF_WORDS.test(q)) {
      return { kind: 'tool_calls', calls: [{ id, name: 'transfer_to_human', input: { reason: 'Customer wants to complain, cancel or get a refund' } }] }
    }
    return { kind: 'tool_calls', calls: [{ id, name: 'search_knowledge', input: { query: said } }] }
  }
}
