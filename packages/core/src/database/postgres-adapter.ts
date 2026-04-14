import { randomUUID, randomBytes } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import type {
  AssessmentLinkRecord,
  ContextAttachment,
  ContextAttachmentKind,
  ContextResource,
  ContextResourceKind,
  ConversationSummary,
  MessageRole,
  ReplayEventType,
  Session,
  SessionBranch,
  SessionStatus,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from '../types.js';
import type {
  ContextAttachmentInput,
  ContextResourceInput,
  CreateAssessmentLinkConfig,
  CreateBranchConfig,
  CreateConversationConfig,
  CreateSessionConfig,
  DatabaseAdapter,
  StoredMessage,
  StoredReplayEvent,
  UpdateConversationConfig,
  WorkspaceSnapshotInput,
} from './contracts.js';
import {
  normalizeAssessmentLinkRow,
  normalizeContextAttachmentRow,
  normalizeContextResourceRow,
  normalizeConversationRow,
  normalizeSessionBranchRow,
  normalizeSessionRow,
  normalizeWorkspaceSnapshotRow,
  rowToAssessmentLink,
  rowToContextAttachment,
  rowToContextResource,
  rowToConversation,
  rowToSession,
  rowToSessionBranch,
  rowToWorkspaceSnapshot,
} from './mapping.js';
import type {
  AssessmentLinkRow,
  ContextAttachmentRow,
  ContextResourceRow,
  ConversationRow,
  MessageRow,
  ReplayEventRow,
  SessionBranchRow,
  SessionRow,
  WorkspaceSnapshotRow,
} from './rows.js';
import { POSTGRES_SCHEMA_STATEMENTS } from './schema.js';

export interface PostgresAdapterConfig {
  connectionString: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, 'connectionString'>;
}

export class PostgresAdapter implements DatabaseAdapter {
  private readonly pool: Pool;
  private initializationPromise: Promise<void> | null = null;

  constructor(config: PostgresAdapterConfig) {
    this.pool = config.pool ?? new Pool({
      connectionString: config.connectionString,
      max: 10,
      ...config.poolConfig,
    });
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise === null) {
      this.initializationPromise = this.bootstrapSchema();
    }
    await this.initializationPromise;
  }

  async createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }> {
    await this.initialize();

    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const branchId = randomUUID();

    await this.pool.query(
      `INSERT INTO sessions (
        id, token, prompt_id, candidate_email, status, created_at,
        max_session_tokens, max_message_tokens, max_interactions,
        context_window, time_limit_minutes, tokens_used, interactions_used
      ) VALUES (
        $1, $2, $3, $4, 'active', $5,
        $6, $7, $8,
        $9, $10, 0, 0
      )`,
      [
        id,
        token,
        config.prompt_id,
        config.candidate_email,
        now,
        config.constraint.max_session_tokens,
        config.constraint.max_message_tokens,
        config.constraint.max_interactions,
        config.constraint.context_window,
        config.constraint.time_limit_minutes,
      ],
    );

    await this.pool.query(
      `INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES ($1, $2, 'main', NULL, NULL, $3)`,
      [branchId, id, now],
    );

    await this.pool.query(
      `INSERT INTO conversations (
        id, session_id, branch_id, title, archived, created_at, updated_at
      ) VALUES ($1, $2, $3, 'main', FALSE, $4, $5)`,
      [randomUUID(), id, branchId, now, now],
    );

    return { id, token };
  }

  async createAssessmentLink(config: CreateAssessmentLinkConfig): Promise<AssessmentLinkRecord> {
    await this.initialize();

    await this.pool.query(
      `INSERT INTO assessment_links (
        id, token, url, prompt_id, candidate_email, created_at, expires_at, constraint_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )`,
      [
        config.id,
        config.token,
        config.url,
        config.prompt_id,
        config.candidate_email,
        config.created_at,
        config.expires_at,
        JSON.stringify(config.constraint),
      ],
    );

    return {
      id: config.id,
      token: config.token,
      url: config.url,
      prompt_id: config.prompt_id,
      candidate_email: config.candidate_email,
      created_at: config.created_at,
      expires_at: config.expires_at,
      constraint: config.constraint,
    };
  }

  async getSession(id: string): Promise<Session | null> {
    await this.initialize();
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return result.rows[0] ? rowToSession(normalizeSessionRow(result.rows[0])) : null;
  }

  async getSessionToken(id: string): Promise<string | null> {
    await this.initialize();
    const result = await this.pool.query<{ token: string }>('SELECT token FROM sessions WHERE id = $1', [id]);
    return result.rows[0]?.token ?? null;
  }

  async getMainBranch(sessionId: string): Promise<SessionBranch | null> {
    await this.initialize();
    const result = await this.pool.query<SessionBranchRow>(
      "SELECT * FROM session_branches WHERE session_id = $1 AND name = 'main' LIMIT 1",
      [sessionId],
    );
    return result.rows[0] ? rowToSessionBranch(normalizeSessionBranchRow(result.rows[0])) : null;
  }

  async getBranch(sessionId: string, branchId: string): Promise<SessionBranch | null> {
    await this.initialize();
    const result = await this.pool.query<SessionBranchRow>(
      'SELECT * FROM session_branches WHERE session_id = $1 AND id = $2 LIMIT 1',
      [sessionId, branchId],
    );
    return result.rows[0] ? rowToSessionBranch(normalizeSessionBranchRow(result.rows[0])) : null;
  }

  async listBranches(sessionId: string): Promise<SessionBranch[]> {
    await this.initialize();
    const result = await this.pool.query<SessionBranchRow>(
      'SELECT * FROM session_branches WHERE session_id = $1 ORDER BY created_at ASC, id ASC',
      [sessionId],
    );
    return result.rows.map((row) => rowToSessionBranch(normalizeSessionBranchRow(row)));
  }

  async getMainConversation(sessionId: string, branchId: string): Promise<ConversationSummary | null> {
    await this.initialize();
    const result = await this.pool.query<ConversationRow>(
      `SELECT * FROM conversations
       WHERE session_id = $1 AND branch_id = $2
       ORDER BY CASE WHEN title = 'main' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
      [sessionId, branchId],
    );
    return result.rows[0] ? rowToConversation(normalizeConversationRow(result.rows[0])) : null;
  }

  async getConversation(sessionId: string, conversationId: string): Promise<ConversationSummary | null> {
    await this.initialize();
    const result = await this.pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE session_id = $1 AND id = $2 LIMIT 1',
      [sessionId, conversationId],
    );
    return result.rows[0] ? rowToConversation(normalizeConversationRow(result.rows[0])) : null;
  }

  async listConversations(sessionId: string, branchId: string): Promise<ConversationSummary[]> {
    await this.initialize();
    const result = await this.pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE session_id = $1 AND branch_id = $2 ORDER BY updated_at DESC, created_at DESC, id DESC',
      [sessionId, branchId],
    );
    return result.rows.map((row) => rowToConversation(normalizeConversationRow(row)));
  }

  async createConversation(config: CreateConversationConfig): Promise<ConversationSummary> {
    await this.initialize();
    const id = randomUUID();
    const timestamp = Date.now();
    const title = config.title?.trim() || 'New chat';
    await this.pool.query(
      `INSERT INTO conversations (
        id, session_id, branch_id, title, archived, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, config.session_id, config.branch_id, title, config.archived ?? false, timestamp, timestamp],
    );
    return {
      id,
      session_id: config.session_id,
      branch_id: config.branch_id,
      title,
      archived: config.archived ?? false,
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  async updateConversation(config: UpdateConversationConfig): Promise<ConversationSummary | null> {
    await this.initialize();
    const existing = await this.getConversation(config.session_id, config.conversation_id);
    if (!existing) {
      return null;
    }
    const timestamp = Date.now();
    const title = config.title?.trim() || existing.title;
    const archived = config.archived ?? existing.archived;
    await this.pool.query(
      `UPDATE conversations SET title = $1, archived = $2, updated_at = $3 WHERE id = $4`,
      [title, archived, timestamp, config.conversation_id],
    );
    return {
      ...existing,
      title,
      archived,
      updated_at: timestamp,
    };
  }

  async createBranch(config: CreateBranchConfig): Promise<SessionBranch> {
    await this.initialize();
    const id = randomUUID();
    const createdAt = Date.now();
    const parentConversationId = config.conversation_id
      ?? (await this.getMainConversation(config.session_id, config.parent_branch_id))?.id
      ?? null;
    await this.pool.query(
      `INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, config.session_id, config.name, config.parent_branch_id, config.forked_from_sequence, createdAt],
    );

    const mainConversationId = randomUUID();
    await this.pool.query(
      `INSERT INTO conversations (
        id, session_id, branch_id, title, archived, created_at, updated_at
      ) VALUES ($1, $2, $3, 'main', FALSE, $4, $5)`,
      [mainConversationId, config.session_id, id, createdAt, createdAt],
    );

    await this.pool.query(
      `INSERT INTO messages (session_id, branch_id, conversation_id, turn_sequence, role, content, token_count, created_at)
       SELECT session_id, $1, $2, turn_sequence, role, content, token_count, created_at
       FROM messages
       WHERE session_id = $3 AND branch_id = $4 AND conversation_id = $5 AND turn_sequence IS NOT NULL AND turn_sequence <= $6
       ORDER BY id ASC`,
      [id, mainConversationId, config.session_id, config.parent_branch_id, parentConversationId, config.forked_from_sequence],
    );

    await this.pool.query(
      `INSERT INTO replay_events (session_id, branch_id, conversation_id, turn_sequence, type, timestamp, payload)
       SELECT session_id, $1, $2, turn_sequence, type, timestamp, payload
       FROM replay_events
       WHERE session_id = $3 AND branch_id = $4 AND conversation_id = $5 AND turn_sequence IS NOT NULL AND turn_sequence <= $6
       ORDER BY timestamp ASC, id ASC`,
      [id, mainConversationId, config.session_id, config.parent_branch_id, parentConversationId, config.forked_from_sequence],
    );

    const snapshotResult = await this.pool.query<WorkspaceSnapshotRow>(
      `SELECT * FROM workspace_snapshots
       WHERE session_id = $1 AND branch_id = $2 AND (
         kind = 'draft' OR (turn_sequence IS NOT NULL AND turn_sequence <= $3)
       )
       ORDER BY CASE WHEN kind = 'draft' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
      [config.session_id, config.parent_branch_id, config.forked_from_sequence],
    );

    const snapshot = snapshotResult.rows[0];
    if (snapshot) {
      const normalized = normalizeWorkspaceSnapshotRow(snapshot);
      await this.pool.query(
        `INSERT INTO workspace_snapshots (
          id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
        ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10)`,
        [
          randomUUID(),
          normalized.session_id,
          id,
          normalized.turn_sequence,
          normalized.label,
          createdAt,
          normalized.active_path,
          normalized.workspace_section,
          normalized.filesystem_json,
          normalized.mock_pg_json,
        ],
      );
    }

    return {
      id,
      session_id: config.session_id,
      name: config.name,
      parent_branch_id: config.parent_branch_id,
      forked_from_sequence: config.forked_from_sequence,
      created_at: createdAt,
    };
  }

  async allocateTurnSequence(sessionId: string): Promise<number> {
    await this.initialize();
    const result = await this.pool.query<{ max_turn_sequence: number | null }>(
      `SELECT MAX(turn_sequence) AS max_turn_sequence FROM (
         SELECT turn_sequence FROM messages WHERE session_id = $1
         UNION ALL
         SELECT turn_sequence FROM replay_events WHERE session_id = $1
         UNION ALL
         SELECT turn_sequence FROM workspace_snapshots WHERE session_id = $1
       ) AS turn_sequences`,
      [sessionId],
    );
    return Number(result.rows[0]?.max_turn_sequence ?? 0) + 1;
  }

  async addBranchMessage(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    role: MessageRole,
    content: string,
    tokenCount: number,
    conversationId?: string,
  ): Promise<void> {
    await this.initialize();
    const resolvedConversationId = conversationId ?? (await this.getMainConversation(sessionId, branchId))?.id;
    if (!resolvedConversationId) {
      throw new Error(`Main conversation not found for branch ${branchId}`);
    }
    await this.pool.query(
      `INSERT INTO messages (session_id, branch_id, conversation_id, turn_sequence, role, content, token_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sessionId, branchId, resolvedConversationId, turnSequence, role, content, tokenCount, Date.now()],
    );
    await this.pool.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [Date.now(), resolvedConversationId]);
  }

  async addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      throw new Error(`Main branch not found for session ${sessionId}`);
    }
    await this.addBranchMessage(sessionId, branch.id, null, role, content, tokenCount);
  }

  async getBranchMessages(
    sessionId: string,
    branchId: string,
    conversationId?: string,
    options?: { includeRewound?: boolean },
  ): Promise<StoredMessage[]> {
    await this.initialize();
    const includeRewound = options?.includeRewound ?? false;
    const rewoundFilter = includeRewound ? '' : 'AND rewound_at IS NULL';
    const result = conversationId
      ? await this.pool.query<MessageRow>(
          `SELECT * FROM messages WHERE session_id = $1 AND branch_id = $2 AND conversation_id = $3 ${rewoundFilter} ORDER BY id ASC`,
          [sessionId, branchId, conversationId],
        )
      : await this.pool.query<MessageRow>(
          `SELECT * FROM messages WHERE session_id = $1 AND branch_id = $2 ${rewoundFilter} ORDER BY id ASC`,
          [sessionId, branchId],
        );

    return result.rows.map((row) => ({
      id: Number(row.id),
      session_id: row.session_id,
      branch_id: row.branch_id,
      conversation_id: row.conversation_id,
      turn_sequence: row.turn_sequence === null ? null : Number(row.turn_sequence),
      role: row.role as MessageRole,
      content: row.content,
      token_count: Number(row.token_count),
      created_at: Number(row.created_at),
      rewound_at: row.rewound_at === null ? null : Number(row.rewound_at),
    }));
  }

  async rewindMessages(
    sessionId: string,
    branchId: string,
    conversationId: string,
    afterTurnSequence: number,
  ): Promise<void> {
    await this.initialize();
    await this.pool.query(
      'UPDATE messages SET rewound_at = $1 WHERE session_id = $2 AND branch_id = $3 AND conversation_id = $4 AND turn_sequence > $5',
      [Date.now(), sessionId, branchId, conversationId, afterTurnSequence],
    );
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      return [];
    }
    return this.getBranchMessages(sessionId, branch.id);
  }

  async closeSession(id: string, status: Exclude<SessionStatus, 'active'> = 'completed'): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `UPDATE sessions SET status = $1, closed_at = $2 WHERE id = $3`,
      [status, Date.now(), id],
    );
  }

  async listSessions(): Promise<Session[]> {
    await this.initialize();
    const result = await this.pool.query<SessionRow>('SELECT * FROM sessions ORDER BY created_at DESC');
    return result.rows.map((row) => rowToSession(normalizeSessionRow(row)));
  }

  async getSessionsByPrompt(promptId: string): Promise<Session[]> {
    await this.initialize();
    const result = await this.pool.query<SessionRow>(
      'SELECT * FROM sessions WHERE prompt_id = $1 ORDER BY created_at DESC',
      [promptId],
    );
    return result.rows.map((row) => rowToSession(normalizeSessionRow(row)));
  }

  async listAssessmentLinks(): Promise<AssessmentLinkRecord[]> {
    await this.initialize();
    const result = await this.pool.query<AssessmentLinkRow>(
      `SELECT
         l.id,
         l.token,
         l.url,
         l.prompt_id,
         l.candidate_email,
         l.created_at,
         l.expires_at,
         l.constraint_json,
         u.session_id AS consumed_session_id,
         u.used_at AS consumed_at
       FROM assessment_links l
       LEFT JOIN assessment_link_uses u ON u.link_id = l.id
       ORDER BY l.created_at DESC`,
    );
    return result.rows.map((row) => rowToAssessmentLink(normalizeAssessmentLinkRow(row)));
  }

  async getAssessmentLink(id: string): Promise<AssessmentLinkRecord | null> {
    await this.initialize();
    const result = await this.pool.query<AssessmentLinkRow>(
      `SELECT
         l.id,
         l.token,
         l.url,
         l.prompt_id,
         l.candidate_email,
         l.created_at,
         l.expires_at,
         l.constraint_json,
         u.session_id AS consumed_session_id,
         u.used_at AS consumed_at
       FROM assessment_links l
       LEFT JOIN assessment_link_uses u ON u.link_id = l.id
       WHERE l.id = $1`,
      [id],
    );
    return result.rows[0] ? rowToAssessmentLink(normalizeAssessmentLinkRow(result.rows[0])) : null;
  }

  async validateSessionToken(id: string, token: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query('SELECT id FROM sessions WHERE id = $1 AND token = $2', [id, token]);
    return result.rows.length > 0;
  }

  async updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `UPDATE sessions
       SET tokens_used = tokens_used + $1, interactions_used = interactions_used + $2
       WHERE id = $3`,
      [additionalTokens, additionalInteractions, id],
    );
  }

  async addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      throw new Error(`Main branch not found for session ${sessionId}`);
    }
    await this.addBranchReplayEvent(sessionId, branch.id, null, type, timestamp, payload);
  }

  async addBranchReplayEvent(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    type: ReplayEventType,
    timestamp: number,
    payload: unknown,
    conversationId?: string,
  ): Promise<void> {
    await this.initialize();
    const resolvedConversationId = conversationId ?? (await this.getMainConversation(sessionId, branchId))?.id;
    if (!resolvedConversationId) {
      throw new Error(`Main conversation not found for branch ${branchId}`);
    }
    await this.pool.query(
      `INSERT INTO replay_events (session_id, branch_id, conversation_id, turn_sequence, type, timestamp, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, branchId, resolvedConversationId, turnSequence, type, timestamp, JSON.stringify(payload)],
    );
  }

  async getBranchReplayEvents(sessionId: string, branchId: string, conversationId?: string): Promise<StoredReplayEvent[]> {
    await this.initialize();
    const result = conversationId
      ? await this.pool.query<ReplayEventRow>(
          'SELECT * FROM replay_events WHERE session_id = $1 AND branch_id = $2 AND conversation_id = $3 ORDER BY timestamp ASC, id ASC',
          [sessionId, branchId, conversationId],
        )
      : await this.pool.query<ReplayEventRow>(
          'SELECT * FROM replay_events WHERE session_id = $1 AND branch_id = $2 ORDER BY timestamp ASC, id ASC',
          [sessionId, branchId],
        );
    return result.rows.map((row) => ({
      id: Number(row.id),
      session_id: row.session_id,
      branch_id: row.branch_id,
      conversation_id: row.conversation_id,
      turn_sequence: row.turn_sequence === null ? null : Number(row.turn_sequence),
      type: row.type as ReplayEventType,
      timestamp: Number(row.timestamp),
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  async listConversationContextAttachments(conversationId: string): Promise<ContextAttachment[]> {
    await this.initialize();
    const result = await this.pool.query<ContextAttachmentRow>(
      'SELECT * FROM conversation_context_attachments WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC',
      [conversationId],
    );
    return result.rows.map((row) => rowToContextAttachment(normalizeContextAttachmentRow(row)));
  }

  async replaceConversationContextAttachments(conversationId: string, attachments: ContextAttachmentInput[]): Promise<ContextAttachment[]> {
    await this.initialize();
    await this.pool.query('DELETE FROM conversation_context_attachments WHERE conversation_id = $1', [conversationId]);
    const timestamp = Date.now();
    for (const attachment of attachments) {
      await this.pool.query(
        `INSERT INTO conversation_context_attachments (
          id, conversation_id, kind, label, path, resource_id, source_conversation_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          conversationId,
          attachment.kind,
          attachment.label,
          attachment.path ?? null,
          attachment.resource_id ?? null,
          attachment.source_conversation_id ?? null,
          timestamp,
        ],
      );
    }
    await this.pool.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [timestamp, conversationId]);
    return this.listConversationContextAttachments(conversationId);
  }

  async listContextResources(sessionId: string, branchId: string): Promise<ContextResource[]> {
    await this.initialize();
    const result = await this.pool.query<ContextResourceRow>(
      'SELECT * FROM context_resources WHERE session_id = $1 AND branch_id = $2 ORDER BY updated_at DESC, created_at DESC, id DESC',
      [sessionId, branchId],
    );
    return result.rows.map((row) => rowToContextResource(normalizeContextResourceRow(row)));
  }

  async upsertContextResource(input: ContextResourceInput): Promise<ContextResource> {
    await this.initialize();
    const timestamp = Date.now();
    const existing = await this.pool.query<ContextResourceRow>(
      `SELECT * FROM context_resources
       WHERE session_id = $1 AND branch_id = $2 AND kind = $3 AND (($4::text IS NULL AND source_conversation_id IS NULL) OR source_conversation_id = $4)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [input.session_id, input.branch_id, input.kind, input.source_conversation_id ?? null],
    );

    if (existing.rows[0]) {
      const normalized = normalizeContextResourceRow(existing.rows[0]);
      await this.pool.query(
        `UPDATE context_resources SET title = $1, content = $2, updated_at = $3 WHERE id = $4`,
        [input.title, input.content, timestamp, normalized.id],
      );
      return {
        id: normalized.id,
        session_id: normalized.session_id,
        branch_id: normalized.branch_id,
        kind: normalized.kind as ContextResourceKind,
        title: input.title,
        content: input.content,
        created_at: Number(normalized.created_at),
        updated_at: timestamp,
        ...(normalized.source_conversation_id ? { source_conversation_id: normalized.source_conversation_id } : {}),
      };
    }

    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO context_resources (
        id, session_id, branch_id, kind, title, content, source_conversation_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.session_id, input.branch_id, input.kind, input.title, input.content, input.source_conversation_id ?? null, timestamp, timestamp],
    );
    return {
      id,
      session_id: input.session_id,
      branch_id: input.branch_id,
      kind: input.kind,
      title: input.title,
      content: input.content,
      created_at: timestamp,
      updated_at: timestamp,
      ...(input.source_conversation_id ? { source_conversation_id: input.source_conversation_id } : {}),
    };
  }

  async getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    const branch = await this.getMainBranch(sessionId);
    if (!branch) {
      return [];
    }
    return this.getBranchReplayEvents(sessionId, branch.id);
  }

  async upsertWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    await this.initialize();
    if (input.kind === 'draft') {
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2 AND kind = 'draft'
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.session_id, input.branch_id],
      );
      if (existing.rows[0]?.id) {
        const createdAt = input.created_at ?? Date.now();
        await this.pool.query(
          `UPDATE workspace_snapshots
           SET turn_sequence = $1, label = $2, created_at = $3, active_path = $4, workspace_section = $5, filesystem_json = $6, mock_pg_json = $7
           WHERE id = $8`,
          [
            input.turn_sequence ?? null,
            input.label ?? null,
            createdAt,
            input.active_path ?? null,
            input.workspace_section ?? null,
            JSON.stringify(input.filesystem),
            JSON.stringify(input.mock_pg),
            existing.rows[0].id,
          ],
        );
        const rowResult = await this.pool.query<WorkspaceSnapshotRow>(
          'SELECT * FROM workspace_snapshots WHERE id = $1',
          [existing.rows[0].id],
        );
        return rowToWorkspaceSnapshot(normalizeWorkspaceSnapshotRow(rowResult.rows[0]!));
      }
    }

    return this.createWorkspaceSnapshot(input);
  }

  async createWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    await this.initialize();
    const id = randomUUID();
    const createdAt = input.created_at ?? Date.now();
    await this.pool.query(
      `INSERT INTO workspace_snapshots (
        id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        input.session_id,
        input.branch_id,
        input.kind,
        input.turn_sequence ?? null,
        input.label ?? null,
        createdAt,
        input.active_path ?? null,
        input.workspace_section ?? null,
        JSON.stringify(input.filesystem),
        JSON.stringify(input.mock_pg),
      ],
    );
    return {
      id,
      session_id: input.session_id,
      branch_id: input.branch_id,
      kind: input.kind,
      ...(input.turn_sequence !== undefined ? { turn_sequence: input.turn_sequence } : {}),
      ...(input.label ? { label: input.label } : {}),
      created_at: createdAt,
      ...(input.active_path ? { active_path: input.active_path } : {}),
      ...(input.workspace_section ? { workspace_section: input.workspace_section } : {}),
      filesystem: input.filesystem,
      mock_pg: input.mock_pg,
    };
  }

  async getWorkspaceSnapshot(
    sessionId: string,
    branchId: string,
    options: { kind?: WorkspaceSnapshotKind; turn_sequence?: number } = {},
  ): Promise<WorkspaceSnapshot | null> {
    await this.initialize();
    let result;
    if (options.turn_sequence !== undefined) {
      result = await this.pool.query<WorkspaceSnapshotRow>(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2 AND turn_sequence = $3 AND ($4::text IS NULL OR kind = $4)
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId, branchId, options.turn_sequence, options.kind ?? null],
      );
    } else if (options.kind) {
      result = await this.pool.query<WorkspaceSnapshotRow>(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2 AND kind = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId, branchId, options.kind],
      );
    } else {
      result = await this.pool.query<WorkspaceSnapshotRow>(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = $1 AND branch_id = $2
         ORDER BY CASE WHEN kind = 'draft' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`,
        [sessionId, branchId],
      );
    }

    return result.rows[0] ? rowToWorkspaceSnapshot(normalizeWorkspaceSnapshotRow(result.rows[0])) : null;
  }

  async markAssessmentLinkUsed(linkId: string, sessionId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      `INSERT INTO assessment_link_uses (link_id, session_id, used_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (link_id) DO NOTHING`,
      [linkId, sessionId, Date.now()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isAssessmentLinkUsed(linkId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT link_id FROM assessment_link_uses WHERE link_id = $1',
      [linkId],
    );
    return result.rows.length > 0;
  }

  async getAssessmentLinkSessionId(linkId: string): Promise<string | null> {
    await this.initialize();
    const result = await this.pool.query<{ session_id: string }>(
      'SELECT session_id FROM assessment_link_uses WHERE link_id = $1',
      [linkId],
    );
    return result.rows[0]?.session_id ?? null;
  }

  async deleteAssessmentLink(id: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query('DELETE FROM assessment_links WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteAssessmentLinks(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    await this.initialize();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await this.pool.query(
      `DELETE FROM assessment_links WHERE id IN (${placeholders})`,
      ids,
    );
    return result.rowCount ?? 0;
  }

  private async bootstrapSchema(): Promise<void> {
    try {
      for (const statement of POSTGRES_SCHEMA_STATEMENTS) {
        await this.pool.query(statement);
      }
      await this.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id TEXT');
      await this.pool.query('ALTER TABLE replay_events ADD COLUMN IF NOT EXISTS conversation_id TEXT');
      await this.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS rewound_at BIGINT');
      await this.backfillPostgresConversations();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize PostgreSQL database schema: ${message}`);
    }
  }

  private async backfillPostgresConversations(): Promise<void> {
    const branchesResult = await this.pool.query<SessionBranchRow>(
      'SELECT * FROM session_branches ORDER BY created_at ASC, id ASC',
    );
    for (const row of branchesResult.rows) {
      const branch = normalizeSessionBranchRow(row);
      let conversationResult = await this.pool.query<ConversationRow>(
        "SELECT * FROM conversations WHERE branch_id = $1 AND title = 'main' ORDER BY created_at ASC LIMIT 1",
        [branch.id],
      );

      if (!conversationResult.rows[0]) {
        const id = randomUUID();
        await this.pool.query(
          `INSERT INTO conversations (id, session_id, branch_id, title, archived, created_at, updated_at)
           VALUES ($1, $2, $3, 'main', FALSE, $4, $5)`,
          [id, branch.session_id, branch.id, branch.created_at, branch.created_at],
        );
        conversationResult = await this.pool.query<ConversationRow>(
          'SELECT * FROM conversations WHERE id = $1',
          [id],
        );
      }

      const conversation = normalizeConversationRow(conversationResult.rows[0]!);
      await this.pool.query(
        `UPDATE messages
         SET conversation_id = $1
         WHERE session_id = $2 AND branch_id = $3 AND (conversation_id IS NULL OR conversation_id = '')`,
        [conversation.id, branch.session_id, branch.id],
      );
      await this.pool.query(
        `UPDATE replay_events
         SET conversation_id = $1
         WHERE session_id = $2 AND branch_id = $3 AND (conversation_id IS NULL OR conversation_id = '')`,
        [conversation.id, branch.session_id, branch.id],
      );
    }
  }
}
