import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import type { DatabaseAdapter, AgentAdapter, Config, Message, ConstraintsRemaining, SessionContext, SessionRecording } from '@lintic/core';
import { requireToken } from '../middleware/auth.js';

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

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

  // POST /api/sessions/:id/messages — proxy candidate message through constraint enforcer and agent adapter
  router.post('/sessions/:id/messages', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as { message?: unknown };

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

    // Check constraints
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

    // Build conversation history for the adapter
    const storedMessages = await db.getMessages(sessionId);
    const history: Message[] = storedMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const constraints_remaining: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, session.constraint.max_session_tokens - session.tokens_used),
      interactions_remaining: Math.max(0, session.constraint.max_interactions - session.interactions_used),
      seconds_remaining: Math.max(0, timeLimitSeconds - elapsed),
    };

    const context: SessionContext = {
      session_id: sessionId,
      history,
      constraints_remaining,
    };

    // Proxy through agent adapter
    let agentResponse;
    try {
      agentResponse = await adapter.sendMessage(message, context);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown adapter error';
      res.status(502).json({ error: `Agent adapter error: ${errMsg}` });
      return;
    }

    // Persist messages and update usage counters
    await db.addMessage(sessionId, 'user', message, 0);
    await db.addMessage(
      sessionId,
      'assistant',
      agentResponse.content ?? '',
      agentResponse.usage.completion_tokens,
    );
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

    res.json({
      content: agentResponse.content,
      tool_calls: agentResponse.tool_calls,
      usage: agentResponse.usage,
      stop_reason: agentResponse.stop_reason,
      constraints_remaining: {
        tokens_remaining: Math.max(0, constraints_remaining.tokens_remaining - agentResponse.usage.total_tokens),
        interactions_remaining: Math.max(0, constraints_remaining.interactions_remaining - 1),
        seconds_remaining: constraints_remaining.seconds_remaining,
      },
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
    const recording: SessionRecording = {
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
