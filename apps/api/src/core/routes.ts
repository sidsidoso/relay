import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { makeRequireUser } from '../auth/guard'
import {
  assign, close, getConversation, handBack, listConversations, teamReply, NotFoundError, type CoreDeps,
} from './conversations'
import { listRuns } from '../agent/runs'

const ListQuery = z.object({
  status: z.enum(['open', 'waiting_human', 'closed']).optional(),
  mine: z.literal('1').optional(),
})
const IdParams = z.object({ id: z.coerce.number().int().positive() })
const ReplyBody = z.object({ text: z.string().trim().min(1).max(4000) })

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'Conversation not found', code: 'not_found' })
}

export function conversationRoutes(app: FastifyInstance, deps: CoreDeps) {
  const requireUser = makeRequireUser(deps.db)

  app.get('/api/conversations', { preHandler: requireUser }, async (req) => {
    const q = ListQuery.parse(req.query)
    return { conversations: listConversations(deps, { status: q.status, assigneeId: q.mine ? req.user!.id : undefined }) }
  })

  app.get('/api/conversations/:id', { preHandler: requireUser }, async (req, reply) => {
    const found = getConversation(deps, IdParams.parse(req.params).id)
    return found ?? notFound(reply)
  })

  app.post('/api/conversations/:id/assign', { preHandler: requireUser }, async (req) =>
    ({ conversation: assign(deps, IdParams.parse(req.params).id, req.user!.id) }))

  app.post('/api/conversations/:id/hand-back', { preHandler: requireUser }, async (req) =>
    ({ conversation: handBack(deps, IdParams.parse(req.params).id) }))

  app.post('/api/conversations/:id/close', { preHandler: requireUser }, async (req) =>
    ({ conversation: close(deps, IdParams.parse(req.params).id) }))

  app.post('/api/conversations/:id/messages', { preHandler: requireUser }, async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const { text } = ReplyBody.parse(req.body)
    const message = await teamReply(deps, id, req.user!.id, text)
    return reply.code(201).send({ message })
  })

  app.get('/api/conversations/:id/agent-runs', { preHandler: requireUser }, async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    if (!getConversation(deps, id)) return notFound(reply)
    return { runs: listRuns(deps.db, id) }
  })
}
