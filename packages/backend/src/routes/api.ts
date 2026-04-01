import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import type { DatabaseAdapter, AgentAdapter, Config, Message, ConstraintsRemaining, SessionContext, ToolCall, ToolResult, AgentConfig, MessageRole } from '@lintic/core';
import { OpenAIAdapter, AnthropicAdapter } from '@lintic/adapters';
import type { StoredMessage } from '@lintic/core';
import { requireToken } from '../middleware/auth.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Reconstruct a Message[] from stored rows, deserialising tool_use assistant turns and tool result rows. */
function buildHistory(storedMessages: StoredMessage[]): Message[] {
  return storedMessages.map((m) => {
    if (m.role === 'assistant') {
      try {
        const parsed = JSON.parse(m.content) as { __type?: string; content: string | null; tool_calls: ToolCall[] };
        if (parsed.__type === 'tool_use') {
          return { role: 'assistant', content: parsed.content, tool_calls: parsed.tool_calls };
        }
      } catch {
        // Not JSON — plain text assistant message.
      }
      return { role: 'assistant', content: m.content };
    }
    if (m.role === 'tool') {
      try {
        return { role: 'tool', content: null, tool_results: JSON.parse(m.content) as ToolResult[] };
      } catch {
        return { role: 'tool', content: m.content };
      }
    }
    return { role: m.role as MessageRole, content: m.content };
  });
}

function isAgentConfig(v: unknown): v is AgentConfig {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c['provider'] === 'string' && typeof c['api_key'] === 'string' && typeof c['model'] === 'string';
}

/** Create a fresh adapter from an AgentConfig provided in the request body. */
async function createPerRequestAdapter(agentConfig: AgentConfig): Promise<AgentAdapter> {
  const adapter: AgentAdapter =
    agentConfig.provider === 'anthropic-native' ? new AnthropicAdapter() : new OpenAIAdapter();
  await adapter.init(agentConfig);
  return adapter;
}

/** Return the per-request adapter if agent_config was provided in the body; otherwise fall back to the default. */
async function resolveAdapter(defaultAdapter: AgentAdapter, agentConfigBody: unknown): Promise<AgentAdapter> {
  if (isAgentConfig(agentConfigBody)) {
    return createPerRequestAdapter(agentConfigBody);
  }
  return defaultAdapter;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createApiRouter(db: DatabaseAdapter, adapter: AgentAdapter, config: Config): Router {
  const router = Router();

  // POST /api/sessions — create a new session
  router.post('/sessions', asyncRoute(async (req, res) => {
    const body = req.body as { prompt_id?: unknown; candidate_email?: unknown };

    if (typeof body.prompt_id !== 'string' || !body.prompt_id) {
      res.status(400).json({ error: 'prompt_id is required' });
      return;
    }
    if (typeof body.candidate_email !== 'string' || !body.candidate_email) {
      res.status(400).json({ error: 'candidate_email is required' });
      return;
    }

    const { id, token } = await db.createSession({
      prompt_id: body.prompt_id,
      candidate_email: body.candidate_email,
      constraint: config.constraints,
    });

    res.status(201).json({
      session_id: id,
      token,
      assessment_link: `/assessment/${id}?token=${token}`,
    });
  }));

  // GET /api/sessions/:id — get session state with remaining constraints
  router.get('/sessions/:id', requireToken(db), asyncRoute(async (req, res) => {
    const session = await db.getSession(req.params['id'] as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const elapsed = (Date.now() - session.created_at) / 1000;
    const timeLimitSeconds = session.constraint.time_limit_minutes * 60;
    const constraints_remaining: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, session.constraint.max_session_tokens - session.tokens_used),
      interactions_remaining: Math.max(0, session.constraint.max_interactions - session.interactions_used),
      seconds_remaining: Math.max(0, timeLimitSeconds - elapsed),
    };

    res.json({ session, constraints_remaining });
  }));

  // POST /api/sessions/:id/messages — single LLM call; stores tool_calls in DB if stop_reason='tool_use'
  router.post('/sessions/:id/messages', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as { message?: unknown; agent_config?: unknown };

    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }
    const message = body.message;

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'active') {
      res.status(409).json({ error: 'Session is not active' });
      return;
    }

    const elapsed = (Date.now() - session.created_at) / 1000;
    const timeLimitSeconds = session.constraint.time_limit_minutes * 60;
    if (
      session.tokens_used >= session.constraint.max_session_tokens ||
      session.interactions_used >= session.constraint.max_interactions ||
      elapsed >= timeLimitSeconds
    ) {
      res.status(429).json({ error: 'Session constraints exhausted' });
      return;
    }

    const storedMessages = await db.getMessages(sessionId);
    const history: Message[] = buildHistory(storedMessages);

    const constraints_remaining: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, session.constraint.max_session_tokens - session.tokens_used),
      interactions_remaining: Math.max(0, session.constraint.max_interactions - session.interactions_used),
      seconds_remaining: Math.max(0, timeLimitSeconds - elapsed),
    };

    const context: SessionContext = { session_id: sessionId, history, constraints_remaining };

    const reqAdapter = await resolveAdapter(adapter, body.agent_config);

    let agentResponse;
    try {
      agentResponse = await reqAdapter.sendMessage(message, context);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown adapter error';
      res.status(502).json({ error: `Agent adapter error: ${errMsg}` });
      return;
    }

    // Persist user message
    await db.addMessage(sessionId, 'user', message, 0);

    // Persist assistant message — encode tool_calls as JSON when stop_reason='tool_use'
    const assistantContent =
      agentResponse.stop_reason === 'tool_use' && agentResponse.tool_calls?.length
        ? JSON.stringify({ __type: 'tool_use', content: agentResponse.content, tool_calls: agentResponse.tool_calls })
        : (agentResponse.content ?? '');
    await db.addMessage(sessionId, 'assistant', assistantContent, agentResponse.usage.completion_tokens);

    // Update usage counters (+1 interaction for the initial user message)
    await db.updateSessionUsage(sessionId, agentResponse.usage.total_tokens, 1);

    // Record replay events
    const now = Date.now();
    await db.addReplayEvent(sessionId, 'message', now, { role: 'user', content: message });
    await db.addReplayEvent(sessionId, 'agent_response', now, {
      content: agentResponse.content,
      stop_reason: agentResponse.stop_reason,
      usage: agentResponse.usage,
    });
    await db.addReplayEvent(sessionId, 'resource_usage', now, {
      prompt_tokens: agentResponse.usage.prompt_tokens,
      completion_tokens: agentResponse.usage.completion_tokens,
      total_tokens: agentResponse.usage.total_tokens,
    });

    const updatedConstraints: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, constraints_remaining.tokens_remaining - agentResponse.usage.total_tokens),
      interactions_remaining: Math.max(0, constraints_remaining.interactions_remaining - 1),
      seconds_remaining: constraints_remaining.seconds_remaining,
    };

    res.json({
      content: agentResponse.content,
      stop_reason: agentResponse.stop_reason,
      tool_calls: agentResponse.tool_calls ?? [],
      usage: agentResponse.usage,
      constraints_remaining: updatedConstraints,
    });
  }));

  // POST /api/sessions/:id/tool-results — round-trip continuation: store tool results and make one LLM call
  router.post('/sessions/:id/tool-results', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as { tool_results?: unknown; agent_config?: unknown };

    if (!Array.isArray(body.tool_results)) {
      res.status(400).json({ error: 'tool_results must be a non-empty array' });
      return;
    }

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'active') {
      res.status(409).json({ error: 'Session is not active' });
      return;
    }

    const elapsed = (Date.now() - session.created_at) / 1000;
    const timeLimitSeconds = session.constraint.time_limit_minutes * 60;
    if (
      session.tokens_used >= session.constraint.max_session_tokens ||
      elapsed >= timeLimitSeconds
    ) {
      res.status(429).json({ error: 'Session constraints exhausted' });
      return;
    }

    const toolResults = body.tool_results as ToolResult[];

    // Persist tool results
    await db.addMessage(sessionId, 'tool', JSON.stringify(toolResults), 0);

    // Rebuild history (now includes the tool results we just stored)
    const storedMessages = await db.getMessages(sessionId);
    const history: Message[] = buildHistory(storedMessages);

    const constraints_remaining: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, session.constraint.max_session_tokens - session.tokens_used),
      interactions_remaining: Math.max(0, session.constraint.max_interactions - session.interactions_used),
      seconds_remaining: Math.max(0, timeLimitSeconds - elapsed),
    };

    const context: SessionContext = { session_id: sessionId, history, constraints_remaining };

    const reqAdapter = await resolveAdapter(adapter, body.agent_config);

    // Continuation call — history already ends with tool results; pass null as message
    let agentResponse;
    try {
      agentResponse = await reqAdapter.sendMessage(null, context);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown adapter error';
      res.status(502).json({ error: `Agent adapter error: ${errMsg}` });
      return;
    }

    // Persist assistant response
    const assistantContent =
      agentResponse.stop_reason === 'tool_use' && agentResponse.tool_calls?.length
        ? JSON.stringify({ __type: 'tool_use', content: agentResponse.content, tool_calls: agentResponse.tool_calls })
        : (agentResponse.content ?? '');
    await db.addMessage(sessionId, 'assistant', assistantContent, agentResponse.usage.completion_tokens);

    // Tool-results continuations count tokens but NOT an additional interaction
    await db.updateSessionUsage(sessionId, agentResponse.usage.total_tokens, 0);

    // Record replay events
    const now = Date.now();
    await db.addReplayEvent(sessionId, 'tool_result', now, { tool_results: toolResults });
    await db.addReplayEvent(sessionId, 'agent_response', now, {
      content: agentResponse.content,
      stop_reason: agentResponse.stop_reason,
      usage: agentResponse.usage,
    });
    await db.addReplayEvent(sessionId, 'resource_usage', now, {
      prompt_tokens: agentResponse.usage.prompt_tokens,
      completion_tokens: agentResponse.usage.completion_tokens,
      total_tokens: agentResponse.usage.total_tokens,
    });

    const updatedConstraints: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, constraints_remaining.tokens_remaining - agentResponse.usage.total_tokens),
      interactions_remaining: constraints_remaining.interactions_remaining,
      seconds_remaining: constraints_remaining.seconds_remaining,
    };

    res.json({
      content: agentResponse.content,
      stop_reason: agentResponse.stop_reason,
      tool_calls: agentResponse.tool_calls ?? [],
      usage: agentResponse.usage,
      constraints_remaining: updatedConstraints,
    });
  }));

  // GET /api/sessions/:id/messages — full conversation history
  router.get('/sessions/:id/messages', requireToken(db), asyncRoute(async (req, res) => {
    const session = await db.getSession(req.params['id'] as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messages = await db.getMessages(req.params['id'] as string);
    res.json({ messages });
  }));

  // GET /api/sessions/:id/replay — session recording for review
  router.get('/sessions/:id/replay', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const stored = await db.getReplayEvents(sessionId);
    const recording = {
      session_id: sessionId,
      events: stored.map((e) => ({ type: e.type, timestamp: e.timestamp, payload: e.payload })),
    };

    res.json(recording);
  }));

  // POST /api/sessions/:id/close — mark session as completed
  router.post('/sessions/:id/close', requireToken(db), asyncRoute(async (req, res) => {
    const session = await db.getSession(req.params['id'] as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await db.closeSession(req.params['id'] as string);
    res.json({ status: 'completed' });
  }));

  return router;
}
