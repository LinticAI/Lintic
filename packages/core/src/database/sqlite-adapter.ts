import { randomUUID, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  AssessmentLinkRecord,
  ContextAttachment,
  ContextResource,
  ContextResourceKind,
  ConversationSummary,
  EvaluationResult,
  MessageRole,
  ReplayEventType,
  Session,
  SessionComparisonAnalysis,
  SessionEvaluation,
  SessionBranch,
  SessionReviewState,
  SessionReviewStatus,
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
  CreatePromptConfig,
  CreateSessionConfig,
  DatabaseAdapter,
  SessionComparisonAnalysisInput,
  StoredMessage,
  StoredReplayEvent,
  UpdateConversationConfig,
  UpdatePromptConfig,
  WorkspaceSnapshotInput,
} from './contracts.js';
import type { PromptConfig } from '../config.js';
import {
  rowToAssessmentLink,
  rowToContextAttachment,
  rowToContextResource,
  rowToConversation,
  rowToPromptConfig,
  rowToSession,
  rowToSessionComparisonAnalysis,
  rowToSessionEvaluation,
  rowToSessionReviewState,
  rowToSessionBranch,
  rowToWorkspaceSnapshot,
} from './mapping.js';
import type {
  AssessmentLinkRow,
  ContextAttachmentRow,
  ContextResourceRow,
  ConversationRow,
  MessageRow,
  PromptRow,
  ReplayEventRow,
  SessionComparisonAnalysisRow,
  SessionEvaluationRow,
  SessionReviewStateRow,
  SessionBranchRow,
  SessionRow,
  WorkspaceSnapshotRow,
} from './rows.js';
import { SQLITE_SCHEMA } from './schema.js';

export class SQLiteAdapter implements DatabaseAdapter {
  private readonly db: Database.Database;

  constructor(dbPath: string = 'lintic.db') {
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(SQLITE_SCHEMA);
    this.applySqliteMigrations();
  }

  private applySqliteMigrations(): void {
    const migrations = [
      'ALTER TABLE sessions ADD COLUMN archived_at INTEGER',
      'ALTER TABLE messages ADD COLUMN branch_id TEXT',
      'ALTER TABLE messages ADD COLUMN turn_sequence INTEGER',
      'ALTER TABLE messages ADD COLUMN conversation_id TEXT',
      'ALTER TABLE replay_events ADD COLUMN branch_id TEXT',
      'ALTER TABLE replay_events ADD COLUMN turn_sequence INTEGER',
      'ALTER TABLE replay_events ADD COLUMN conversation_id TEXT',
      'ALTER TABLE messages ADD COLUMN rewound_at INTEGER',
    ];

    for (const statement of migrations) {
      try {
        this.db.exec(statement);
      } catch {
        // Existing databases may already have the column.
      }
    }

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_archived_at ON sessions(archived_at, created_at DESC)');
    this.db.exec("UPDATE messages SET branch_id = COALESCE(branch_id, 'main') WHERE branch_id IS NULL OR branch_id = ''");
    this.db.exec("UPDATE replay_events SET branch_id = COALESCE(branch_id, 'main') WHERE branch_id IS NULL OR branch_id = ''");
    this.backfillSqliteConversations();
  }

  private backfillSqliteConversations(): void {
    const branches = this.db.prepare(
      'SELECT id, session_id, name, created_at FROM session_branches ORDER BY created_at ASC, id ASC',
    ).all() as Array<{ id: string; session_id: string; name: string; created_at: number }>;

    for (const branch of branches) {
      let conversation = this.db.prepare(
        "SELECT * FROM conversations WHERE branch_id = ? AND title = 'main' ORDER BY created_at ASC LIMIT 1",
      ).get(branch.id) as ConversationRow | undefined;

      if (!conversation) {
        const id = randomUUID();
        const timestamp = branch.created_at ?? Date.now();
        this.db.prepare(
          `INSERT INTO conversations (id, session_id, branch_id, title, archived, created_at, updated_at)
           VALUES (?, ?, ?, 'main', 0, ?, ?)`,
        ).run(id, branch.session_id, branch.id, timestamp, timestamp);
        conversation = {
          id,
          session_id: branch.session_id,
          branch_id: branch.id,
          title: 'main',
          archived: 0,
          created_at: timestamp,
          updated_at: timestamp,
        };
      }

      this.db.prepare(
        `UPDATE messages
         SET conversation_id = ?
         WHERE session_id = ? AND branch_id = ? AND (conversation_id IS NULL OR conversation_id = '')`,
      ).run(conversation.id, branch.session_id, branch.id);

      this.db.prepare(
        `UPDATE replay_events
         SET conversation_id = ?
         WHERE session_id = ? AND branch_id = ? AND (conversation_id IS NULL OR conversation_id = '')`,
      ).run(conversation.id, branch.session_id, branch.id);
    }
  }

  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const branchId = randomUUID();

    this.db.prepare(`
      INSERT INTO sessions (
        id, token, prompt_id, candidate_email, status, created_at,
        max_session_tokens, max_message_tokens, max_interactions,
        context_window, time_limit_minutes, tokens_used, interactions_used
      ) VALUES (
        ?, ?, ?, ?, 'active', ?,
        ?, ?, ?,
        ?, ?, 0, 0
      )
    `).run(
      id, token, config.prompt_id, config.candidate_email, now,
      config.constraint.max_session_tokens,
      config.constraint.max_message_tokens,
      config.constraint.max_interactions,
      config.constraint.context_window,
      config.constraint.time_limit_minutes,
    );

    this.db.prepare(`
      INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES (?, ?, 'main', NULL, NULL, ?)
    `).run(branchId, id, now);

    this.db.prepare(`
      INSERT INTO conversations (
        id, session_id, branch_id, title, archived, created_at, updated_at
      ) VALUES (?, ?, ?, 'main', 0, ?, ?)
    `).run(randomUUID(), id, branchId, now, now);

    return Promise.resolve({ id, token });
  }

  close(): void {
    this.db.close();
  }

  createAssessmentLink(config: CreateAssessmentLinkConfig): Promise<AssessmentLinkRecord> {
    this.db.prepare(`
      INSERT INTO assessment_links (
        id, token, url, prompt_id, candidate_email, created_at, expires_at, constraint_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id,
      config.token,
      config.url,
      config.prompt_id,
      config.candidate_email,
      config.created_at,
      config.expires_at,
      JSON.stringify(config.constraint),
    );

    return Promise.resolve({
      id: config.id,
      token: config.token,
      url: config.url,
      prompt_id: config.prompt_id,
      candidate_email: config.candidate_email,
      created_at: config.created_at,
      expires_at: config.expires_at,
      constraint: config.constraint,
    });
  }

  getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return Promise.resolve(row ? rowToSession(row) : null);
  }

  getSessionEvaluation(sessionId: string): Promise<SessionEvaluation | null> {
    const row = this.db.prepare(
      'SELECT * FROM session_evaluations WHERE session_id = ?',
    ).get(sessionId) as SessionEvaluationRow | undefined;
    return Promise.resolve(row ? rowToSessionEvaluation(row) : null);
  }

  upsertSessionEvaluation(sessionId: string, result: EvaluationResult, score: number): Promise<SessionEvaluation> {
    const now = Date.now();
    const existing = this.db.prepare(
      'SELECT created_at FROM session_evaluations WHERE session_id = ?',
    ).get(sessionId) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? now;

    this.db.prepare(`
      INSERT INTO session_evaluations (session_id, score, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        score = excluded.score,
        result_json = excluded.result_json,
        updated_at = excluded.updated_at
    `).run(sessionId, score, JSON.stringify(result), createdAt, now);

    this.db.prepare('UPDATE sessions SET score = ? WHERE id = ?').run(score, sessionId);

    return Promise.resolve({
      session_id: sessionId,
      score,
      result,
      created_at: createdAt,
      updated_at: now,
    });
  }

  getSessionReviewState(sessionId: string): Promise<SessionReviewState | null> {
    const row = this.db.prepare(
      'SELECT * FROM session_review_states WHERE session_id = ?',
    ).get(sessionId) as SessionReviewStateRow | undefined;
    return Promise.resolve(row ? rowToSessionReviewState(row) : null);
  }

  listSessionReviewStates(): Promise<SessionReviewState[]> {
    const rows = this.db.prepare(
      'SELECT * FROM session_review_states ORDER BY updated_at DESC',
    ).all() as SessionReviewStateRow[];
    return Promise.resolve(rows.map(rowToSessionReviewState));
  }

  upsertSessionReviewState(sessionId: string, status: SessionReviewStatus): Promise<SessionReviewState> {
    const now = Date.now();
    const existing = this.db.prepare(
      'SELECT * FROM session_review_states WHERE session_id = ?',
    ).get(sessionId) as SessionReviewStateRow | undefined;
    const firstViewedAt =
      status === 'unviewed' ? null : existing?.first_viewed_at ?? now;
    const lastViewedAt =
      status === 'unviewed' ? null : now;
    const reviewedAt =
      status === 'reviewed' ? now : null;

    this.db.prepare(`
      INSERT INTO session_review_states (
        session_id, status, first_viewed_at, last_viewed_at, reviewed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        first_viewed_at = excluded.first_viewed_at,
        last_viewed_at = excluded.last_viewed_at,
        reviewed_at = excluded.reviewed_at,
        updated_at = excluded.updated_at
    `).run(sessionId, status, firstViewedAt, lastViewedAt, reviewedAt, now);

    return Promise.resolve({
      session_id: sessionId,
      status,
      updated_at: now,
      ...(firstViewedAt !== null ? { first_viewed_at: firstViewedAt } : {}),
      ...(lastViewedAt !== null ? { last_viewed_at: lastViewedAt } : {}),
      ...(reviewedAt !== null ? { reviewed_at: reviewedAt } : {}),
    });
  }

  getSessionComparisonAnalysis(sessionId: string): Promise<SessionComparisonAnalysis | null> {
    const row = this.db.prepare(
      'SELECT * FROM session_comparison_analyses WHERE session_id = ?',
    ).get(sessionId) as SessionComparisonAnalysisRow | undefined;
    return Promise.resolve(row ? rowToSessionComparisonAnalysis(row) : null);
  }

  listSessionComparisonAnalysesByPrompt(promptId: string): Promise<SessionComparisonAnalysis[]> {
    const rows = this.db.prepare(
      'SELECT * FROM session_comparison_analyses WHERE prompt_id = ? ORDER BY comparison_score DESC, updated_at DESC',
    ).all(promptId) as SessionComparisonAnalysisRow[];
    return Promise.resolve(rows.map(rowToSessionComparisonAnalysis));
  }

  upsertSessionComparisonAnalysis(input: SessionComparisonAnalysisInput): Promise<SessionComparisonAnalysis> {
    const now = Date.now();
    const existing = this.db.prepare(
      'SELECT created_at FROM session_comparison_analyses WHERE session_id = ?',
    ).get(input.session_id) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? now;

    this.db.prepare(`
      INSERT INTO session_comparison_analyses (
        session_id, prompt_id, schema_version, comparison_score, recommendation,
        strengths_json, risks_json, summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        prompt_id = excluded.prompt_id,
        schema_version = excluded.schema_version,
        comparison_score = excluded.comparison_score,
        recommendation = excluded.recommendation,
        strengths_json = excluded.strengths_json,
        risks_json = excluded.risks_json,
        summary = excluded.summary,
        updated_at = excluded.updated_at
    `).run(
      input.session_id,
      input.prompt_id,
      input.schema_version,
      input.comparison_score,
      input.recommendation,
      JSON.stringify(input.strengths),
      JSON.stringify(input.risks),
      input.summary,
      createdAt,
      now,
    );

    return Promise.resolve({
      ...input,
      created_at: createdAt,
      updated_at: now,
    });
  }

  getSessionToken(id: string): Promise<string | null> {
    const row = this.db.prepare('SELECT token FROM sessions WHERE id = ?').get(id) as { token: string } | undefined;
    return Promise.resolve(row?.token ?? null);
  }

  getMainBranch(sessionId: string): Promise<SessionBranch | null> {
    const row = this.db.prepare(
      "SELECT * FROM session_branches WHERE session_id = ? AND name = 'main' LIMIT 1",
    ).get(sessionId) as SessionBranchRow | undefined;
    return Promise.resolve(row ? rowToSessionBranch(row) : null);
  }

  getBranch(sessionId: string, branchId: string): Promise<SessionBranch | null> {
    const row = this.db.prepare(
      'SELECT * FROM session_branches WHERE session_id = ? AND id = ? LIMIT 1',
    ).get(sessionId, branchId) as SessionBranchRow | undefined;
    return Promise.resolve(row ? rowToSessionBranch(row) : null);
  }

  listBranches(sessionId: string): Promise<SessionBranch[]> {
    const rows = this.db.prepare(
      'SELECT * FROM session_branches WHERE session_id = ? ORDER BY created_at ASC, id ASC',
    ).all(sessionId) as SessionBranchRow[];
    return Promise.resolve(rows.map(rowToSessionBranch));
  }

  getMainConversation(sessionId: string, branchId: string): Promise<ConversationSummary | null> {
    const row = this.db.prepare(
      `SELECT * FROM conversations
       WHERE session_id = ? AND branch_id = ?
       ORDER BY CASE WHEN title = 'main' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
    ).get(sessionId, branchId) as ConversationRow | undefined;
    return Promise.resolve(row ? rowToConversation(row) : null);
  }

  getConversation(sessionId: string, conversationId: string): Promise<ConversationSummary | null> {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? AND id = ? LIMIT 1',
    ).get(sessionId, conversationId) as ConversationRow | undefined;
    return Promise.resolve(row ? rowToConversation(row) : null);
  }

  listConversations(sessionId: string, branchId: string): Promise<ConversationSummary[]> {
    const rows = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? AND branch_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC',
    ).all(sessionId, branchId) as ConversationRow[];
    return Promise.resolve(rows.map(rowToConversation));
  }

  createConversation(config: CreateConversationConfig): Promise<ConversationSummary> {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db.prepare(
      `INSERT INTO conversations (
        id, session_id, branch_id, title, archived, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      config.session_id,
      config.branch_id,
      config.title?.trim() || 'New chat',
      config.archived ? 1 : 0,
      createdAt,
      createdAt,
    );

    return Promise.resolve({
      id,
      session_id: config.session_id,
      branch_id: config.branch_id,
      title: config.title?.trim() || 'New chat',
      archived: config.archived ?? false,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  updateConversation(config: UpdateConversationConfig): Promise<ConversationSummary | null> {
    const existing = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? AND id = ? LIMIT 1',
    ).get(config.session_id, config.conversation_id) as ConversationRow | undefined;
    if (!existing) {
      return Promise.resolve(null);
    }

    const nextTitle = config.title?.trim() || existing.title;
    const nextArchived = config.archived ?? Boolean(existing.archived);
    const updatedAt = Date.now();
    this.db.prepare(
      `UPDATE conversations
       SET title = ?, archived = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextTitle, nextArchived ? 1 : 0, updatedAt, config.conversation_id);

    return Promise.resolve({
      id: existing.id,
      session_id: existing.session_id,
      branch_id: existing.branch_id,
      title: nextTitle,
      archived: nextArchived,
      created_at: Number(existing.created_at),
      updated_at: updatedAt,
    });
  }

  createBranch(config: CreateBranchConfig): Promise<SessionBranch> {
    const id = randomUUID();
    const createdAt = Date.now();
    const parentConversation = config.conversation_id
      ? this.db.prepare(
          'SELECT * FROM conversations WHERE session_id = ? AND id = ? LIMIT 1',
        ).get(config.session_id, config.conversation_id) as ConversationRow | undefined
      : this.db.prepare(
          `SELECT * FROM conversations
           WHERE session_id = ? AND branch_id = ?
           ORDER BY CASE WHEN title = 'main' THEN 0 ELSE 1 END, created_at ASC
           LIMIT 1`,
        ).get(config.session_id, config.parent_branch_id) as ConversationRow | undefined;

    this.db.prepare(
      `INSERT INTO session_branches (
        id, session_id, name, parent_branch_id, forked_from_sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      config.session_id,
      config.name,
      config.parent_branch_id,
      config.forked_from_sequence,
      createdAt,
    );

    const mainConversationId = randomUUID();
    this.db.prepare(
      `INSERT INTO conversations (
        id, session_id, branch_id, title, archived, created_at, updated_at
      ) VALUES (?, ?, ?, 'main', 0, ?, ?)`,
    ).run(mainConversationId, config.session_id, id, createdAt, createdAt);

    this.db.prepare(
      `INSERT INTO messages (
        session_id, branch_id, conversation_id, turn_sequence, role, content, token_count, created_at
      )
      SELECT session_id, ?, ?, turn_sequence, role, content, token_count, created_at
      FROM messages
      WHERE session_id = ? AND branch_id = ? AND conversation_id = ? AND turn_sequence IS NOT NULL AND turn_sequence <= ?
      ORDER BY id ASC`,
    ).run(
      id,
      mainConversationId,
      config.session_id,
      config.parent_branch_id,
      parentConversation?.id ?? '',
      config.forked_from_sequence,
    );

    this.db.prepare(
      `INSERT INTO replay_events (
        session_id, branch_id, conversation_id, turn_sequence, type, timestamp, payload
      )
      SELECT session_id, ?, ?, turn_sequence, type, timestamp, payload
      FROM replay_events
      WHERE session_id = ? AND branch_id = ? AND conversation_id = ? AND turn_sequence IS NOT NULL AND turn_sequence <= ?
      ORDER BY timestamp ASC, id ASC`,
    ).run(
      id,
      mainConversationId,
      config.session_id,
      config.parent_branch_id,
      parentConversation?.id ?? '',
      config.forked_from_sequence,
    );

    const snapshot = this.db.prepare(
      `SELECT * FROM workspace_snapshots
       WHERE session_id = ? AND branch_id = ? AND (
         kind = 'draft' OR (turn_sequence IS NOT NULL AND turn_sequence <= ?)
       )
       ORDER BY
         CASE WHEN kind = 'draft' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
    ).get(
      config.session_id,
      config.parent_branch_id,
      config.forked_from_sequence,
    ) as WorkspaceSnapshotRow | undefined;

    if (snapshot) {
      this.db.prepare(
        `INSERT INTO workspace_snapshots (
          id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        snapshot.session_id,
        id,
        snapshot.turn_sequence,
        snapshot.label,
        createdAt,
        snapshot.active_path,
        snapshot.workspace_section,
        snapshot.filesystem_json,
        snapshot.mock_pg_json,
      );
    }

    return Promise.resolve({
      id,
      session_id: config.session_id,
      name: config.name,
      parent_branch_id: config.parent_branch_id,
      forked_from_sequence: config.forked_from_sequence,
      created_at: createdAt,
    });
  }

  allocateTurnSequence(sessionId: string): Promise<number> {
    const row = this.db.prepare(
      `SELECT MAX(turn_sequence) AS max_turn_sequence FROM (
         SELECT turn_sequence FROM messages WHERE session_id = ?
         UNION ALL
         SELECT turn_sequence FROM replay_events WHERE session_id = ?
         UNION ALL
         SELECT turn_sequence FROM workspace_snapshots WHERE session_id = ?
       )`,
    ).get(sessionId, sessionId, sessionId) as { max_turn_sequence: number | null };
    return Promise.resolve((row.max_turn_sequence ?? 0) + 1);
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
    const resolvedConversationId = conversationId ?? (
      this.db.prepare(
        `SELECT id FROM conversations
         WHERE session_id = ? AND branch_id = ?
         ORDER BY CASE WHEN title = 'main' THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`,
      ).get(sessionId, branchId) as { id: string } | undefined
    )?.id;
    if (!resolvedConversationId) {
      throw new Error(`Main conversation not found for branch ${branchId}`);
    }
    this.db.prepare(`
      INSERT INTO messages (session_id, branch_id, conversation_id, turn_sequence, role, content, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, branchId, resolvedConversationId, turnSequence, role, content, tokenCount, Date.now());
    this.db.prepare(
      'UPDATE conversations SET updated_at = ? WHERE id = ?',
    ).run(Date.now(), resolvedConversationId);
    return Promise.resolve();
  }

  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        throw new Error(`Main branch not found for session ${sessionId}`);
      }
      return this.addBranchMessage(sessionId, branch.id, null, role, content, tokenCount);
    });
  }

  getBranchMessages(
    sessionId: string,
    branchId: string,
    conversationId?: string,
    options?: { includeRewound?: boolean },
  ): Promise<StoredMessage[]> {
    const includeRewound = options?.includeRewound ?? false;
    const rewoundFilter = includeRewound ? '' : 'AND rewound_at IS NULL';

    const rows = conversationId
      ? this.db.prepare(
          `SELECT * FROM messages WHERE session_id = ? AND branch_id = ? AND conversation_id = ? ${rewoundFilter} ORDER BY id ASC`,
        ).all(sessionId, branchId, conversationId) as MessageRow[]
      : this.db.prepare(
          `SELECT * FROM messages WHERE session_id = ? AND branch_id = ? ${rewoundFilter} ORDER BY id ASC`,
        ).all(sessionId, branchId) as MessageRow[];

    return Promise.resolve(rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      branch_id: r.branch_id,
      conversation_id: r.conversation_id,
      turn_sequence: r.turn_sequence === null ? null : Number(r.turn_sequence),
      role: r.role as MessageRole,
      content: r.content,
      token_count: r.token_count,
      created_at: r.created_at,
      rewound_at: r.rewound_at ?? null,
    })));
  }

  rewindMessages(
    sessionId: string,
    branchId: string,
    conversationId: string,
    afterTurnSequence: number,
  ): Promise<void> {
    this.db.prepare(
      'UPDATE messages SET rewound_at = ? WHERE session_id = ? AND branch_id = ? AND conversation_id = ? AND turn_sequence > ?',
    ).run(Date.now(), sessionId, branchId, conversationId, afterTurnSequence);
    return Promise.resolve();
  }

  getMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        return [];
      }
      return this.getBranchMessages(sessionId, branch.id);
    });
  }

  closeSession(id: string, status: Exclude<SessionStatus, 'active'> = 'completed'): Promise<void> {
    this.db.prepare(`
      UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?
    `).run(status, Date.now(), id);
    return Promise.resolve();
  }

  archiveSession(id: string): Promise<Session | null> {
    this.db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(Date.now(), id);
    return this.getSession(id);
  }

  deleteSession(id: string): Promise<boolean> {
    const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id) as { id: string } | undefined;
    if (!existing) {
      return Promise.resolve(false);
    }

    const deleteSessionData = this.db.transaction((sessionId: string) => {
      this.db.prepare(
        `DELETE FROM conversation_context_attachments
         WHERE conversation_id IN (SELECT id FROM conversations WHERE session_id = ?)`,
      ).run(sessionId);
      this.db.prepare('DELETE FROM context_resources WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM workspace_snapshots WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM session_comparison_analyses WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM session_review_states WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM session_evaluations WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM assessment_link_uses WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM replay_events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversations WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM session_branches WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });

    deleteSessionData(id);
    return Promise.resolve(true);
  }

  purgeArchivedSessions(olderThan: number): Promise<number> {
    const rows = this.db.prepare(
      'SELECT id FROM sessions WHERE archived_at IS NOT NULL AND archived_at <= ?',
    ).all(olderThan) as Array<{ id: string }>;
    for (const row of rows) {
      void this.deleteSession(row.id);
    }
    return Promise.resolve(rows.length);
  }

  listSessions(): Promise<Session[]> {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRow[];
    return Promise.resolve(rows.map(rowToSession));
  }

  getSessionsByPrompt(promptId: string): Promise<Session[]> {
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE prompt_id = ? ORDER BY created_at DESC'
    ).all(promptId) as SessionRow[];
    return Promise.resolve(rows.map(rowToSession));
  }

  listAssessmentLinks(): Promise<AssessmentLinkRecord[]> {
    const rows = this.db.prepare(`
      SELECT
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
      ORDER BY l.created_at DESC
    `).all() as AssessmentLinkRow[];

    return Promise.resolve(rows.map(rowToAssessmentLink));
  }

  getAssessmentLink(id: string): Promise<AssessmentLinkRecord | null> {
    const row = this.db.prepare(`
      SELECT
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
      WHERE l.id = ?
    `).get(id) as AssessmentLinkRow | undefined;

    return Promise.resolve(row ? rowToAssessmentLink(row) : null);
  }

  validateSessionToken(id: string, token: string): Promise<boolean> {
    const row = this.db.prepare(
      'SELECT id FROM sessions WHERE id = ? AND token = ?'
    ).get(id, token);
    return Promise.resolve(row !== undefined);
  }

  updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void> {
    this.db.prepare(
      'UPDATE sessions SET tokens_used = tokens_used + ?, interactions_used = interactions_used + ? WHERE id = ?'
    ).run(additionalTokens, additionalInteractions, id);
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
    const resolvedConversationId = conversationId ?? (
      this.db.prepare(
        `SELECT id FROM conversations
         WHERE session_id = ? AND branch_id = ?
         ORDER BY CASE WHEN title = 'main' THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`,
      ).get(sessionId, branchId) as { id: string } | undefined
    )?.id;
    if (!resolvedConversationId) {
      throw new Error(`Main conversation not found for branch ${branchId}`);
    }
    this.db.prepare(
      'INSERT INTO replay_events (session_id, branch_id, conversation_id, turn_sequence, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(sessionId, branchId, resolvedConversationId, turnSequence, type, timestamp, JSON.stringify(payload));
    return Promise.resolve();
  }

  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        throw new Error(`Main branch not found for session ${sessionId}`);
      }
      return this.addBranchReplayEvent(sessionId, branch.id, null, type, timestamp, payload);
    });
  }

  getBranchReplayEvents(sessionId: string, branchId: string, conversationId?: string): Promise<StoredReplayEvent[]> {
    const rows = conversationId
      ? this.db.prepare(
          'SELECT * FROM replay_events WHERE session_id = ? AND branch_id = ? AND conversation_id = ? ORDER BY timestamp ASC, id ASC',
        ).all(sessionId, branchId, conversationId) as ReplayEventRow[]
      : this.db.prepare(
          'SELECT * FROM replay_events WHERE session_id = ? AND branch_id = ? ORDER BY timestamp ASC, id ASC',
        ).all(sessionId, branchId) as ReplayEventRow[];
    return Promise.resolve(rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      branch_id: r.branch_id,
      conversation_id: r.conversation_id,
      turn_sequence: r.turn_sequence === null ? null : Number(r.turn_sequence),
      type: r.type as ReplayEventType,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload) as unknown,
    })));
  }

  listConversationContextAttachments(conversationId: string): Promise<ContextAttachment[]> {
    const rows = this.db.prepare(
      'SELECT * FROM conversation_context_attachments WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    ).all(conversationId) as ContextAttachmentRow[];
    return Promise.resolve(rows.map(rowToContextAttachment));
  }

  replaceConversationContextAttachments(conversationId: string, attachments: ContextAttachmentInput[]): Promise<ContextAttachment[]> {
    this.db.prepare('DELETE FROM conversation_context_attachments WHERE conversation_id = ?').run(conversationId);
    const createdAt = Date.now();
    for (const attachment of attachments) {
      this.db.prepare(
        `INSERT INTO conversation_context_attachments (
          id, conversation_id, kind, label, path, resource_id, source_conversation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        conversationId,
        attachment.kind,
        attachment.label,
        attachment.path ?? null,
        attachment.resource_id ?? null,
        attachment.source_conversation_id ?? null,
        createdAt,
      );
    }
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, conversationId);
    return this.listConversationContextAttachments(conversationId);
  }

  listContextResources(sessionId: string, branchId: string): Promise<ContextResource[]> {
    const rows = this.db.prepare(
      'SELECT * FROM context_resources WHERE session_id = ? AND branch_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC',
    ).all(sessionId, branchId) as ContextResourceRow[];
    return Promise.resolve(rows.map(rowToContextResource));
  }

  upsertContextResource(input: ContextResourceInput): Promise<ContextResource> {
    const existing = this.db.prepare(
      `SELECT * FROM context_resources
       WHERE session_id = ? AND branch_id = ? AND kind = ? AND (
         (? IS NULL AND source_conversation_id IS NULL) OR source_conversation_id = ?
       )
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(
      input.session_id,
      input.branch_id,
      input.kind,
      input.source_conversation_id ?? null,
      input.source_conversation_id ?? null,
    ) as ContextResourceRow | undefined;
    const timestamp = Date.now();

    if (existing) {
      this.db.prepare(
        `UPDATE context_resources
         SET title = ?, content = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.title, input.content, timestamp, existing.id);
      return Promise.resolve({
        id: existing.id,
        session_id: existing.session_id,
        branch_id: existing.branch_id,
        kind: existing.kind as ContextResourceKind,
        title: input.title,
        content: input.content,
        created_at: Number(existing.created_at),
        updated_at: timestamp,
        ...(existing.source_conversation_id ? { source_conversation_id: existing.source_conversation_id } : {}),
      });
    }

    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO context_resources (
        id, session_id, branch_id, kind, title, content, source_conversation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.session_id,
      input.branch_id,
      input.kind,
      input.title,
      input.content,
      input.source_conversation_id ?? null,
      timestamp,
      timestamp,
    );

    return Promise.resolve({
      id,
      session_id: input.session_id,
      branch_id: input.branch_id,
      kind: input.kind,
      title: input.title,
      content: input.content,
      created_at: timestamp,
      updated_at: timestamp,
      ...(input.source_conversation_id ? { source_conversation_id: input.source_conversation_id } : {}),
    });
  }

  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]> {
    return this.getMainBranch(sessionId).then((branch) => {
      if (!branch) {
        return [];
      }
      return this.getBranchReplayEvents(sessionId, branch.id);
    });
  }

  async upsertWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    const createdAt = input.created_at ?? Date.now();
    const existing = this.db.prepare(
      `SELECT id FROM workspace_snapshots
       WHERE session_id = ? AND branch_id = ? AND kind = ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(input.session_id, input.branch_id, input.kind) as { id: string } | undefined;

    if (existing && input.kind === 'draft') {
      this.db.prepare(
        `UPDATE workspace_snapshots
         SET turn_sequence = ?, label = ?, created_at = ?, active_path = ?, workspace_section = ?, filesystem_json = ?, mock_pg_json = ?
         WHERE id = ?`,
      ).run(
        input.turn_sequence ?? null,
        input.label ?? null,
        createdAt,
        input.active_path ?? null,
        input.workspace_section ?? null,
        JSON.stringify(input.filesystem),
        JSON.stringify(input.mock_pg),
        existing.id,
      );

      const row = this.db.prepare('SELECT * FROM workspace_snapshots WHERE id = ?').get(existing.id) as WorkspaceSnapshotRow;
      return rowToWorkspaceSnapshot(row);
    }

    return this.createWorkspaceSnapshot({ ...input, created_at: createdAt });
  }

  createWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot> {
    const id = randomUUID();
    const createdAt = input.created_at ?? Date.now();
    this.db.prepare(
      `INSERT INTO workspace_snapshots (
        id, session_id, branch_id, kind, turn_sequence, label, created_at, active_path, workspace_section, filesystem_json, mock_pg_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
    );

    return Promise.resolve({
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
    });
  }

  getWorkspaceSnapshot(
    sessionId: string,
    branchId: string,
    options: { kind?: WorkspaceSnapshotKind; turn_sequence?: number } = {},
  ): Promise<WorkspaceSnapshot | null> {
    let row: WorkspaceSnapshotRow | undefined;

    if (options.turn_sequence !== undefined) {
      row = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = ? AND branch_id = ? AND turn_sequence = ? AND (? IS NULL OR kind = ?)
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(
        sessionId,
        branchId,
        options.turn_sequence,
        options.kind ?? null,
        options.kind ?? null,
      ) as WorkspaceSnapshotRow | undefined;
    } else if (options.kind) {
      row = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = ? AND branch_id = ? AND kind = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(sessionId, branchId, options.kind) as WorkspaceSnapshotRow | undefined;
    } else {
      row = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE session_id = ? AND branch_id = ?
         ORDER BY CASE WHEN kind = 'draft' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`,
      ).get(sessionId, branchId) as WorkspaceSnapshotRow | undefined;
    }

    return Promise.resolve(row ? rowToWorkspaceSnapshot(row) : null);
  }

  markAssessmentLinkUsed(linkId: string, sessionId: string): Promise<boolean> {
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO assessment_link_uses (link_id, session_id, used_at) VALUES (?, ?, ?)',
    ).run(linkId, sessionId, Date.now());
    return Promise.resolve(result.changes > 0);
  }

  isAssessmentLinkUsed(linkId: string): Promise<boolean> {
    const row = this.db.prepare(
      'SELECT link_id FROM assessment_link_uses WHERE link_id = ?',
    ).get(linkId);
    return Promise.resolve(row !== undefined);
  }

  getAssessmentLinkSessionId(linkId: string): Promise<string | null> {
    const row = this.db.prepare(
      'SELECT session_id FROM assessment_link_uses WHERE link_id = ?',
    ).get(linkId) as { session_id: string } | undefined;
    return Promise.resolve(row?.session_id ?? null);
  }

  deleteAssessmentLink(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM assessment_links WHERE id = ?').run(id);
    return Promise.resolve(result.changes > 0);
  }

  deleteAssessmentLinks(ids: string[]): Promise<number> {
    if (ids.length === 0) return Promise.resolve(0);
    const placeholders = ids.map(() => '?').join(', ');
    const result = this.db.prepare(`DELETE FROM assessment_links WHERE id IN (${placeholders})`).run(...ids);
    return Promise.resolve(result.changes);
  }

  createPrompt(config: CreatePromptConfig): Promise<PromptConfig> {
    const id = config.id ?? randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO prompts (id, title, description, difficulty, tags_json, acceptance_criteria_json, rubric_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      config.title,
      config.description ?? null,
      config.difficulty ?? null,
      JSON.stringify(config.tags ?? []),
      JSON.stringify(config.acceptance_criteria ?? []),
      JSON.stringify(config.rubric ?? []),
      now,
      now,
    );
    const row = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow;
    return Promise.resolve(rowToPromptConfig(row));
  }

  getPrompt(id: string): Promise<PromptConfig | null> {
    const row = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow | undefined;
    return Promise.resolve(row ? rowToPromptConfig(row) : null);
  }

  listPrompts(): Promise<PromptConfig[]> {
    const rows = this.db.prepare('SELECT * FROM prompts ORDER BY created_at ASC').all() as PromptRow[];
    return Promise.resolve(rows.map(rowToPromptConfig));
  }

  updatePrompt(config: UpdatePromptConfig): Promise<PromptConfig | null> {
    const existing = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(config.id) as PromptRow | undefined;
    if (!existing) return Promise.resolve(null);
    const now = Date.now();
    this.db.prepare(`
      UPDATE prompts SET
        title = ?,
        description = ?,
        difficulty = ?,
        tags_json = ?,
        acceptance_criteria_json = ?,
        rubric_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      config.title ?? existing.title,
      config.description !== undefined ? (config.description ?? null) : existing.description,
      config.difficulty !== undefined ? (config.difficulty ?? null) : existing.difficulty,
      config.tags !== undefined ? JSON.stringify(config.tags) : existing.tags_json,
      config.acceptance_criteria !== undefined ? JSON.stringify(config.acceptance_criteria) : existing.acceptance_criteria_json,
      config.rubric !== undefined ? JSON.stringify(config.rubric) : existing.rubric_json,
      now,
      config.id,
    );
    const row = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(config.id) as PromptRow;
    return Promise.resolve(rowToPromptConfig(row));
  }

  deletePrompt(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
    return Promise.resolve(result.changes > 0);
  }
}
