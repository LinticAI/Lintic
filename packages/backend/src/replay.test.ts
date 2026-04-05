import { describe, test, expect } from 'vitest';
import request from 'supertest';
import type {
  AssessmentLinkRecord,
  DatabaseAdapter,
  AgentAdapter,
  AgentConfig,
  AgentResponse,
  AgentCapabilities,
  TokenUsage,
  ToolDefinition,
  SessionContext,
  Session,
  StoredMessage,
  StoredReplayEvent,
  CreateAssessmentLinkConfig,
  CreateSessionConfig,
  MessageRole,
  ReplayEventType,
  Config,
  Constraint,
  SessionBranch,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
  SnapshotFile,
  MockPgPoolExport,
  WorkspaceSection,
} from '@lintic/core';
import { createApp } from './app.js';

// ─── Fake DatabaseAdapter ────────────────────────────────────────────────────

const BASE_CONSTRAINT: Constraint = {
  max_session_tokens: 10000,
  max_message_tokens: 2000,
  max_interactions: 20,
  context_window: 8000,
  time_limit_minutes: 60,
};

class FakeDb implements DatabaseAdapter {
  sessions = new Map<string, Session & { token: string }>();
  branches = new Map<string, SessionBranch[]>();
  messageStore = new Map<string, StoredMessage[]>();
  replayStore = new Map<string, StoredReplayEvent[]>();
  workspaceSnapshots = new Map<string, WorkspaceSnapshot[]>();
  assessmentLinks = new Map<string, AssessmentLinkRecord>();
  usedAssessmentLinks = new Map<string, string>();
  turnSequences = new Map<string, number>();
  nextMsgId = 1;
  nextReplayId = 1;

  private branchKey(sessionId: string, branchId: string): string {
    return `${sessionId}:${branchId}`;
  }

  private getOrCreateMainBranch(sessionId: string): SessionBranch {
    const existing = this.branches.get(sessionId)?.find((branch) => branch.name === 'main');
    if (existing) {
      return existing;
    }

    const branch: SessionBranch = {
      id: 'main',
      session_id: sessionId,
      name: 'main',
      created_at: Date.now(),
    };
    this.branches.set(sessionId, [branch]);
    return branch;
  }

  private getSnapshotKey(sessionId: string, branchId: string): string {
    return `${sessionId}:${branchId}`;
  }

  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }> {
    const id = `sess-${this.sessions.size + 1}`;
    const token = 'test-token-abc';
    const session = {
      id,
      token,
      prompt_id: config.prompt_id,
      candidate_email: config.candidate_email,
      status: 'active' as const,
      created_at: Date.now(),
      constraint: config.constraint,
      tokens_used: 0,
      interactions_used: 0,
    };
    this.sessions.set(id, session);
    const mainBranch = this.getOrCreateMainBranch(id);
    this.messageStore.set(this.branchKey(id, mainBranch.id), []);
    this.replayStore.set(this.branchKey(id, mainBranch.id), []);
    this.workspaceSnapshots.set(this.getSnapshotKey(id, mainBranch.id), []);
    return Promise.resolve({ id, token });
  }

  createAssessmentLink(config: CreateAssessmentLinkConfig): Promise<AssessmentLinkRecord> {
    const link: AssessmentLinkRecord = {
      id: config.id,
      token: config.token,
      url: config.url,
      prompt_id: config.prompt_id,
      candidate_email: config.candidate_email,
      created_at: config.created_at,
      expires_at: config.expires_at,
      constraint: config.constraint,
    };
    this.assessmentLinks.set(link.id, link);
    return Promise.resolve(link);
  }

  getSession(id: string): Promise<Session | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  getSessionToken(id: string): Promise<string | null> {
    return Promise.resolve(this.sessions.get(id)?.token ?? null);
  }

  getMainBranch(sessionId: string): Promise<SessionBranch | null> {
    return Promise.resolve(this.getOrCreateMainBranch(sessionId));
  }

  getBranch(sessionId: string, branchId: string): Promise<SessionBranch | null> {
    return Promise.resolve(this.branches.get(sessionId)?.find((branch) => branch.id === branchId) ?? null);
  }

  listBranches(sessionId: string): Promise<SessionBranch[]> {
    return Promise.resolve(this.branches.get(sessionId) ?? [this.getOrCreateMainBranch(sessionId)]);
  }

  createBranch(config: {
    session_id: string;
    name: string;
    parent_branch_id: string;
    forked_from_sequence: number;
  }): Promise<SessionBranch> {
    const branch: SessionBranch = {
      id: `${config.name}-${(this.branches.get(config.session_id)?.length ?? 0) + 1}`,
      session_id: config.session_id,
      name: config.name,
      parent_branch_id: config.parent_branch_id,
      forked_from_sequence: config.forked_from_sequence,
      created_at: Date.now(),
    };
    const branches = this.branches.get(config.session_id) ?? [this.getOrCreateMainBranch(config.session_id)];
    this.branches.set(config.session_id, [...branches, branch]);

    const parentMessages = this.messageStore.get(this.branchKey(config.session_id, config.parent_branch_id)) ?? [];
    this.messageStore.set(
      this.branchKey(config.session_id, branch.id),
      parentMessages
        .filter((message) => message.turn_sequence !== null && (message.turn_sequence ?? 0) <= config.forked_from_sequence)
        .map((message) => ({ ...message, branch_id: branch.id })),
    );

    const parentEvents = this.replayStore.get(this.branchKey(config.session_id, config.parent_branch_id)) ?? [];
    this.replayStore.set(
      this.branchKey(config.session_id, branch.id),
      parentEvents
        .filter((event) => event.turn_sequence !== null && (event.turn_sequence ?? 0) <= config.forked_from_sequence)
        .map((event) => ({ ...event, branch_id: branch.id })),
    );

    const parentSnapshots = this.workspaceSnapshots.get(this.getSnapshotKey(config.session_id, config.parent_branch_id)) ?? [];
    this.workspaceSnapshots.set(
      this.getSnapshotKey(config.session_id, branch.id),
      parentSnapshots.length > 0
        ? [{
            ...parentSnapshots[parentSnapshots.length - 1]!,
            id: `${branch.id}-draft`,
            branch_id: branch.id,
            kind: 'draft',
            created_at: Date.now(),
          }]
        : [],
    );

    return Promise.resolve(branch);
  }

  allocateTurnSequence(sessionId: string): Promise<number> {
    const next = (this.turnSequences.get(sessionId) ?? 0) + 1;
    this.turnSequences.set(sessionId, next);
    return Promise.resolve(next);
  }

  addBranchMessage(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    role: MessageRole,
    content: string,
    tokenCount: number,
  ): Promise<void> {
    const key = this.branchKey(sessionId, branchId);
    const msgs = this.messageStore.get(key) ?? [];
    msgs.push({
      id: this.nextMsgId++,
      session_id: sessionId,
      branch_id: branchId,
      turn_sequence: turnSequence,
      role,
      content,
      token_count: tokenCount,
      created_at: Date.now(),
    });
    this.messageStore.set(key, msgs);
    return Promise.resolve();
  }

  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    return this.addBranchMessage(sessionId, 'main', null, role, content, tokenCount);
  }

  getBranchMessages(sessionId: string, branchId: string): Promise<StoredMessage[]> {
    return Promise.resolve(this.messageStore.get(this.branchKey(sessionId, branchId)) ?? []);
  }

  getMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.getBranchMessages(sessionId, 'main');
  }

  closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, { ...session, status: 'completed', closed_at: Date.now() });
    }
    return Promise.resolve();
  }

  listSessions(): Promise<Session[]> {
    return Promise.resolve([...this.sessions.values()]);
  }

  getSessionsByPrompt(promptId: string): Promise<Session[]> {
    return Promise.resolve([...this.sessions.values()].filter((s) => s.prompt_id === promptId));
  }

  listAssessmentLinks(): Promise<AssessmentLinkRecord[]> {
    return Promise.resolve(
      [...this.assessmentLinks.values()].sort((a, b) => b.created_at - a.created_at),
    );
  }

  getAssessmentLink(id: string): Promise<AssessmentLinkRecord | null> {
    return Promise.resolve(this.assessmentLinks.get(id) ?? null);
  }

  validateSessionToken(id: string, token: string): Promise<boolean> {
    const session = this.sessions.get(id);
    return Promise.resolve(session?.token === token);
  }

  updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, {
        ...session,
        tokens_used: session.tokens_used + additionalTokens,
        interactions_used: session.interactions_used + additionalInteractions,
      });
    }
    return Promise.resolve();
  }

  addBranchReplayEvent(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    type: ReplayEventType,
    timestamp: number,
    payload: unknown,
  ): Promise<void> {
    const key = this.branchKey(sessionId, branchId);
    const events = this.replayStore.get(key) ?? [];
    events.push({
      id: this.nextReplayId++,
      session_id: sessionId,
      branch_id: branchId,
      turn_sequence: turnSequence,
      type,
      timestamp,
      payload,
    });
    this.replayStore.set(key, events);
    return Promise.resolve();
  }

  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void> {
    return this.addBranchReplayEvent(sessionId, 'main', null, type, timestamp, payload);
  }

  getBranchReplayEvents(sessionId: string, branchId: string): Promise<StoredReplayEvent[]> {
    return Promise.resolve(this.replayStore.get(this.branchKey(sessionId, branchId)) ?? []);
  }

  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    return this.getBranchReplayEvents(sessionId, 'main');
  }

  upsertWorkspaceSnapshot(input: {
    session_id: string;
    branch_id: string;
    kind: WorkspaceSnapshotKind;
    turn_sequence?: number;
    label?: string;
    active_path?: string;
    workspace_section?: WorkspaceSection;
    filesystem: SnapshotFile[];
    mock_pg: MockPgPoolExport[];
  }): Promise<WorkspaceSnapshot> {
    const key = this.getSnapshotKey(input.session_id, input.branch_id);
    const snapshots = this.workspaceSnapshots.get(key) ?? [];
    if (input.kind === 'draft') {
      const existingIndex = snapshots.findIndex((snapshot) => snapshot.kind === 'draft');
      if (existingIndex >= 0) {
        const snapshot: WorkspaceSnapshot = {
          id: snapshots[existingIndex]!.id,
          session_id: input.session_id,
          branch_id: input.branch_id,
          kind: input.kind,
          created_at: Date.now(),
          filesystem: input.filesystem,
          mock_pg: input.mock_pg,
          ...(input.turn_sequence !== undefined ? { turn_sequence: input.turn_sequence } : {}),
          ...(input.label ? { label: input.label } : {}),
          ...(input.active_path ? { active_path: input.active_path } : {}),
          ...(input.workspace_section ? { workspace_section: input.workspace_section } : {}),
        };
        snapshots[existingIndex] = snapshot;
        this.workspaceSnapshots.set(key, snapshots);
        return Promise.resolve(snapshot);
      }
    }
    return this.createWorkspaceSnapshot(input);
  }

  createWorkspaceSnapshot(input: {
    session_id: string;
    branch_id: string;
    kind: WorkspaceSnapshotKind;
    turn_sequence?: number;
    label?: string;
    active_path?: string;
    workspace_section?: WorkspaceSection;
    filesystem: SnapshotFile[];
    mock_pg: MockPgPoolExport[];
  }): Promise<WorkspaceSnapshot> {
    const key = this.getSnapshotKey(input.session_id, input.branch_id);
    const snapshots = this.workspaceSnapshots.get(key) ?? [];
    const snapshot: WorkspaceSnapshot = {
      id: `${key}:${input.kind}:${snapshots.length + 1}`,
      session_id: input.session_id,
      branch_id: input.branch_id,
      kind: input.kind,
      created_at: Date.now(),
      filesystem: input.filesystem,
      mock_pg: input.mock_pg,
      ...(input.turn_sequence !== undefined ? { turn_sequence: input.turn_sequence } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.active_path ? { active_path: input.active_path } : {}),
      ...(input.workspace_section ? { workspace_section: input.workspace_section } : {}),
    };
    this.workspaceSnapshots.set(key, [...snapshots, snapshot]);
    return Promise.resolve(snapshot);
  }

  getWorkspaceSnapshot(
    sessionId: string,
    branchId: string,
    options: { kind?: WorkspaceSnapshotKind; turn_sequence?: number } = {},
  ): Promise<WorkspaceSnapshot | null> {
    const snapshots = this.workspaceSnapshots.get(this.getSnapshotKey(sessionId, branchId)) ?? [];
    const filtered = snapshots.filter((snapshot) => (
      (options.kind === undefined || snapshot.kind === options.kind)
      && (options.turn_sequence === undefined || snapshot.turn_sequence === options.turn_sequence)
    ));
    return Promise.resolve(filtered.at(-1) ?? null);
  }

  markAssessmentLinkUsed(linkId: string, _sessionId: string): Promise<boolean> {
    if (this.usedAssessmentLinks.has(linkId)) {
      return Promise.resolve(false);
    }
    const link = this.assessmentLinks.get(linkId);
    if (link) {
      this.assessmentLinks.set(linkId, {
        ...link,
        consumed_session_id: _sessionId,
        consumed_at: Date.now(),
      });
    }
    this.usedAssessmentLinks.set(linkId, _sessionId);
    return Promise.resolve(true);
  }

  isAssessmentLinkUsed(linkId: string): Promise<boolean> {
    return Promise.resolve(this.usedAssessmentLinks.has(linkId));
  }

  getAssessmentLinkSessionId(linkId: string): Promise<string | null> {
    return Promise.resolve(this.usedAssessmentLinks.get(linkId) ?? null);
  }
}

// ─── Fake AgentAdapter ────────────────────────────────────────────────────────

class FakeAdapter implements AgentAdapter {
  lastUsage: TokenUsage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };

  init(_config: AgentConfig): Promise<void> {
    return Promise.resolve();
  }

  sendMessage(_msg: string, _ctx: SessionContext): Promise<AgentResponse> {
    return Promise.resolve({
      content: 'Hello from the agent!',
      usage: this.lastUsage,
      stop_reason: 'end_turn',
    });
  }

  getTokenUsage(): TokenUsage {
    return this.lastUsage;
  }

  getCapabilities(): AgentCapabilities {
    return { supports_system_prompt: true, supports_tool_use: false, max_context_window: 8000 };
  }

  getTools(): ToolDefinition[] {
    return [];
  }
}

const TEST_CONFIG: Config = {
  agent: { provider: 'openai-compatible', api_key: 'key', model: 'gpt-4o', base_url: 'https://api.openai.com' },
  constraints: BASE_CONSTRAINT,
  prompts: [{ id: 'test-prompt', title: 'Test Prompt' }],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/sessions/:id/replay', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get(`/api/sessions/${id}/replay`);
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid token', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  test('returns 404 for unknown session', async () => {
    const db = new FakeDb();
    db.sessions.set('ghost', {
      id: 'ghost', token: 'tok', prompt_id: 'p', candidate_email: 'e@e.com',
      status: 'active', created_at: Date.now(), constraint: BASE_CONSTRAINT,
      tokens_used: 0, interactions_used: 0,
    });
    db.getSession = (): Promise<Session | null> => Promise.resolve(null);
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .get('/api/sessions/ghost/replay')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
  });

  test('returns 200 with empty events array before any messages', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(0);
  });

  test('returns session_id in response body', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);
    const body = res.body as { session_id: string };
    expect(body.session_id).toBe(id);
  });

  test('after sending a message, replay contains message, agent_response, and resource_usage events', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { events: Array<{ type: string }> };
    const types = body.events.map((e) => e.type);
    expect(types).toContain('message');
    expect(types).toContain('agent_response');
    expect(types).toContain('resource_usage');
  });

  test('events have a timestamp field', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ timestamp: number }> };
    for (const event of body.events) {
      expect(typeof event.timestamp).toBe('number');
    }
  });

  test('message event payload contains role and content', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Write a test' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ type: string; payload: { role: string; content: string } }> };
    const messageEvent = body.events.find((e) => e.type === 'message');
    expect(messageEvent?.payload.role).toBe('user');
    expect(messageEvent?.payload.content).toBe('Write a test');
  });

  test('agent_response event payload contains content, stop_reason, and usage', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ type: string; payload: { content: string; stop_reason: string; usage: unknown } }> };
    const agentEvent = body.events.find((e) => e.type === 'agent_response');
    expect(agentEvent?.payload.content).toBe('Hello from the agent!');
    expect(agentEvent?.payload.stop_reason).toBe('end_turn');
    expect(agentEvent?.payload.usage).toBeDefined();
  });

  test('resource_usage event payload contains total_tokens', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ type: string; payload: { total_tokens: number } }> };
    const usageEvent = body.events.find((e) => e.type === 'resource_usage');
    expect(typeof usageEvent?.payload.total_tokens).toBe('number');
    expect(usageEvent?.payload.total_tokens).toBe(30);
  });

  test('events have a payload field', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

    const body = res.body as { events: Array<{ payload: unknown }> };
    for (const event of body.events) {
      expect(event.payload).toBeDefined();
    }
  });
});
