import type { ToolSpec } from './providers/types'

/** What `search_knowledge` returns to the model when nothing matched. */
export const NO_RESULTS = 'NO_RESULTS'

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_knowledge',
    description: 'Search the company knowledge base. Use it before answering any question about the company, its products, services, prices, opening hours, policies or location.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' } }, required: ['query'] },
  },
  {
    name: 'transfer_to_human',
    description: 'Hand the conversation to a person from the team. Use it when the customer asks for a human, when you cannot answer confidently, or for complaints, cancellations and refunds.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Short reason shown to the team' } }, required: ['reason'] },
  },
  {
    name: 'tag_conversation',
    description: 'Add short lowercase tags that describe the conversation, such as "pricing" or "virtual-office".',
    parameters: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 5 } }, required: ['tags'] },
  },
]
