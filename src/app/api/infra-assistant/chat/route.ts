// POST /api/infra-assistant/chat
// Streams InfraAgent responses as Server-Sent Events
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.6, 6.7, 8.8

import { requireUserAuth } from '@/lib/api-auth'
import { repoCatalog } from '@/lib/repo-catalog'
import { InfraAgent } from '@/lib/infra-agent'
import type { ConversationMessage } from '@/lib/infra-agent'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: Request) {
  // Requirement 8.8 — protect with user auth
  const auth = await requireUserAuth(request)
  if (auth.error) return auth.error

  // Parse and validate request body
  let body: {
    message?: unknown
    conversationId?: unknown
    team?: unknown
    history?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { message, conversationId, team, history } = body

  // Requirement 1.6 — reject empty or whitespace-only messages
  if (typeof message !== 'string' || message.trim() === '') {
    return new Response(JSON.stringify({ error: 'message must be a non-empty string' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (typeof team !== 'string' || team.trim() === '') {
    return new Response(JSON.stringify({ error: 'team must be a non-empty string' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const conversationHistory: ConversationMessage[] = Array.isArray(history)
    ? (history as ConversationMessage[])
    : []

  const requestorEmail = auth.session.user?.email ?? ''

  // Requirement 6.6 — look up team in RepoCatalog
  const catalogEntry = await repoCatalog.getByTeam(team.trim())

  // Requirement 6.7 — if team not registered, return SSE error message
  if (!catalogEntry) {
    const errorChunk = JSON.stringify({
      type: 'done',
      conversationId: conversationId ?? null,
      reply: `Team "${team}" is not registered in the infrastructure catalog. Please contact an Admin to register your team before using the AI Infrastructure Assistant.`,
    })
    const body = `data: ${errorChunk}\n\n`
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Requirement 1.2 — instantiate InfraAgent with team's projectId and defaultBranch (Requirement 8.8)
  const agent = new InfraAgent({ projectId: catalogEntry.gitlabProjectId, defaultBranch: catalogEntry.defaultBranch })

  // Requirement 1.1, 1.3, 1.4, 1.5 — stream SSE response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      const write = (chunk: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }

      try {
        for await (const chunk of agent.runStream({
          message: message.trim(),
          history: conversationHistory,
          team: team.trim(),
          projectId: catalogEntry.gitlabProjectId,
          defaultBranch: catalogEntry.defaultBranch,
          requestorEmail,
        })) {
          write(chunk)
        }
      } catch (err) {
        console.error('[infra-assistant/chat] stream error:', err)
        write({
          type: 'done',
          conversationId: conversationId ?? null,
          reply: 'An unexpected error occurred while processing your request. Please try again.',
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
