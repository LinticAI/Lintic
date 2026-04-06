import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ConversationSummary,
  ContextAttachment,
  ContextResource,
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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    prompt_id: 'test-prompt',
    candidate_email: 'candidate@example.com',
    status: 'active',
    created_at: Date.now(),
    constraint: BASE_CONSTRAINT,
    tokens_used: 0,
    interactions_used: 0,
    ...overrides,
  };
}

class FakeDb implements DatabaseAdapter {
  sessions = new Map<string, Session & { token: string }>();
  branches = new Map<string, SessionBranch[]>();
  conversations = new Map<string, ConversationSummary[]>();
  messageStore = new Map<string, StoredMessage[]>();
  replayStore = new Map<string, StoredReplayEvent[]>();
  workspaceSnapshots = new Map<string, WorkspaceSnapshot[]>();
  contextAttachmentStore = new Map<string, ContextAttachment[]>();
  contextResourceStore = new Map<string, ContextResource[]>();
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

  private getOrCreateMainConversation(sessionId: string, branchId: string): ConversationSummary {
    const existing = this.conversations.get(sessionId)?.find((conversation) => (
      conversation.branch_id === branchId && conversation.title === 'main'
    ));
    if (existing) {
      return existing;
    }

    const conversation: ConversationSummary = {
      id: `${branchId}-main-conversation`,
      session_id: sessionId,
      branch_id: branchId,
      title: 'main',
      archived: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const conversations = this.conversations.get(sessionId) ?? [];
    this.conversations.set(sessionId, [...conversations, conversation]);
    this.contextAttachmentStore.set(conversation.id, []);
    return conversation;
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
    this.getOrCreateMainConversation(id, mainBranch.id);
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

  getMainConversation(sessionId: string, branchId: string): Promise<ConversationSummary | null> {
    return Promise.resolve(this.getOrCreateMainConversation(sessionId, branchId));
  }

  getConversation(sessionId: string, conversationId: string): Promise<ConversationSummary | null> {
    return Promise.resolve(this.conversations.get(sessionId)?.find((conversation) => conversation.id === conversationId) ?? null);
  }

  listConversations(sessionId: string, branchId: string): Promise<ConversationSummary[]> {
    return Promise.resolve(
      (this.conversations.get(sessionId) ?? [])
        .filter((conversation) => conversation.branch_id === branchId)
        .sort((a, b) => b.updated_at - a.updated_at),
    );
  }

  createConversation(config: {
    session_id: string;
    branch_id: string;
    title?: string;
    archived?: boolean;
  }): Promise<ConversationSummary> {
    const conversation: ConversationSummary = {
      id: `${config.branch_id}-conversation-${(this.conversations.get(config.session_id)?.length ?? 0) + 1}`,
      session_id: config.session_id,
      branch_id: config.branch_id,
      title: config.title ?? 'New chat',
      archived: config.archived ?? false,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const conversations = this.conversations.get(config.session_id) ?? [];
    this.conversations.set(config.session_id, [...conversations, conversation]);
    this.contextAttachmentStore.set(conversation.id, []);
    return Promise.resolve(conversation);
  }

  updateConversation(config: {
    session_id: string;
    conversation_id: string;
    title?: string;
    archived?: boolean;
  }): Promise<ConversationSummary | null> {
    const conversations = this.conversations.get(config.session_id) ?? [];
    const index = conversations.findIndex((conversation) => conversation.id === config.conversation_id);
    if (index < 0) {
      return Promise.resolve(null);
    }
    const updated: ConversationSummary = {
      ...conversations[index]!,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ...(config.archived !== undefined ? { archived: config.archived } : {}),
      updated_at: Date.now(),
    };
    conversations[index] = updated;
    this.conversations.set(config.session_id, [...conversations]);
    return Promise.resolve(updated);
  }

  createBranch(config: {
    session_id: string;
    name: string;
    parent_branch_id: string;
    forked_from_sequence: number;
    conversation_id?: string;
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
    const sourceConversation = config.conversation_id
      ? this.conversations.get(config.session_id)?.find((conversation) => conversation.id === config.conversation_id)
      : this.getOrCreateMainConversation(config.session_id, config.parent_branch_id);
    const mainConversation = this.getOrCreateMainConversation(config.session_id, branch.id);

    const parentMessages = this.messageStore.get(this.branchKey(config.session_id, config.parent_branch_id)) ?? [];
    this.messageStore.set(
      this.branchKey(config.session_id, branch.id),
      parentMessages
        .filter((message) => (
          message.turn_sequence !== null
          && (message.turn_sequence ?? 0) <= config.forked_from_sequence
          && (!sourceConversation || message.conversation_id === sourceConversation.id)
        ))
        .map((message) => ({ ...message, branch_id: branch.id, conversation_id: mainConversation.id })),
    );

    const parentEvents = this.replayStore.get(this.branchKey(config.session_id, config.parent_branch_id)) ?? [];
    this.replayStore.set(
      this.branchKey(config.session_id, branch.id),
      parentEvents
        .filter((event) => (
          event.turn_sequence !== null
          && (event.turn_sequence ?? 0) <= config.forked_from_sequence
          && (!sourceConversation || event.conversation_id === sourceConversation.id)
        ))
        .map((event) => ({ ...event, branch_id: branch.id, conversation_id: mainConversation.id })),
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
    conversationId?: string,
  ): Promise<void> {
    const key = this.branchKey(sessionId, branchId);
    const msgs = this.messageStore.get(key) ?? [];
    const resolvedConversationId = conversationId ?? this.getOrCreateMainConversation(sessionId, branchId).id;
    msgs.push({
      id: this.nextMsgId++,
      session_id: sessionId,
      branch_id: branchId,
      conversation_id: resolvedConversationId,
      turn_sequence: turnSequence,
      role,
      content,
      token_count: tokenCount,
      created_at: Date.now(),
      rewound_at: null,
    });
    this.messageStore.set(key, msgs);
    const conversations = this.conversations.get(sessionId) ?? [];
    const index = conversations.findIndex((conversation) => conversation.id === resolvedConversationId);
    if (index >= 0) {
      conversations[index] = { ...conversations[index]!, updated_at: Date.now() };
      this.conversations.set(sessionId, [...conversations]);
    }
    return Promise.resolve();
  }

  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    return this.addBranchMessage(sessionId, 'main', null, role, content, tokenCount);
  }

  getBranchMessages(sessionId: string, branchId: string, conversationId?: string, _options?: { includeRewound?: boolean }): Promise<StoredMessage[]> {
    const messages = this.messageStore.get(this.branchKey(sessionId, branchId)) ?? [];
    return Promise.resolve(conversationId ? messages.filter((message) => message.conversation_id === conversationId) : messages);
  }

  rewindMessages(
    _sessionId: string,
    _branchId: string,
    _conversationId: string,
    _afterTurnSequence: number,
  ): Promise<void> {
    return Promise.resolve();
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
    conversationId?: string,
  ): Promise<void> {
    const key = this.branchKey(sessionId, branchId);
    const events = this.replayStore.get(key) ?? [];
    const resolvedConversationId = conversationId ?? this.getOrCreateMainConversation(sessionId, branchId).id;
    events.push({
      id: this.nextReplayId++,
      session_id: sessionId,
      branch_id: branchId,
      conversation_id: resolvedConversationId,
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

  getBranchReplayEvents(sessionId: string, branchId: string, conversationId?: string): Promise<StoredReplayEvent[]> {
    const events = this.replayStore.get(this.branchKey(sessionId, branchId)) ?? [];
    return Promise.resolve(conversationId ? events.filter((event) => event.conversation_id === conversationId) : events);
  }

  listConversationContextAttachments(conversationId: string): Promise<ContextAttachment[]> {
    return Promise.resolve(this.contextAttachmentStore.get(conversationId) ?? []);
  }

  replaceConversationContextAttachments(
    conversationId: string,
    attachments: Array<{
      kind: ContextAttachment['kind'];
      label: string;
      path?: string;
      resource_id?: string;
      source_conversation_id?: string;
    }>,
  ): Promise<ContextAttachment[]> {
    const next = attachments.map((attachment, index) => ({
      id: `${conversationId}:attachment:${index + 1}`,
      conversation_id: conversationId,
      kind: attachment.kind,
      label: attachment.label,
      ...(attachment.path ? { path: attachment.path } : {}),
      ...(attachment.resource_id ? { resource_id: attachment.resource_id } : {}),
      ...(attachment.source_conversation_id ? { source_conversation_id: attachment.source_conversation_id } : {}),
      created_at: Date.now() + index,
    }));
    this.contextAttachmentStore.set(conversationId, next);
    return Promise.resolve(next);
  }

  listContextResources(sessionId: string, branchId: string): Promise<ContextResource[]> {
    return Promise.resolve(
      (this.contextResourceStore.get(`${sessionId}:${branchId}`) ?? []).sort((a, b) => b.updated_at - a.updated_at),
    );
  }

  upsertContextResource(input: {
    session_id: string;
    branch_id: string;
    kind: ContextResource['kind'];
    title: string;
    content: string;
    source_conversation_id?: string;
  }): Promise<ContextResource> {
    const key = `${input.session_id}:${input.branch_id}`;
    const resources = this.contextResourceStore.get(key) ?? [];
    const existingIndex = resources.findIndex((resource) => (
      resource.kind === input.kind
      && resource.source_conversation_id === input.source_conversation_id
    ));
    const next: ContextResource = {
      id: existingIndex >= 0 ? resources[existingIndex]!.id : `${key}:${input.kind}:${resources.length + 1}`,
      session_id: input.session_id,
      branch_id: input.branch_id,
      kind: input.kind,
      title: input.title,
      content: input.content,
      created_at: existingIndex >= 0 ? resources[existingIndex]!.created_at : Date.now(),
      updated_at: Date.now(),
      ...(input.source_conversation_id ? { source_conversation_id: input.source_conversation_id } : {}),
    };
    if (existingIndex >= 0) {
      resources[existingIndex] = next;
    } else {
      resources.push(next);
    }
    this.contextResourceStore.set(key, resources);
    return Promise.resolve(next);
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
  lastContext: SessionContext | null = null;
  lastMessage: string | null = null;

  init(_config: AgentConfig): Promise<void> {
    return Promise.resolve();
  }

  sendMessage(_msg: string | null, _ctx: SessionContext): Promise<AgentResponse> {
    this.lastMessage = _msg;
    this.lastContext = _ctx;
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

// ─── Test Config ──────────────────────────────────────────────────────────────

const TEST_CONFIG: Config = {
  agent: { provider: 'openai-compatible', api_key: 'key', model: 'gpt-4o', base_url: 'https://api.openai.com' },
  constraints: BASE_CONSTRAINT,
  prompts: [{ id: 'test-prompt', title: 'Test Prompt' }],
  api: { admin_key: 'admin-key', secret_key: 'secret-key' },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('frontend static serving', () => {
  function createFrontendDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lintic-frontend-dist-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><div id="root">Lintic App</div></body></html>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("asset");');
    return dir;
  }

  test('serves frontend HTML at the root path', async () => {
    const frontendDistPath = createFrontendDist();

    try {
      const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG, { frontendDistPath });
      const res = await request(app).get('/');

      expect(res.status).toBe(200);
      expect(res.text).toContain('Lintic App');
    } finally {
      rmSync(frontendDistPath, { recursive: true, force: true });
    }
  });

  test('falls back to index.html for SPA routes', async () => {
    const frontendDistPath = createFrontendDist();

    try {
      const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG, { frontendDistPath });
      const res = await request(app).get('/review/sess-123');

      expect(res.status).toBe(200);
      expect(res.text).toContain('Lintic App');
    } finally {
      rmSync(frontendDistPath, { recursive: true, force: true });
    }
  });

  test('does not rewrite unknown API routes to the frontend app', async () => {
    const frontendDistPath = createFrontendDist();

    try {
      const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG, { frontendDistPath });
      const res = await request(app).get('/api/unknown');

      expect(res.status).toBe(404);
      expect(res.text).not.toContain('Lintic App');
    } finally {
      rmSync(frontendDistPath, { recursive: true, force: true });
    }
  });
});

describe('GET /api/review/:id', () => {
  test('returns aggregated review data with metrics and replay events', async () => {
    const db = new FakeDb();
    const session = makeSession({
      id: 'sess-review',
      prompt_id: 'test-prompt',
      candidate_email: 'reviewer@example.com',
      tokens_used: 400,
      interactions_used: 1,
      status: 'completed',
    });
    db.sessions.set('sess-review', { ...session, token: 'review-token' });
    db.branches.set('sess-review', [{
      id: 'main',
      session_id: 'sess-review',
      name: 'main',
      created_at: Date.now(),
    }]);
    db.conversations.set('sess-review', [{
      id: 'main-main-conversation',
      session_id: 'sess-review',
      branch_id: 'main',
      title: 'main',
      archived: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    }]);
    db.messageStore.set('sess-review:main', [
      {
        id: 1,
        session_id: 'sess-review',
        branch_id: 'main',
        conversation_id: 'main-main-conversation',
        turn_sequence: 1,
        role: 'user',
        content: 'Build it',
        token_count: 0,
        created_at: Date.now(),
        rewound_at: null,
      },
      {
        id: 2,
        session_id: 'sess-review',
        branch_id: 'main',
        conversation_id: 'main-main-conversation',
        turn_sequence: 1,
        role: 'assistant',
        content: 'Done',
        token_count: 20,
        created_at: Date.now(),
        rewound_at: null,
      },
    ]);
    db.replayStore.set('sess-review:main', [
      {
        id: 1,
        session_id: 'sess-review',
        branch_id: 'main',
        conversation_id: 'main-main-conversation',
        turn_sequence: 1,
        type: 'message',
        timestamp: 1,
        payload: { role: 'user', content: 'Build it' },
      },
      {
        id: 2,
        session_id: 'sess-review',
        branch_id: 'main',
        conversation_id: 'main-main-conversation',
        turn_sequence: 1,
        type: 'agent_response',
        timestamp: 2,
        payload: { content: 'Done', stop_reason: 'end_turn' },
      },
    ]);

    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const res = await request(app).get('/api/review/sess-review');
    const body = res.body as {
      session: { id: string };
      prompt: { title: string };
      metrics: unknown[];
      recording: { events: unknown[] };
    };

    expect(res.status).toBe(200);
    expect(body.session.id).toBe('sess-review');
    expect(body.prompt.title).toBe('Test Prompt');
    expect(Array.isArray(body.metrics)).toBe(true);
    expect(body.metrics).toHaveLength(4);
    expect(body.recording.events).toHaveLength(2);
  });

  test('returns 404 for unknown review session', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app).get('/api/review/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/sessions', () => {
  test('creates a session and returns session_id, token, assessment_link, and prompt metadata', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions')
      .send({ prompt_id: 'test-prompt', candidate_email: 'a@b.com' });

    expect(res.status).toBe(201);
    const body = res.body as {
      session_id: string;
      token: string;
      assessment_link: string;
      prompt: { id: string; title: string };
      agent: { provider: string; model: string };
    };
    expect(typeof body.session_id).toBe('string');
    expect(typeof body.token).toBe('string');
    expect(body.assessment_link).toContain(body.session_id);
    expect(body.prompt).toEqual({ id: 'test-prompt', title: 'Test Prompt' });
    expect(body.agent).toEqual({ provider: 'openai-compatible', model: 'gpt-4o' });
  });

  test('returns 400 when prompt_id is missing', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions')
      .send({ candidate_email: 'a@b.com' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when candidate_email is missing', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions')
      .send({ prompt_id: 'test-prompt' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/links', () => {
  test('creates an assessment link when admin key is valid', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/links')
      .set('X-Lintic-Api-Key', 'admin-key')
      .send({ prompt_id: 'test-prompt', email: 'candidate@example.com' });

    expect(res.status).toBe(201);
    const body = res.body as {
      id: string;
      url: string;
      token: string;
      prompt_id: string;
      candidate_email: string;
      status: string;
      prompt: { id: string; title: string };
    };
    expect(body.id).toBeTruthy();
    expect(body.url).toContain('/assessment?token=');
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.prompt_id).toBe('test-prompt');
    expect(body.candidate_email).toBe('candidate@example.com');
    expect(body.status).toBe('active');
    expect(body.prompt).toEqual({ id: 'test-prompt', title: 'Test Prompt' });
  });

  test('rejects link creation without admin key', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/links')
      .send({ prompt_id: 'test-prompt', email: 'candidate@example.com' });

    expect(res.status).toBe(401);
  });

  test('uses the browser Origin header when generating the assessment URL', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/links')
      .set('X-Lintic-Api-Key', 'admin-key')
      .set('Origin', 'http://localhost:5173')
      .send({ prompt_id: 'test-prompt', email: 'candidate@example.com' });

    expect(res.status).toBe(201);
    expect((res.body as { url: string }).url).toContain('http://localhost:5173/assessment?token=');
  });
});

describe('GET /api/prompts', () => {
  test('returns prompt catalog for admins', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .get('/api/prompts')
      .set('X-Lintic-Api-Key', 'admin-key');

    expect(res.status).toBe(200);
    expect((res.body as { prompts: Array<{ id: string; title: string }> }).prompts).toEqual([
      { id: 'test-prompt', title: 'Test Prompt' },
    ]);
  });
});

describe('POST /api/links/consume', () => {
  test('creates a session from a valid assessment link token', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const linkRes = await request(app)
      .post('/api/links')
      .set('X-Lintic-Api-Key', 'admin-key')
      .send({ prompt_id: 'test-prompt', email: 'candidate@example.com' });

    const token = (linkRes.body as { token: string }).token;
    const consumeRes = await request(app)
      .post('/api/links/consume')
      .send({ token });

    expect(consumeRes.status).toBe(201);
    const body = consumeRes.body as {
      session_id: string;
      token: string;
      prompt_id: string;
      email: string;
      prompt: { id: string; title: string };
      agent: { provider: string; model: string };
    };
    expect(body.session_id).toBeTruthy();
    expect(body.token).toBeTruthy();
    expect(body.prompt_id).toBe('test-prompt');
    expect(body.email).toBe('candidate@example.com');
    expect(body.prompt).toEqual({ id: 'test-prompt', title: 'Test Prompt' });
    expect(body.agent).toEqual({ provider: 'openai-compatible', model: 'gpt-4o' });
  });

  test('rejects an already-used assessment link token', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const linkRes = await request(app)
      .post('/api/links')
      .set('X-Lintic-Api-Key', 'admin-key')
      .send({ prompt_id: 'test-prompt', email: 'candidate@example.com' });
    const token = (linkRes.body as { token: string }).token;

    const first = await request(app).post('/api/links/consume').send({ token });
    const second = await request(app).post('/api/links/consume').send({ token });

    expect(second.status).toBe(200);
    expect((second.body as { session_id: string }).session_id).toBe(
      (first.body as { session_id: string }).session_id,
    );
  });
});

describe('GET /api/links', () => {
  test('requires an admin key', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app).get('/api/links');

    expect(res.status).toBe(401);
  });

  test('returns persisted links with derived statuses', async () => {
    const db = new FakeDb();
    const future = Date.now() + 60_000;
    const past = Date.now() - 60_000;
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);

    const created = await request(app)
      .post('/api/links')
      .set('X-Lintic-Api-Key', 'admin-key')
      .send({ prompt_id: 'test-prompt', email: 'active@example.com' });
    const createdId = (created.body as { id: string }).id;

    db.assessmentLinks.set('active-link', {
      id: 'active-link',
      token: 'unused',
      url: 'http://localhost:3300/assessment?token=active',
      prompt_id: 'missing-prompt',
      candidate_email: 'active@example.com',
      created_at: Date.now(),
      expires_at: future,
      constraint: BASE_CONSTRAINT,
    });
    db.assessmentLinks.set('expired-link', {
      id: 'expired-link',
      token: 'unused',
      url: 'http://localhost:3300/assessment?token=expired',
      prompt_id: 'test-prompt',
      candidate_email: 'expired@example.com',
      created_at: Date.now() - 10_000,
      expires_at: past,
      constraint: BASE_CONSTRAINT,
    });
    db.assessmentLinks.set('consumed-link', {
      id: 'consumed-link',
      token: 'unused',
      url: 'http://localhost:3300/assessment?token=consumed',
      prompt_id: 'test-prompt',
      candidate_email: 'consumed@example.com',
      created_at: Date.now() - 20_000,
      expires_at: future,
      constraint: BASE_CONSTRAINT,
      consumed_session_id: 'sess-42',
      consumed_at: Date.now() - 5_000,
    });

    const res = await request(app)
      .get('/api/links')
      .set('X-Lintic-Api-Key', 'admin-key');

    expect(res.status).toBe(200);
    expect((res.body as { links: Array<{ id: string; status: string }> }).links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: createdId, status: 'active' }),
        expect.objectContaining({ id: 'active-link', status: 'invalid' }),
        expect.objectContaining({ id: 'expired-link', status: 'expired' }),
        expect.objectContaining({ id: 'consumed-link', status: 'consumed' }),
      ]),
    );
  });
});

describe('GET /api/links/:id', () => {
  test('returns full metadata for a persisted link', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    db.assessmentLinks.set('link-1', {
      id: 'link-1',
      token: 'token-1',
      url: 'http://localhost:3300/assessment?token=token-1',
      prompt_id: 'missing-prompt',
      candidate_email: 'candidate@example.com',
      created_at: 1000,
      expires_at: 2000,
      constraint: BASE_CONSTRAINT,
    });

    const res = await request(app)
      .get('/api/links/link-1')
      .set('X-Lintic-Api-Key', 'admin-key');

    expect(res.status).toBe(200);
    expect((res.body as { link: { id: string; token: string; constraint: Constraint; status: string } }).link).toMatchObject({
      id: 'link-1',
      token: 'token-1',
      constraint: BASE_CONSTRAINT,
      status: 'expired',
    });
  });

  test('returns 404 for an unknown persisted link', async () => {
    const app = createApp(new FakeDb(), new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .get('/api/links/missing')
      .set('X-Lintic-Api-Key', 'admin-key');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/sessions/:id', () => {
  test('returns 401 with no auth header', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get('/api/sessions/sess-1');
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid token', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get('/api/sessions/sess-1')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  test('returns 404 for unknown session', async () => {
    const db = new FakeDb();
    // We bypass createSession so no session exists, but we need a token that passes validateSessionToken.
    // validateSessionToken returns false for unknown sessions, so we'd get 401.
    // Instead, seed the session map directly:
    db.sessions.set('unknown-id', { ...makeSession({ id: 'unknown-id' }), token: 'tok' });
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    // Delete from sessions after seeding to trigger 404 path — simpler: use getSession returning null.
    // Use a custom override:
    const origGet = db.getSession.bind(db);
    db.getSession = (id: string): Promise<Session | null> =>
      id === 'unknown-id' ? Promise.resolve(null) : origGet(id);
    const res = await request(app)
      .get('/api/sessions/unknown-id')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
  });

  test('returns session state and constraints_remaining for valid request', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as {
      session: { id: string };
      constraints_remaining: { tokens_remaining: number; interactions_remaining: number; seconds_remaining: number };
      agent: { provider: string; model: string };
    };
    expect(body.session.id).toBe(id);
    expect(typeof body.constraints_remaining.tokens_remaining).toBe('number');
    expect(typeof body.constraints_remaining.interactions_remaining).toBe('number');
    expect(typeof body.constraints_remaining.seconds_remaining).toBe('number');
    expect(body.agent).toEqual({ provider: 'openai-compatible', model: 'gpt-4o' });
  });
});

describe('POST /api/sessions/:id/messages', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(401);
  });

  test('returns 400 when message is missing', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('proxies message through adapter and returns response', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Write a function' });

    expect(res.status).toBe(200);
    const body = res.body as { content: string; stop_reason: string; usage: { total_tokens: number } };
    expect(body.content).toBe('Hello from the agent!');
    expect(body.stop_reason).toBe('end_turn');
    expect(typeof body.usage.total_tokens).toBe('number');
  });

  test('stores user and assistant messages in db', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello agent' });

    const msgs = await db.getMessages(id);
    expect(msgs.some((m) => m.role === 'user')).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  test('updates session usage counters', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const session = await db.getSession(id);
    expect(session?.tokens_used).toBeGreaterThan(0);
    expect(session?.interactions_used).toBe(1);
  });

  test('returns 429 when token budget exhausted', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const exhaustedConstraint: Constraint = { ...BASE_CONSTRAINT, max_session_tokens: 0 };
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: exhaustedConstraint });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(429);
  });

  test('returns 429 when interaction limit exhausted', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const exhaustedConstraint: Constraint = { ...BASE_CONSTRAINT, max_interactions: 0 };
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: exhaustedConstraint });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(429);
  });

  test('returns 409 when session is not active', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    await db.closeSession(id);
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(409);
  });

  test('returns 502 when adapter throws', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    adapter.sendMessage = (): Promise<AgentResponse> => { throw new Error('API down'); };
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(502);
  });

  test('persists the user message even when the adapter throws', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    adapter.sendMessage = (): Promise<AgentResponse> => { throw new Error('API down'); };
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const msgs = await db.getMessages(id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content).toBe('Hello');
  });

  test('records adapter failures in replay events', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    adapter.sendMessage = (): Promise<AgentResponse> => { throw new Error('API down'); };
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const events = await db.getReplayEvents(id);
    expect(events.some((event) =>
      event.type === 'agent_response'
      && (event.payload as { error?: string }).error === 'API down')).toBe(true);
  });

  test('includes updated constraints_remaining in response', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const body = res.body as { constraints_remaining: { interactions_remaining: number } };
    expect(body.constraints_remaining.interactions_remaining).toBe(
      BASE_CONSTRAINT.max_interactions - 1
    );
  });
});

describe('branching and workspace APIs', () => {
  test('lists branches and creates a branch from a completed turn', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello agent' });

    const branchesRes = await request(app)
      .get(`/api/sessions/${id}/branches`)
      .set('Authorization', `Bearer ${token}`);

    expect(branchesRes.status).toBe(200);
    expect((branchesRes.body as { branches: Array<{ name: string }> }).branches).toEqual([
      expect.objectContaining({ name: 'main' }),
    ]);

    const createRes = await request(app)
      .post(`/api/sessions/${id}/branches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'experiment', forked_from_sequence: 1 });

    expect(createRes.status).toBe(201);
    expect((createRes.body as { branch: { name: string } }).branch.name).toBe('experiment');
    expect((createRes.body as { branches: Array<{ name: string }> }).branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'main' }),
        expect.objectContaining({ name: 'experiment' }),
      ]),
    );
  });

  test('stores and retrieves branch workspace snapshots and checkpoints', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const saveRes = await request(app)
      .put(`/api/sessions/${id}/workspace`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'draft',
        active_path: 'src/index.ts',
        workspace_section: 'code',
        filesystem: [{ path: 'src/index.ts', encoding: 'utf-8', content: 'console.log("hi")' }],
        mock_pg: [{ id: 'pool-1', name: 'app-db', tables: [], indexes: [], recentQueries: [] }],
      });

    expect(saveRes.status).toBe(200);
    expect((saveRes.body as { snapshot: { active_path: string } }).snapshot.active_path).toBe('src/index.ts');

    const getRes = await request(app)
      .get(`/api/sessions/${id}/workspace`)
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(200);
    expect((getRes.body as { snapshot: { filesystem: Array<{ path: string }> } }).snapshot.filesystem).toEqual([
      expect.objectContaining({ path: 'src/index.ts' }),
    ]);

    const checkpointRes = await request(app)
      .post(`/api/sessions/${id}/checkpoints`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Checkpoint 1' });

    expect(checkpointRes.status).toBe(201);
    expect((checkpointRes.body as { snapshot: { kind: string; label: string } }).snapshot).toMatchObject({
      kind: 'checkpoint',
      label: 'Checkpoint 1',
    });
  });
});

describe('GET /api/sessions/:id/messages', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get(`/api/sessions/${id}/messages`);
    expect(res.status).toBe(401);
  });

  test('returns full conversation history', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    // Send a message to populate history
    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const res = await request(app)
      .get(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2); // user + assistant
  });
});

describe('POST /api/sessions/:id/close', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).post(`/api/sessions/${id}/close`);
    expect(res.status).toBe(401);
  });

  test('marks session as completed', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/close`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe('completed');

    const session = await db.getSession(id);
    expect(session?.status).toBe('completed');
  });

  test('returns 404 for unknown session', async () => {
    const db = new FakeDb();
    db.sessions.set('ghost', { ...makeSession({ id: 'ghost' }), token: 'tok' });
    db.getSession = (): Promise<Session | null> => Promise.resolve(null);
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions/ghost/close')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/sessions/:id/tool-results', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .send({ tool_results: [] });
    expect(res.status).toBe(401);
  });

  test('returns 400 when tool_results is missing', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 for unknown session', async () => {
    const db = new FakeDb();
    db.sessions.set('ghost', { ...makeSession({ id: 'ghost' }), token: 'tok' });
    db.getSession = (): Promise<Session | null> => Promise.resolve(null);
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions/ghost/tool-results')
      .set('Authorization', 'Bearer tok')
      .send({ tool_results: [] });
    expect(res.status).toBe(404);
  });

  test('returns 409 when session is not active', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    await db.closeSession(id);
    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: [] });
    expect(res.status).toBe(409);
  });

  test('returns 200 with agent response', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const toolResults = [{ tool_call_id: 'tc-1', name: 'read_file' as const, output: 'const x = 1;', is_error: false }];
    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: toolResults });

    expect(res.status).toBe(200);
    const body = res.body as { content: string; stop_reason: string };
    expect(body.content).toBe('Hello from the agent!');
    expect(body.stop_reason).toBe('end_turn');
  });

  test('stores tool results and assistant message in db', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const toolResults = [{ tool_call_id: 'tc-1', name: 'read_file' as const, output: 'contents', is_error: false }];
    await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: toolResults });

    const msgs = await db.getMessages(id);
    expect(msgs.some((m) => m.role === 'tool')).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  test('does NOT increment interactions_used', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const toolResults = [{ tool_call_id: 'tc-1', name: 'read_file' as const, output: 'contents', is_error: false }];
    await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: toolResults });

    const session = await db.getSession(id);
    expect(session?.interactions_used).toBe(0);
  });

  test('returns 502 when adapter throws', async () => {
    const db = new FakeDb();
    const errAdapter = new FakeAdapter();
    errAdapter.sendMessage = (): Promise<AgentResponse> => { throw new Error('LLM down'); };
    const app = createApp(db, errAdapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: [{ tool_call_id: 'tc-1', name: 'read_file' as const, output: 'x', is_error: false }] });
    expect(res.status).toBe(502);
  });

  test('includes constraints_remaining in response', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: [{ tool_call_id: 'tc-1', name: 'read_file' as const, output: 'x', is_error: false }] });

    const body = res.body as { constraints_remaining: { interactions_remaining: number } };
    expect(typeof body.constraints_remaining.interactions_remaining).toBe('number');
  });
});

describe('buildHistory (via POST messages + tool-results round-trip)', () => {
  test('reconstruction: tool_use assistant message is deserialized from db', async () => {
    const db = new FakeDb();
    // Adapter returns tool_use on first call, end_turn on second
    let callCount = 0;
    const roundTripAdapter = new FakeAdapter();
    roundTripAdapter.sendMessage = (): Promise<AgentResponse> => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          content: null,
          tool_calls: [{ id: 'tc-1', name: 'read_file' as const, input: { path: '/a.ts' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          stop_reason: 'tool_use',
        });
      }
      return Promise.resolve({
        content: 'Done reading the file.',
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
        stop_reason: 'end_turn',
      });
    };
    const app = createApp(db, roundTripAdapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    // First turn: send message
    await request(app)
      .post(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Read a file' });

    // Second turn: send tool results
    const toolRes = await request(app)
      .post(`/api/sessions/${id}/tool-results`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: [{ tool_call_id: 'tc-1', name: 'read_file' as const, output: 'const x = 1;', is_error: false }] });

    expect(toolRes.status).toBe(200);
    const body = toolRes.body as { content: string };
    expect(body.content).toBe('Done reading the file.');
  });
});

describe('POST /api/sessions/:id/messages/stream', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .send({ message: 'Hello' });
    expect(res.status).toBe(401);
  });

  test('returns 400 when message is missing', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('uses the Build system prompt by default', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    expect(adapter.lastContext?.history[0]?.role).toBe('system');
    expect(adapter.lastContext?.history[0]?.content).toContain('Your goal is to help the candidate complete their coding task efficiently.');
    expect(adapter.lastContext?.history[0]?.content).toContain('emit an actual tool/function call through the API tool interface');
    expect(adapter.lastContext?.history[0]?.content).toContain('Do not merely describe a tool call in prose');
  });

  test('uses the Plan system prompt and includes a generated plan path', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Plan this task', mode: 'plan' });

    expect(adapter.lastContext?.history[0]?.role).toBe('system');
    expect(adapter.lastContext?.history[0]?.content).toContain('Your only job for this turn is to create an implementation plan.');
    expect(adapter.lastContext?.history[0]?.content).toMatch(/plans\/\d{4}-\d{2}-\d{2}-\d{6}-plan\.md/);
    expect(adapter.lastContext?.history[0]?.content).toContain('emit an actual tool/function call through the API tool interface');
  });

  test('streams text/event-stream with done event containing agent content', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: done');
    expect(res.text).toContain('Hello from the agent!');
  });

  test('stores user and assistant messages after loop completes', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const msgs = await db.getMessages(id);
    expect(msgs.some((m) => m.role === 'user')).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  test('updates session usage counters (1 interaction per agent turn)', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const session = await db.getSession(id);
    expect(session?.tokens_used).toBeGreaterThan(0);
    expect(session?.interactions_used).toBe(1);
  });

  test('records replay events for message and agent_response', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const events = await db.getReplayEvents(id);
    expect(events.some((e) => e.type === 'message')).toBe(true);
    expect(events.some((e) => e.type === 'agent_response')).toBe(true);
    expect(events.some((e) => e.type === 'resource_usage')).toBe(true);
  });

  test('done event contains constraints_remaining with decremented interaction count', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    // Parse the done event payload from SSE text
    const doneMatch = /event: done\ndata: (.+)/.exec(res.text);
    expect(doneMatch).not.toBeNull();
    const donePayload = JSON.parse(doneMatch![1]!) as { constraints_remaining: { interactions_remaining: number } };
    expect(donePayload.constraints_remaining.interactions_remaining).toBe(BASE_CONSTRAINT.max_interactions - 1);
  });

  test('sends error event when session not found', async () => {
    const db = new FakeDb();
    db.sessions.set('ghost', { ...makeSession({ id: 'ghost' }), token: 'tok' });
    const origGet = db.getSession.bind(db);
    db.getSession = (id: string): Promise<Session | null> =>
      id === 'ghost' ? Promise.resolve(null) : origGet(id);

    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const res = await request(app)
      .post('/api/sessions/ghost/messages/stream')
      .set('Authorization', 'Bearer tok')
      .send({ message: 'Hello' });

    expect(res.status).toBe(200); // SSE headers already sent
    expect(res.text).toContain('event: error');
    expect(res.text).toContain('Session not found');
  });

  test('sends error event when constraints are exhausted', async () => {
    const db = new FakeDb();
    const exhausted: Constraint = { ...BASE_CONSTRAINT, max_interactions: 0 };
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: exhausted });

    const res = await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    expect(res.text).toContain('event: error');
    expect(res.text).toContain('exhausted');
  });

  test('persists the user message even when the streamed loop fails', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    adapter.sendMessage = (): Promise<AgentResponse> => { throw new Error('provider blew up'); };
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    expect(res.text).toContain('event: error');

    const msgs = await db.getMessages(id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content).toBe('Hello');
  });

  test('records streamed loop failures in replay events', async () => {
    const db = new FakeDb();
    const adapter = new FakeAdapter();
    adapter.sendMessage = (): Promise<AgentResponse> => { throw new Error('provider blew up'); };
    const app = createApp(db, adapter, TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    await request(app)
      .post(`/api/sessions/${id}/messages/stream`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello' });

    const events = await db.getReplayEvents(id);
    expect(events.some((event) =>
      event.type === 'agent_response'
      && (event.payload as { error?: string }).error === 'provider blew up')).toBe(true);
  });
});

describe('POST /api/sessions/:id/tool-results/:requestId', () => {
  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results/some-request-id`)
      .send({ tool_results: [] });
    expect(res.status).toBe(401);
  });

  test('returns 400 when tool_results is missing', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results/some-id`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 when requestId has no pending loop', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .post(`/api/sessions/${id}/tool-results/nonexistent-request-id`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_results: [{ tool_call_id: 'tc-1', name: 'read_file', output: 'x', is_error: false }] });
    expect(res.status).toBe(404);
  });
});

describe('conversation context APIs', () => {
  test('creates a new conversation in the same branch and isolates message history by conversation', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({
      prompt_id: 'p',
      candidate_email: 'e@e.com',
      constraint: BASE_CONSTRAINT,
    });

    const branch = await db.getMainBranch(id);
    const mainConversation = branch ? await db.getMainConversation(id, branch.id) : null;
    expect(branch).not.toBeNull();
    expect(mainConversation).not.toBeNull();

    await db.addBranchMessage(id, branch!.id, 1, 'user', 'main conversation message', 0, mainConversation!.id);

    const createResponse = await request(app)
      .post(`/api/sessions/${id}/conversations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        branch_id: branch!.id,
        source_conversation_id: mainConversation!.id,
        active_path: 'src/app.ts',
      });
    const createBody = createResponse.body as {
      branch: SessionBranch;
      conversation: ConversationSummary;
      attachments: ContextAttachment[];
    };

    expect(createResponse.status).toBe(201);
    expect(createBody.branch.id).toBe(branch!.id);
    expect(createBody.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', path: 'src/app.ts' }),
      ]),
    );

    const nextConversationId = createBody.conversation.id;
    await db.addBranchMessage(id, branch!.id, 2, 'user', 'second conversation message', 0, nextConversationId);

    const messagesResponse = await request(app)
      .get(`/api/sessions/${id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .query({
        branch_id: branch!.id,
        conversation_id: nextConversationId,
      });
    const messagesBody = messagesResponse.body as {
      active_conversation_id: string | null;
      messages: Array<{ content: string; conversation_id: string }>;
    };

    expect(messagesResponse.status).toBe(200);
    expect(messagesBody.active_conversation_id).toBe(nextConversationId);
    expect(messagesBody.messages).toEqual([
      expect.objectContaining({
        content: 'second conversation message',
        conversation_id: nextConversationId,
      }),
    ]);
  });
});

describe('POST /api/sessions/:id/rewind', () => {
  test('returns 200 with { ok: true } when turn_sequence is valid', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/rewind`)
      .set('Authorization', `Bearer ${token}`)
      .send({ turn_sequence: 1 });

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  test('returns 400 when turn_sequence is missing', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/rewind`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('returns 400 when turn_sequence is a non-integer', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id, token } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });

    const res = await request(app)
      .post(`/api/sessions/${id}/rewind`)
      .set('Authorization', `Bearer ${token}`)
      .send({ turn_sequence: 1.5 });

    expect(res.status).toBe(400);
  });

  test('returns 401 without auth', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).post(`/api/sessions/${id}/rewind`).send({ turn_sequence: 1 });
    expect(res.status).toBe(401);
  });
});

describe('auth middleware', () => {
  test('rejects requests with no Authorization header', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app).get(`/api/sessions/${id}`);
    expect(res.status).toBe(401);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Authorization/);
  });

  test('rejects requests with malformed Authorization header', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}`)
      .set('Authorization', 'Token abc');
    expect(res.status).toBe(401);
  });

  test('rejects requests with wrong token', async () => {
    const db = new FakeDb();
    const app = createApp(db, new FakeAdapter(), TEST_CONFIG);
    const { id } = await db.createSession({ prompt_id: 'p', candidate_email: 'e@e.com', constraint: BASE_CONSTRAINT });
    const res = await request(app)
      .get(`/api/sessions/${id}`)
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid/);
  });
});
