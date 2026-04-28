import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type {
  AdminComparisonResponse,
  AdminComparisonRow,
  AdminAssessmentLinkDetail,
  AdminAssessmentLinkSummary,
  AdminReviewRow,
  AdminReviewsResponse,
  AgentRequestMode,
  AssessmentLinkRecord,
  AssessmentLinkStatus,
  DatabaseAdapter,
  AgentAdapter,
  Config,
  Message,
  ConstraintsRemaining,
  ConversationSummary,
  SessionContext,
  ToolCall,
  ToolResult,
  AgentConfig,
  MessageRole,
  Constraint,
  PromptSummary,
  PromptConfig,
  PromptRubricQuestion,
  SessionComparisonAnalysis,
  SessionBranch,
  SessionReviewState,
  SessionReviewStatus,
  SessionStatus,
  SnapshotFile,
  ThinkingBlock,
  TokenUsage,
  WorkspaceSection,
  WorkspaceSnapshotKind,
  MockPgPoolExport,
  EvaluationResult,
} from '@lintic/core';
import {
  buildAssessmentLink,
  computeSessionMetrics,
  createAssessmentLinkToken,
  resolveAdminKey,
  resolveSecretKey,
  verifyAssessmentLinkToken,
  buildIterations,
  computeSessionAnalysisScore,
  extractRedisStats,
  aggregatePostgresStats,
  computeInfrastructureMetrics,
  truncateHistory,
} from '@lintic/core';
import {
  askAboutSession,
  compareCandidates,
  evaluateSession,
  type ComparisonCandidatePacket,
} from '../services/SynchronousEvaluatorService.js';
import { generateFullTask, generateCriteriaForTask } from '../services/PromptGenerationService.js';
import { OpenAIAdapter, AnthropicAdapter } from '@lintic/adapters';
import type { StoredMessage } from '@lintic/core';
import { requireToken } from '../middleware/auth.js';
import { requireAdminKey } from '../middleware/admin-auth.js';
import { runAgentLoop } from '../agent-loop.js';
import type { ToolRunner } from '../agent-loop.js';
import { buildSystemPrompt } from '../prompts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const COMPARISON_SCHEMA_VERSION = 'comparison-v1';
const COMPARISON_BATCH_SIZE = 8;
const COMPARISON_DIGEST_CHAR_LIMIT = 900;
const COMPARISON_SNIPPET_CHAR_LIMIT = 180;
const REVIEW_ARCHIVE_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;

/** Reconstruct a Message[] from stored rows, deserialising tool_use assistant turns and tool result rows. */
function buildHistory(storedMessages: StoredMessage[]): Message[] {
  return storedMessages.map((m) => {
    if (m.role === 'assistant') {
      try {
        const parsed = parseAssistantPayload(m.content);
        if (parsed) {
          return {
            role: 'assistant',
            content: parsed.content,
            ...(parsed.__type === 'tool_use' ? { tool_calls: parsed.tool_calls } : {}),
            ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
            ...(parsed.thinking_blocks ? { thinking_blocks: parsed.thinking_blocks } : {}),
          };
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

type StoredAssistantPayload =
  | {
      __type: 'tool_use';
      content: string | null;
      tool_calls: ToolCall[];
      thinking?: string | null;
      thinking_blocks?: ThinkingBlock[];
    }
  | {
      __type: 'assistant_response';
      content: string | null;
      thinking?: string | null;
      thinking_blocks?: ThinkingBlock[];
    };

function parseAssistantPayload(content: string): StoredAssistantPayload | null {
  const parsed = JSON.parse(content) as StoredAssistantPayload;
  if (
    parsed.__type === 'tool_use'
    || parsed.__type === 'assistant_response'
  ) {
    return parsed;
  }
  return null;
}

function encodeAssistantMessage(
  response: {
    content: string | null;
    tool_calls?: ToolCall[];
    thinking?: string | null;
    thinking_blocks?: ThinkingBlock[];
  },
): string {
  if (response.tool_calls?.length) {
    return JSON.stringify({
      __type: 'tool_use',
      content: response.content,
      tool_calls: response.tool_calls,
      ...(response.thinking !== undefined ? { thinking: response.thinking } : {}),
      ...(response.thinking_blocks?.length ? { thinking_blocks: response.thinking_blocks } : {}),
    } satisfies StoredAssistantPayload);
  }

  if (response.thinking !== undefined || response.thinking_blocks?.length) {
    return JSON.stringify({
      __type: 'assistant_response',
      content: response.content,
      ...(response.thinking !== undefined ? { thinking: response.thinking } : {}),
      ...(response.thinking_blocks?.length ? { thinking_blocks: response.thinking_blocks } : {}),
    } satisfies StoredAssistantPayload);
  }

  return response.content ?? '';
}

function isAgentConfig(v: unknown): v is AgentConfig {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c['provider'] === 'string' && typeof c['api_key'] === 'string' && typeof c['model'] === 'string';
}

function isAgentRequestMode(v: unknown): v is AgentRequestMode {
  return v === 'build' || v === 'plan';
}

function isConstraintOverride(v: unknown): v is Partial<Constraint> {
  return typeof v === 'object' && v !== null;
}

function mergeConstraints(base: Constraint, override?: Partial<Constraint>): Constraint {
  return {
    max_session_tokens: override?.max_session_tokens ?? base.max_session_tokens,
    max_message_tokens: override?.max_message_tokens ?? base.max_message_tokens,
    max_interactions: override?.max_interactions ?? base.max_interactions,
    context_window: override?.context_window ?? base.context_window,
    time_limit_minutes: override?.time_limit_minutes ?? base.time_limit_minutes,
  };
}

function createRequestHistory(
  storedMessages: StoredMessage[],
  mode: AgentRequestMode,
  planFilePath?: string,
  contextMessages: Message[] = [],
): Message[] {
  const history = buildHistory(storedMessages).filter((message) => message.role !== 'system');
  const promptOptions = planFilePath ? { planFilePath } : {};
  return [{
    role: 'system',
    content: buildSystemPrompt(mode, promptOptions),
  }, ...contextMessages, ...history];
}

function generatePlanFilePath(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `plans/${year}-${month}-${day}-${hours}${minutes}${seconds}-plan.md`;
}

function buildAgentSummary(config: Config): { provider: string; model: string } {
  return {
    provider: config.agent.provider,
    model: config.agent.model,
  };
}

function hasSessionExpired(session: { status: SessionStatus; created_at: number; constraint: Constraint }): boolean {
  if (session.status !== 'active') {
    return false;
  }

  const expiresAt = session.created_at + (session.constraint.time_limit_minutes * 60 * 1000);
  return Date.now() >= expiresAt;
}

async function resolveSessionWithExpiry(
  db: DatabaseAdapter,
  sessionId: string,
): Promise<import('@lintic/core').Session | null> {
  const session = await db.getSession(sessionId);
  if (!session) {
    return null;
  }

  if (!hasSessionExpired(session)) {
    return session;
  }

  const closedAt = Date.now();
  await db.closeSession(session.id, 'expired');
  return {
    ...session,
    status: 'expired',
    closed_at: closedAt,
  };
}

function buildBaseUrl(req: Request): string {
  const origin = req.get('origin');
  if (origin) {
    return origin.replace(/\/$/, '');
  }

  const protocol = req.protocol;
  const host = req.get('host') ?? 'localhost:3300';
  return `${protocol}://${host}`;
}

function toPromptSummary(prompt: PromptConfig): PromptSummary {
  return {
    id: prompt.id,
    title: prompt.title,
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.difficulty ? { difficulty: prompt.difficulty } : {}),
    ...(prompt.tags ? { tags: prompt.tags } : {}),
    ...(prompt.acceptance_criteria ? { acceptance_criteria: prompt.acceptance_criteria } : {}),
    ...(prompt.rubric ? { rubric: prompt.rubric } : {}),
  };
}

function getReviewStatus(state: SessionReviewState | null): SessionReviewStatus {
  return state?.status ?? 'unviewed';
}

function buildAdminReviewRow(
  session: import('@lintic/core').Session,
  prompt: PromptConfig | null,
  reviewState: SessionReviewState | null,
  comparison: SessionComparisonAnalysis | null,
): AdminReviewRow {
  const comparisonReady = comparison?.schema_version === COMPARISON_SCHEMA_VERSION;
  return {
    session_id: session.id,
    candidate_email: session.candidate_email,
    prompt_id: session.prompt_id,
    prompt_title: prompt?.title ?? session.prompt_id,
    completed_at: session.closed_at ?? session.created_at,
    ...(session.archived_at !== undefined ? { archived_at: session.archived_at } : {}),
    ...(session.score !== undefined ? { session_score: session.score } : {}),
    review_status: getReviewStatus(reviewState),
    comparison_status: comparisonReady ? 'ready' : 'pending',
    ...(comparisonReady ? { comparison_score: comparison.comparison_score } : {}),
  };
}

function buildAdminComparisonRow(
  session: import('@lintic/core').Session,
  prompt: PromptConfig | null,
  reviewState: SessionReviewState | null,
  comparison: SessionComparisonAnalysis | null,
): AdminComparisonRow {
  const base = buildAdminReviewRow(session, prompt, reviewState, comparison);
  const comparisonReady = comparison?.schema_version === COMPARISON_SCHEMA_VERSION;
  return {
    ...base,
    strengths: comparisonReady ? comparison.strengths : [],
    risks: comparisonReady ? comparison.risks : [],
    ...(comparisonReady ? {
      recommendation: comparison.recommendation,
      summary: comparison.summary,
    } : {}),
  };
}

function shortenSnippet(content: string, maxChars: number = COMPARISON_SNIPPET_CHAR_LIMIT): string {
  const trimmed = content.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

function buildTranscriptDigest(
  storedMessages: StoredMessage[],
  storedEvents: Array<{ type: string; payload: unknown }>,
): string {
  const activeMessages = storedMessages.filter((message) => message.rewound_at === null && message.content.trim().length > 0);
  const userMessages = activeMessages.filter((message) => message.role === 'user');
  const assistantMessages = activeMessages.filter((message) => message.role === 'assistant');
  const digestLines: string[] = [];

  userMessages.slice(0, 2).forEach((message, index) => {
    const snippet = shortenSnippet(message.content);
    if (snippet) digestLines.push(`Candidate early ${index + 1}: ${snippet}`);
  });

  userMessages.slice(-2).forEach((message, index) => {
    const snippet = shortenSnippet(message.content);
    if (snippet) digestLines.push(`Candidate late ${index + 1}: ${snippet}`);
  });

  assistantMessages.slice(-2).forEach((message, index) => {
    const snippet = shortenSnippet(message.content);
    if (snippet) digestLines.push(`Agent late ${index + 1}: ${snippet}`);
  });

  const errorLines = storedEvents.flatMap((event) => {
    if (event.type === 'agent_response' && typeof event.payload === 'object' && event.payload !== null) {
      const error = (event.payload as Record<string, unknown>)['error'];
      if (typeof error === 'string' && error.trim()) {
        return [`Agent error: ${shortenSnippet(error, 120)}`];
      }
    }
    if (event.type === 'tool_result' && typeof event.payload === 'object' && event.payload !== null) {
      const toolResults = (event.payload as Record<string, unknown>)['tool_results'];
      if (Array.isArray(toolResults)) {
        return toolResults.flatMap((result) => {
          if (typeof result !== 'object' || result === null) return [];
          const output = (result as Record<string, unknown>)['output'];
          const isError = (result as Record<string, unknown>)['is_error'];
          const name = (result as Record<string, unknown>)['name'];
          if (isError === true && typeof output === 'string') {
            return [`Tool error${typeof name === 'string' ? ` (${name})` : ''}: ${shortenSnippet(output, 120)}`];
          }
          return [];
        });
      }
    }
    return [];
  }).slice(0, 2);

  digestLines.push(...errorLines);

  const digest = digestLines.join('\n');
  return digest.length > COMPARISON_DIGEST_CHAR_LIMIT
    ? `${digest.slice(0, COMPARISON_DIGEST_CHAR_LIMIT)}...`
    : digest;
}

async function resolveAssessmentLinkStatus(
  record: AssessmentLinkRecord,
  db: DatabaseAdapter,
  secretKey?: string,
): Promise<AssessmentLinkStatus> {
  if (record.consumed_session_id) {
    return 'consumed';
  }
  if (record.expires_at <= Date.now()) {
    return 'expired';
  }
  const promptExists = (await db.getPrompt(record.prompt_id)) !== null;
  if (!secretKey || !promptExists) {
    return 'invalid';
  }

  try {
    const payload = await verifyAssessmentLinkToken(record.token, secretKey);
    if (
      payload.jti !== record.id
      || payload.prompt_id !== record.prompt_id
      || payload.email !== record.candidate_email
    ) {
      return 'invalid';
    }
  } catch {
    return 'invalid';
  }

  return 'active';
}

async function toAdminAssessmentLinkSummary(
  db: DatabaseAdapter,
  record: AssessmentLinkRecord,
  secretKey?: string,
): Promise<AdminAssessmentLinkSummary> {
  const prompt = await db.getPrompt(record.prompt_id);
  const sessionStatus: SessionStatus | undefined = record.consumed_session_id
    ? (await resolveSessionWithExpiry(db, record.consumed_session_id))?.status
    : undefined;
  const summary: AdminAssessmentLinkSummary = {
    id: record.id,
    url: record.url,
    prompt_id: record.prompt_id,
    candidate_email: record.candidate_email,
    created_at: record.created_at,
    expires_at: record.expires_at,
    status: await resolveAssessmentLinkStatus(record, db, secretKey),
    ...(sessionStatus ? { session_status: sessionStatus } : {}),
  };

  if (prompt) {
    summary.prompt = toPromptSummary(prompt);
  }
  if (record.consumed_session_id) {
    summary.consumed_session_id = record.consumed_session_id;
  }

  return summary;
}

async function toAdminAssessmentLinkDetail(
  db: DatabaseAdapter,
  record: AssessmentLinkRecord,
  secretKey?: string,
): Promise<AdminAssessmentLinkDetail> {
  const detail: AdminAssessmentLinkDetail = {
    ...(await toAdminAssessmentLinkSummary(db, record, secretKey)),
    token: record.token,
    constraint: record.constraint,
  };

  if (record.consumed_at !== undefined) {
    detail.consumed_at = record.consumed_at;
  }

  return detail;
}

async function buildComparisonCandidatePacket(
  db: DatabaseAdapter,
  session: import('@lintic/core').Session,
  promptTitle: string,
): Promise<ComparisonCandidatePacket> {
  const branch = await db.getMainBranch(session.id);
  if (!branch) {
    return {
      session_id: session.id,
      candidate_email: session.candidate_email,
      prompt_id: session.prompt_id,
      prompt_title: promptTitle,
      tokens_used: session.tokens_used,
      interactions_used: session.interactions_used,
      iteration_count: 0,
      rewind_count: 0,
      infrastructure: {
        caching_effectiveness: 0,
        error_handling_coverage: 0,
        scaling_awareness: 0,
      },
      transcript_digest: '',
    };
  }

  const allMessages = await db.getBranchMessages(session.id, branch.id, undefined, { includeRewound: true });
  const replayEvents = await db.getBranchReplayEvents(session.id, branch.id);
  const iterations = buildIterations(allMessages);
  const redisStats = extractRedisStats(replayEvents);
  const snapshot =
    await db.getWorkspaceSnapshot(session.id, branch.id, { kind: 'checkpoint' })
    ?? await db.getWorkspaceSnapshot(session.id, branch.id, { kind: 'turn' })
    ?? null;
  const pgStats = aggregatePostgresStats(snapshot?.mock_pg ?? []);
  const infrastructure = computeInfrastructureMetrics(redisStats, pgStats);
  const existingEvaluation = await db.getSessionEvaluation(session.id);

  return {
    session_id: session.id,
    candidate_email: session.candidate_email,
    prompt_id: session.prompt_id,
    prompt_title: promptTitle,
    tokens_used: session.tokens_used,
    interactions_used: session.interactions_used,
    iteration_count: iterations.length,
    rewind_count: iterations.filter((iteration) => iteration.rewound_at !== undefined).length,
    infrastructure: {
      caching_effectiveness: Math.round(infrastructure.caching_effectiveness.score * 100),
      error_handling_coverage: Math.round(infrastructure.error_handling_coverage.score * 100),
      scaling_awareness: Math.round(infrastructure.scaling_awareness.score * 100),
    },
    transcript_digest: buildTranscriptDigest(allMessages, replayEvents),
    ...(existingEvaluation ? { existing_summary: existingEvaluation.result.llm_evaluation.overall_summary } : {}),
  };
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

// ─── Pending tool results for SSE agent loop ──────────────────────────────────

/** Maps requestId → resolve function for the tool-results Promise. Times out after 5 minutes. */
const pendingToolResults = new Map<string, (results: ToolResult[]) => void>();

function registerPendingTools(requestId: string, resolve: (results: ToolResult[]) => void): void {
  pendingToolResults.set(requestId, resolve);
  setTimeout(() => {
    if (pendingToolResults.delete(requestId)) {
      resolve([]); // unblock the loop with empty results on timeout
    }
  }, 5 * 60 * 1000);
}

async function recordAgentError(db: DatabaseAdapter, sessionId: string, message: string): Promise<void> {
  await db.addReplayEvent(sessionId, 'agent_response', Date.now(), {
    content: null,
    stop_reason: 'error',
    error: message,
  });
}

async function resolveBranchOrRespond(
  db: DatabaseAdapter,
  res: Response,
  sessionId: string,
  branchId?: string,
): Promise<SessionBranch | null> {
  const branch = branchId
    ? await db.getBranch(sessionId, branchId)
    : await db.getMainBranch(sessionId);

  if (!branch) {
    res.status(404).json({ error: 'Branch not found' });
    return null;
  }

  return branch;
}

async function resolveConversationOrRespond(
  db: DatabaseAdapter,
  res: Response,
  sessionId: string,
  branchId: string,
  conversationId?: string,
): Promise<ConversationSummary | null> {
  const conversation = conversationId
    ? await db.getConversation(sessionId, conversationId)
    : await db.getMainConversation(sessionId, branchId);

  if (!conversation || conversation.branch_id !== branchId) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }

  return conversation;
}

function parseWorkspaceKind(value: unknown): WorkspaceSnapshotKind | undefined {
  return value === 'draft' || value === 'turn' || value === 'checkpoint' ? value : undefined;
}

function parseWorkspaceSection(value: unknown): WorkspaceSection | undefined {
  if (value === 'git') {
    return 'curl';
  }
  return value === 'code' || value === 'database' || value === 'curl' ? value : undefined;
}

function isSnapshotFileArray(value: unknown): value is SnapshotFile[] {
  return Array.isArray(value) && value.every((entry) => (
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as Record<string, unknown>)['path'] === 'string'
    && ((entry as Record<string, unknown>)['encoding'] === 'utf-8'
      || (entry as Record<string, unknown>)['encoding'] === 'base64')
    && typeof (entry as Record<string, unknown>)['content'] === 'string'
  ));
}

function isMockPgExportArray(value: unknown): value is MockPgPoolExport[] {
  return Array.isArray(value);
}

async function resolveContinuationTurnSequence(
  db: DatabaseAdapter,
  sessionId: string,
  branchId: string,
  conversationId?: string,
): Promise<number | null> {
  const messages = await db.getBranchMessages(sessionId, branchId, conversationId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnSequence = messages[index]?.turn_sequence;
    if (turnSequence !== null && turnSequence !== undefined) {
      return turnSequence;
    }
  }
  return null;
}

function titleFromMessage(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'New chat';
  }
  return normalized.length > 48 ? `${normalized.slice(0, 45).trimEnd()}...` : normalized;
}

function truncateContextContent(content: string, maxChars = 12000): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n\n[Truncated for context length]`;
}

function stripMarkdownPreview(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[`*_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createPreview(content: string, maxChars = 180): string {
  const normalized = stripMarkdownPreview(content);
  if (!normalized) {
    return '';
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3).trimEnd()}...` : normalized;
}

function estimateTokenCountFromText(content: string): number {
  const normalized = content.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function estimateTokenCountFromMessages(messages: Message[]): number {
  return messages.reduce((sum, message) => {
    const contentTokens = estimateTokenCountFromText(message.content ?? '');
    const toolTokens = message.tool_results
      ? estimateTokenCountFromText(JSON.stringify(message.tool_results))
      : 0;
    const callTokens = message.tool_calls
      ? estimateTokenCountFromText(JSON.stringify(message.tool_calls))
      : 0;
    return sum + contentTokens + toolTokens + callTokens;
  }, 0);
}

function countMeaningfulConversationMessages(storedMessages: StoredMessage[]): number {
  return storedMessages.filter((message) => (
    (message.role === 'user' || message.role === 'assistant') && message.content.trim().length > 0
  )).length;
}

function summarizeAttachedItems(
  attachments: Array<{ kind: 'file' | 'repo_map' | 'summary' | 'prior_conversation' }>,
): string[] {
  const counts = {
    repoMap: 0,
    files: 0,
    summaries: 0,
    priorChats: 0,
  };

  for (const attachment of attachments) {
    if (attachment.kind === 'repo_map') counts.repoMap += 1;
    if (attachment.kind === 'file') counts.files += 1;
    if (attachment.kind === 'summary') counts.summaries += 1;
    if (attachment.kind === 'prior_conversation') counts.priorChats += 1;
  }

  const parts: string[] = [];
  if (counts.repoMap > 0) parts.push('repo map');
  if (counts.files > 0) parts.push(`${counts.files} file${counts.files === 1 ? '' : 's'}`);
  if (counts.summaries > 0) parts.push(`${counts.summaries} saved summar${counts.summaries === 1 ? 'y' : 'ies'}`);
  if (counts.priorChats > 0) parts.push(`${counts.priorChats} chat histor${counts.priorChats === 1 ? 'y item' : 'y items'}`);
  return parts;
}

function buildRepoMapContent(filesystem: Array<{ path: string }>, activePath?: string | null): string {
  const lines = ['# Repository Map', ''];
  if (activePath) {
    lines.push(`Active file: ${activePath}`, '');
  }
  if (filesystem.length === 0) {
    lines.push('No workspace snapshot is available yet.');
    return lines.join('\n');
  }

  lines.push(`Files captured: ${filesystem.length}`, '');
  for (const file of [...filesystem].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200)) {
    lines.push(`- ${file.path}`);
  }
  if (filesystem.length > 200) {
    lines.push('', `...and ${filesystem.length - 200} more files`);
  }
  return lines.join('\n');
}

function buildConversationSummaryContent(
  conversation: ConversationSummary,
  storedMessages: StoredMessage[],
): string {
  const history = buildHistory(storedMessages).filter((message) => message.role !== 'system');
  const userTurns = history.filter((message) => message.role === 'user').slice(0, 6);
  const assistantTurns = history.filter((message) => message.role === 'assistant').slice(-4);
  const toolNames = history.flatMap((message) => message.tool_calls?.map((call) => call.name) ?? []);

  const lines = [
    `# Conversation Summary: ${conversation.title}`,
    '',
    `Messages: ${history.length}`,
    `Updated: ${new Date(conversation.updated_at).toISOString()}`,
    '',
  ];

  if (userTurns.length > 0) {
    lines.push('## User requests');
    for (const turn of userTurns) {
      const content = (turn.content ?? '').replace(/\s+/g, ' ').trim();
      lines.push(`- ${content.length > 180 ? `${content.slice(0, 177).trimEnd()}...` : content}`);
    }
    lines.push('');
  }

  if (assistantTurns.length > 0) {
    lines.push('## Recent agent responses');
    for (const turn of assistantTurns) {
      const content = (turn.content ?? '').replace(/\s+/g, ' ').trim();
      if (!content) {
        continue;
      }
      lines.push(`- ${content.length > 180 ? `${content.slice(0, 177).trimEnd()}...` : content}`);
    }
    lines.push('');
  }

  if (toolNames.length > 0) {
    lines.push('## Tools used');
    for (const tool of [...new Set(toolNames)]) {
      lines.push(`- ${tool}`);
    }
    lines.push('');
  }

  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.join('\n');
}

function buildConversationTranscriptForSummary(
  conversation: ConversationSummary,
  storedMessages: StoredMessage[],
): string {
  const history = buildHistory(storedMessages).filter((message) => message.role !== 'system');
  const lines = [
    `Conversation title: ${conversation.title}`,
    `Updated: ${new Date(conversation.updated_at).toISOString()}`,
    '',
    'Transcript:',
  ];

  history.forEach((message, index) => {
    if (message.role === 'tool') {
      const toolNames = message.tool_results?.map((result) => result.name).filter(Boolean) ?? [];
      lines.push(`${index + 1}. Tool results: ${toolNames.length > 0 ? toolNames.join(', ') : 'tool output'}`);
      return;
    }

    const content = (message.content ?? '').replace(/\s+/g, ' ').trim();
    if (!content) {
      return;
    }
    const roleLabel =
      message.role === 'user' ? 'User'
      : message.role === 'assistant' ? 'Assistant'
      : 'System';
    lines.push(`${index + 1}. ${roleLabel}: ${content}`);
  });

  return lines.join('\n');
}

async function generateConversationSummaryWithLlm(
  summaryAdapter: AgentAdapter,
  conversation: ConversationSummary,
  storedMessages: StoredMessage[],
): Promise<{ content: string; usage: TokenUsage }> {
  const transcript = buildConversationTranscriptForSummary(conversation, storedMessages);
  const context: SessionContext = {
    session_id: conversation.session_id,
    history: [
      {
        role: 'system',
        content: [
          'You summarize a coding chat for later context reuse.',
          'Write concise markdown with these sections in order:',
          '1. Summary',
          '2. Key Decisions',
          '3. Important Files or Systems',
          '4. Open Questions or Risks',
          'Keep it specific to the transcript. Do not invent details. Do not call tools.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: transcript,
      },
    ],
    constraints_remaining: {
      tokens_remaining: 1800,
      interactions_remaining: 1,
      seconds_remaining: 60,
    },
  };

  const response = await summaryAdapter.sendMessage(null, context);
  if (response.tool_calls?.length || response.stop_reason === 'tool_use') {
    throw new Error('Summary model attempted to call tools');
  }
  const content = response.content?.trim();
  if (!content) {
    throw new Error('Summary model returned empty content');
  }
  return { content, usage: response.usage };
}

async function ensureSummaryResourceForConversation(
  db: DatabaseAdapter,
  summaryAdapter: AgentAdapter,
  sessionId: string,
  branchId: string,
  conversation: ConversationSummary,
): Promise<{ resource: import('@lintic/core').ContextResource | null; storedMessages: StoredMessage[]; messageCount: number }> {
  const storedMessages = await db.getBranchMessages(sessionId, branchId, conversation.id);
  const messageCount = countMeaningfulConversationMessages(storedMessages);
  if (messageCount === 0) {
    return { resource: null, storedMessages, messageCount };
  }

  const generated = await generateConversationSummaryWithLlm(summaryAdapter, conversation, storedMessages);
  const resource = await db.upsertContextResource({
    session_id: sessionId,
    branch_id: branchId,
    kind: 'summary',
    title: `Summary: ${conversation.title}`,
    content: generated.content,
    source_conversation_id: conversation.id,
  });
  return { resource, storedMessages, messageCount };
}

async function buildContextMessages(
  db: DatabaseAdapter,
  sessionId: string,
  branchId: string,
  conversationId: string,
): Promise<Message[]> {
  const [attachments, resources, snapshot, conversations] = await Promise.all([
    db.listConversationContextAttachments(conversationId),
    db.listContextResources(sessionId, branchId),
    db.getWorkspaceSnapshot(sessionId, branchId, { kind: 'draft' }),
    db.listConversations(sessionId, branchId),
  ]);

  const resourceById = new Map(resources.map((resource) => [resource.id, resource] as const));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation] as const));
  const fileByPath = new Map(
    (snapshot?.filesystem ?? []).map((file) => [file.path, file] as const),
  );
  const contextMessages: Message[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === 'file' && attachment.path) {
      const file = fileByPath.get(attachment.path);
      if (!file) {
        continue;
      }
      contextMessages.push({
        role: 'system',
        content: [
          `Attached file context: ${attachment.label}`,
          '',
          `Path: ${attachment.path}`,
          '',
          '```',
          truncateContextContent(file.content, 10000),
          '```',
        ].join('\n'),
      });
      continue;
    }

    if ((attachment.kind === 'repo_map' || attachment.kind === 'summary') && attachment.resource_id) {
      const resource = resourceById.get(attachment.resource_id);
      if (!resource) {
        continue;
      }
      contextMessages.push({
        role: 'system',
        content: [
          `Attached ${attachment.kind.replace('_', ' ')}: ${attachment.label}`,
          '',
          truncateContextContent(resource.content),
        ].join('\n'),
      });
      continue;
    }

    if (attachment.kind === 'prior_conversation' && attachment.source_conversation_id) {
      const sourceConversation = conversationById.get(attachment.source_conversation_id);
      if (!sourceConversation) {
        continue;
      }
      const summaryResource = resources
        .filter((resource) => (
          resource.kind === 'summary' && resource.source_conversation_id === sourceConversation.id
        ))
        .sort((a, b) => b.updated_at - a.updated_at)[0];
      const summaryContent = summaryResource
        ? summaryResource.content
        : buildConversationSummaryContent(
            sourceConversation,
            await db.getBranchMessages(sessionId, branchId, sourceConversation.id),
          );
      contextMessages.push({
        role: 'system',
        content: [
          `Attached prior conversation snapshot: ${attachment.label}`,
          '',
          truncateContextContent(summaryContent),
        ].join('\n'),
      });
    }
  }

  return contextMessages;
}

async function maybeRetitleConversationFromMessage(
  db: DatabaseAdapter,
  conversation: ConversationSummary,
  sessionId: string,
  branchId: string,
  message: string,
): Promise<ConversationSummary> {
  if (conversation.title !== 'New chat' && conversation.title !== 'main') {
    return conversation;
  }
  const existingMessages = await db.getBranchMessages(sessionId, branchId, conversation.id);
  const hasUserTurn = existingMessages.some((stored) => stored.role === 'user');
  if (hasUserTurn) {
    return conversation;
  }

  return (await db.updateConversation({
    session_id: sessionId,
    conversation_id: conversation.id,
    title: titleFromMessage(message),
  })) ?? conversation;
}

function buildDefaultConversationAttachments(
  _db: DatabaseAdapter,
  _sessionId: string,
  _branchId: string,
  _sourceConversationId?: string,
  _activePath?: string,
): Array<{
  kind: 'file' | 'repo_map';
  label: string;
  path?: string;
  resource_id?: string;
}> {
  return [];
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createApiRouter(db: DatabaseAdapter, adapter: AgentAdapter, config: Config): Router {
  const router = Router();
  const adminKey = resolveAdminKey(config.api?.admin_key);
  const secretKey = resolveSecretKey(config.api?.secret_key);

  router.get('/prompts', requireAdminKey(adminKey), asyncRoute(async (_req, res) => {
    const prompts = await db.listPrompts();
    res.json({ prompts: prompts.map(toPromptSummary) });
  }));

  // Must be registered before /:id routes to avoid Express param matching 'generate' as an ID
  router.post('/prompts/generate', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    if (!config.evaluation) {
      res.status(422).json({ error: 'No evaluation config configured. Add an evaluation block to lintic.yml.' });
      return;
    }
    const body = req.body as { description?: unknown };
    if (typeof body.description !== 'string' || !body.description.trim()) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    const generated = await generateFullTask(body.description.trim(), config.evaluation);
    res.json({ prompt: generated });
  }));

  router.post('/prompts', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body['title'] !== 'string' || !body['title'].trim()) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const customId = typeof body['id'] === 'string' && body['id'].trim() ? body['id'].trim() : undefined;
    const created = await db.createPrompt({
      ...(customId ? { id: customId } : {}),
      title: body['title'].trim(),
      ...(typeof body['description'] === 'string' ? { description: body['description'] } : {}),
      ...(typeof body['difficulty'] === 'string' ? { difficulty: body['difficulty'] } : {}),
      tags: Array.isArray(body['tags']) ? (body['tags'] as string[]) : [],
      acceptance_criteria: Array.isArray(body['acceptance_criteria'])
        ? (body['acceptance_criteria'] as string[])
        : [],
      rubric: Array.isArray(body['rubric']) ? (body['rubric'] as PromptRubricQuestion[]) : [],
    });
    res.status(201).json({ prompt: created });
  }));

  router.put('/prompts/:id', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const updatePayload: import('@lintic/core').UpdatePromptConfig = {
      id: req.params['id'] as string,
    };
    if (typeof body['title'] === 'string') updatePayload.title = body['title'];
    if (body['description'] !== undefined) updatePayload.description = body['description'] as string | null;
    if (body['difficulty'] !== undefined) updatePayload.difficulty = body['difficulty'] as string | null;
    if (Array.isArray(body['tags'])) updatePayload.tags = body['tags'] as string[];
    if (Array.isArray(body['acceptance_criteria'])) updatePayload.acceptance_criteria = body['acceptance_criteria'] as string[];
    if (Array.isArray(body['rubric'])) updatePayload.rubric = body['rubric'] as PromptRubricQuestion[];
    const updated = await db.updatePrompt(updatePayload);
    if (!updated) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json({ prompt: updated });
  }));

  router.delete('/prompts/:id', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const deleted = await db.deletePrompt(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json({ deleted: true });
  }));

  router.post('/prompts/:id/generate-criteria', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    if (!config.evaluation) {
      res.status(422).json({ error: 'No evaluation config configured. Add an evaluation block to lintic.yml.' });
      return;
    }
    const prompt = await db.getPrompt(req.params['id'] as string);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    const generated = await generateCriteriaForTask(
      { title: prompt.title, ...(prompt.description ? { description: prompt.description } : {}) },
      config.evaluation,
    );
    res.json(generated);
  }));

  router.post('/links', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    if (!secretKey) {
      res.status(503).json({ error: 'Assessment link signing secret is not configured' });
      return;
    }

    const body = req.body as {
      prompt_id?: unknown;
      email?: unknown;
      expires_in_hours?: unknown;
      constraint_overrides?: unknown;
    };

    if (typeof body.prompt_id !== 'string' || !body.prompt_id) {
      res.status(400).json({ error: 'prompt_id is required' });
      return;
    }
    if (typeof body.email !== 'string' || !body.email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const prompt = await db.getPrompt(body.prompt_id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const expiresInHours = typeof body.expires_in_hours === 'number' && body.expires_in_hours > 0
      ? body.expires_in_hours
      : 72;
    const constraints = mergeConstraints(
      config.constraints,
      isConstraintOverride(body.constraint_overrides) ? body.constraint_overrides : undefined,
    );

    const createdAt = Date.now();
    const generated = await createAssessmentLinkToken(
      { prompt_id: body.prompt_id, email: body.email, constraint: constraints },
      secretKey,
      expiresInHours,
    );

    const generatedLink = buildAssessmentLink(
      buildBaseUrl(req),
      generated.token,
      body.prompt_id,
      body.email,
      generated.expiresAt,
    );

    const link = await db.createAssessmentLink({
      id: generated.jti,
      token: generatedLink.token,
      url: generatedLink.url,
      prompt_id: body.prompt_id,
      candidate_email: body.email,
      created_at: createdAt,
      expires_at: generated.expiresAt.getTime(),
      constraint: constraints,
    });

    const detail = await toAdminAssessmentLinkDetail(db, link, secretKey);

    res.status(201).json({
      ...detail,
      prompt: toPromptSummary(prompt),
      email: detail.candidate_email,
    });
  }));

  router.get('/links', requireAdminKey(adminKey), asyncRoute(async (_req, res) => {
    const records = await db.listAssessmentLinks();
    const links = await Promise.all(
      records.map((record) => toAdminAssessmentLinkSummary(db, record, secretKey)),
    );

    res.json({ links });
  }));

  router.post('/links/consume', asyncRoute(async (req, res) => {
    if (!secretKey) {
      res.status(503).json({ error: 'Assessment link signing secret is not configured' });
      return;
    }

    const body = req.body as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) {
      res.status(400).json({ error: 'token is required' });
      return;
    }

    let payload;
    try {
      payload = await verifyAssessmentLinkToken(body.token, secretKey);
    } catch {
      res.status(410).json({ error: 'Assessment expired' });
      return;
    }

    const prompt = await db.getPrompt(payload.prompt_id);
    if (!prompt) {
      res.status(409).json({ error: 'Link is no longer valid' });
      return;
    }

    const existingSessionId = await db.getAssessmentLinkSessionId(payload.jti);
    if (existingSessionId) {
      const existingSession = await resolveSessionWithExpiry(db, existingSessionId);
      const existingToken = await db.getSessionToken(existingSessionId);
      if (!existingSession || !existingToken) {
        res.status(409).json({ error: 'Link is no longer valid' });
        return;
      }

      res.status(200).json({
        session_id: existingSession.id,
        token: existingToken,
        prompt_id: existingSession.prompt_id,
        prompt: toPromptSummary(prompt),
        agent: buildAgentSummary(config),
        email: existingSession.candidate_email,
        expires_at: new Date(payload.exp * 1000).toISOString(),
      });
      return;
    }

    const { id, token } = await db.createSession({
      prompt_id: payload.prompt_id,
      candidate_email: payload.email,
      constraint: payload.constraint,
    });

    const marked = await db.markAssessmentLinkUsed(payload.jti, id);
    if (!marked) {
      res.status(409).json({ error: 'Link is no longer valid' });
      return;
    }

    res.status(201).json({
      session_id: id,
      token,
      prompt_id: payload.prompt_id,
      prompt: toPromptSummary(prompt),
      agent: buildAgentSummary(config),
      email: payload.email,
      expires_at: new Date(payload.exp * 1000).toISOString(),
    });
  }));

  router.get('/links/:id', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const link = await db.getAssessmentLink(req.params['id'] as string);
    if (!link) {
      res.status(404).json({ error: 'Assessment link not found' });
      return;
    }

    res.json({
      link: await toAdminAssessmentLinkDetail(db, link, secretKey),
    });
  }));

  router.delete('/links/:id', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const deleted = await db.deleteAssessmentLink(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Assessment link not found' });
      return;
    }
    res.json({ deleted: 1 });
  }));

  router.delete('/links', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const body = req.body as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'ids must be a non-empty array of strings' });
      return;
    }
    const count = await db.deleteAssessmentLinks(body.ids);
    res.json({ deleted: count });
  }));

  router.get('/reviews', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    await db.purgeArchivedSessions(Date.now() - REVIEW_ARCHIVE_RETENTION_MS);
    const showArchived = req.query['archived'] === 'true';
    const completedSessions = (await db.listSessions()).filter((session) => (
      session.status !== 'active' && (showArchived ? session.archived_at !== undefined : session.archived_at === undefined)
    ));
    const reviews = await Promise.all(completedSessions.map(async (session): Promise<AdminReviewRow> => {
      const [prompt, reviewState, comparison] = await Promise.all([
        db.getPrompt(session.prompt_id),
        db.getSessionReviewState(session.id),
        db.getSessionComparisonAnalysis(session.id),
      ]);
      return buildAdminReviewRow(session, prompt, reviewState, comparison);
    }));

    reviews.sort((a, b) => {
      const promptCmp = a.prompt_title.localeCompare(b.prompt_title);
      if (promptCmp !== 0) return promptCmp;
      const statusOrder: Record<SessionReviewStatus, number> = { unviewed: 0, viewed: 1, passed: 2 };
      const statusCmp = statusOrder[a.review_status] - statusOrder[b.review_status];
      if (statusCmp !== 0) return statusCmp;
      return b.completed_at - a.completed_at;
    });

    res.json({ reviews } satisfies AdminReviewsResponse);
  }));

  router.post('/reviews/:sessionId/archive', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const sessionId = req.params['sessionId'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status === 'active') {
      res.status(400).json({ error: 'Only completed reviews can be archived' });
      return;
    }

    const archived = await db.archiveSession(sessionId);
    res.json({ session: archived });
  }));

  router.delete('/reviews/:sessionId', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const sessionId = req.params['sessionId'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.archived_at === undefined) {
      res.status(400).json({ error: 'Archive a review before permanently deleting it' });
      return;
    }

    const deleted = await db.deleteSession(sessionId);
    res.json({ deleted });
  }));

  router.post('/reviews/:sessionId/viewed', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const sessionId = req.params['sessionId'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const existing = await db.getSessionReviewState(sessionId);
    const nextState = existing?.status === 'passed'
      ? existing
      : await db.upsertSessionReviewState(sessionId, 'viewed');
    res.json({ review_state: nextState });
  }));

  router.patch('/reviews/:sessionId/status', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const sessionId = req.params['sessionId'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const body = req.body as { status?: unknown };
    if (body.status !== 'viewed' && body.status !== 'passed') {
      res.status(400).json({ error: "status must be 'viewed' or 'passed'" });
      return;
    }

    const reviewState = await db.upsertSessionReviewState(sessionId, body.status as SessionReviewStatus);
    res.json({ review_state: reviewState });
  }));

  router.get('/reviews/comparison', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const promptId = typeof req.query['prompt_id'] === 'string' ? req.query['prompt_id'].trim() : '';
    if (!promptId) {
      res.status(400).json({ error: 'prompt_id is required' });
      return;
    }

    const prompt = await db.getPrompt(promptId);
    const completedSessions = (await db.getSessionsByPrompt(promptId)).filter((session) => (
      session.status !== 'active' && session.archived_at === undefined
    ));
    const rows = await Promise.all(completedSessions.map(async (session): Promise<AdminComparisonRow> => {
      const [reviewState, comparison] = await Promise.all([
        db.getSessionReviewState(session.id),
        db.getSessionComparisonAnalysis(session.id),
      ]);
      return buildAdminComparisonRow(session, prompt, reviewState, comparison);
    }));

    rows.sort((a, b) => {
      if (a.comparison_status !== b.comparison_status) {
        return a.comparison_status === 'ready' ? -1 : 1;
      }
      return (b.comparison_score ?? -1) - (a.comparison_score ?? -1) || b.completed_at - a.completed_at;
    });

    res.json({
      prompt: prompt ? toPromptSummary(prompt) : null,
      rows,
    } satisfies AdminComparisonResponse);
  }));

  router.post('/reviews/comparison/run', requireAdminKey(adminKey), asyncRoute(async (req, res) => {
    const body = req.body as { prompt_id?: unknown };
    const promptId = typeof body.prompt_id === 'string' ? body.prompt_id.trim() : '';
    if (!promptId) {
      res.status(400).json({ error: 'prompt_id is required' });
      return;
    }

    if (!config.evaluation) {
      res.status(422).json({ error: 'No evaluation config found in lintic.yml' });
      return;
    }

    const prompt = await db.getPrompt(promptId);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const completedSessions = (await db.getSessionsByPrompt(promptId)).filter((session) => (
      session.status !== 'active' && session.archived_at === undefined
    ));
    const existingAnalyses = await db.listSessionComparisonAnalysesByPrompt(promptId);
    const existingBySession = new Map(existingAnalyses.map((analysis) => [analysis.session_id, analysis]));
    const pendingSessions = completedSessions.filter((session) => {
      const existing = existingBySession.get(session.id);
      return !existing || existing.schema_version !== COMPARISON_SCHEMA_VERSION;
    });

    for (let start = 0; start < pendingSessions.length; start += COMPARISON_BATCH_SIZE) {
      const chunk = pendingSessions.slice(start, start + COMPARISON_BATCH_SIZE);
      const packets = await Promise.all(
        chunk.map((session) => buildComparisonCandidatePacket(db, session, prompt.title)),
      );
      const analyses = await compareCandidates({
        prompt_id: prompt.id,
        prompt_title: prompt.title,
        candidates: packets,
        evaluationConfig: config.evaluation,
      });
      const analysisBySession = new Map(analyses.map((analysis) => [analysis.session_id, analysis]));
      for (const session of chunk) {
        const analysis = analysisBySession.get(session.id);
        if (!analysis) {
          throw new Error(`Comparison evaluator returned no analysis for session ${session.id}`);
        }
        await db.upsertSessionComparisonAnalysis({
          session_id: session.id,
          prompt_id: prompt.id,
          schema_version: COMPARISON_SCHEMA_VERSION,
          comparison_score: analysis.comparison_score,
          recommendation: analysis.recommendation,
          strengths: analysis.strengths,
          risks: analysis.risks,
          summary: analysis.summary,
        });
      }
    }

    const refreshedAnalyses = await db.listSessionComparisonAnalysesByPrompt(promptId);
    const analysisBySession = new Map(refreshedAnalyses.map((analysis) => [analysis.session_id, analysis]));
    const rows = await Promise.all(completedSessions.map(async (session): Promise<AdminComparisonRow> => {
      const reviewState = await db.getSessionReviewState(session.id);
      return buildAdminComparisonRow(session, prompt, reviewState, analysisBySession.get(session.id) ?? null);
    }));

    rows.sort((a, b) => {
      if (a.comparison_status !== b.comparison_status) {
        return a.comparison_status === 'ready' ? -1 : 1;
      }
      return (b.comparison_score ?? -1) - (a.comparison_score ?? -1) || b.completed_at - a.completed_at;
    });

    res.json({
      prompt: toPromptSummary(prompt),
      rows,
    } satisfies AdminComparisonResponse);
  }));

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

    const prompt = await db.getPrompt(body.prompt_id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    const { id, token } = await db.createSession({
      prompt_id: body.prompt_id,
      candidate_email: body.candidate_email,
      constraint: config.constraints,
    });
    const branch = await db.getMainBranch(id);

    res.status(201).json({
      session_id: id,
      token,
      assessment_link: `/assessment/${id}?token=${token}`,
      prompt: toPromptSummary(prompt),
      agent: buildAgentSummary(config),
      branch,
    });
  }));

  // GET /api/sessions/:id — get session state with remaining constraints
  router.get('/sessions/:id', requireToken(db), asyncRoute(async (req, res) => {
    const session = await resolveSessionWithExpiry(db, req.params['id'] as string);
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

    const branches = await db.listBranches(session.id);
    const branch = await db.getMainBranch(session.id);
    const conversations = branch ? await db.listConversations(session.id, branch.id) : [];
    const conversation = branch ? await db.getMainConversation(session.id, branch.id) : null;

    res.json({
      session,
      constraints_remaining,
      agent: buildAgentSummary(config),
      branch,
      branches,
      conversation,
      conversations,
      active_conversation_id: conversation?.id ?? null,
    });
  }));

  router.get('/sessions/:id/branches', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branches = await db.listBranches(sessionId);
    const currentBranch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof req.query['branch_id'] === 'string' ? req.query['branch_id'] : undefined,
    );
    if (!currentBranch) {
      return;
    }

    res.json({
      branches,
      current_branch_id: currentBranch.id,
    });
  }));

  router.post('/sessions/:id/branches', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      name?: unknown;
      branch_id?: unknown;
      forked_from_sequence?: unknown;
      conversation_id?: unknown;
    };

    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (typeof body.forked_from_sequence !== 'number' || !Number.isInteger(body.forked_from_sequence) || body.forked_from_sequence < 1) {
      res.status(400).json({ error: 'forked_from_sequence must be a positive integer' });
      return;
    }

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const parentBranch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!parentBranch) {
      return;
    }
    const parentConversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      parentBranch.id,
      typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
    );
    if (!parentConversation) {
      return;
    }

    const branchName = body.name.trim();
    const existingBranches = await db.listBranches(sessionId);
    if (existingBranches.some((branch) => branch.name === branchName)) {
      res.status(409).json({ error: 'A branch with that name already exists' });
      return;
    }

    const parentMessages = await db.getBranchMessages(sessionId, parentBranch.id, parentConversation.id);
    const hasCompletedTurn = parentMessages.some((message) => (
      message.turn_sequence === body.forked_from_sequence && message.role === 'assistant'
    ));
    if (!hasCompletedTurn) {
      res.status(400).json({ error: 'forked_from_sequence must reference a completed assistant turn' });
      return;
    }

    const branch = await db.createBranch({
      session_id: sessionId,
      name: branchName,
      parent_branch_id: parentBranch.id,
      forked_from_sequence: body.forked_from_sequence,
      conversation_id: parentConversation.id,
    });

    res.status(201).json({
      branch,
      branches: await db.listBranches(sessionId),
    });
  }));

  router.get('/sessions/:id/conversations', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof req.query['branch_id'] === 'string' ? req.query['branch_id'] : undefined,
    );
    if (!branch) {
      return;
    }

    const activeConversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof req.query['conversation_id'] === 'string' ? req.query['conversation_id'] : undefined,
    );
    if (!activeConversation) {
      return;
    }

    const conversations = await db.listConversations(sessionId, branch.id);
    res.json({
      branch,
      conversations,
      active_conversation_id: activeConversation.id,
    });
  }));

  router.post('/sessions/:id/conversations', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      branch_id?: unknown;
      title?: unknown;
      source_conversation_id?: unknown;
      active_path?: unknown;
    };

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }

    const sourceConversation = typeof body.source_conversation_id === 'string'
      ? await resolveConversationOrRespond(db, res, sessionId, branch.id, body.source_conversation_id)
      : null;
    if (typeof body.source_conversation_id === 'string' && !sourceConversation) {
      return;
    }

    const conversation = await db.createConversation({
      session_id: sessionId,
      branch_id: branch.id,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New chat',
    });

  const defaultAttachments = buildDefaultConversationAttachments(
      db,
      sessionId,
      branch.id,
      sourceConversation?.id,
      typeof body.active_path === 'string' ? body.active_path : undefined,
    );
    const attachments = await db.replaceConversationContextAttachments(
      conversation.id,
      defaultAttachments.map((attachment) => ({
        kind: attachment.kind,
        label: attachment.label,
        ...(attachment.path ? { path: attachment.path } : {}),
        ...(attachment.resource_id ? { resource_id: attachment.resource_id } : {}),
      })),
    );

    res.status(201).json({
      branch,
      conversation,
      conversations: await db.listConversations(sessionId, branch.id),
      attachments,
      active_conversation_id: conversation.id,
    });
  }));

  router.patch('/sessions/:id/conversations/:conversationId', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const conversationId = req.params['conversationId'] as string;
    const body = req.body as { title?: unknown; archived?: unknown };

    const existing = await db.getConversation(sessionId, conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    if (body.title !== undefined && typeof body.title !== 'string') {
      res.status(400).json({ error: 'title must be a string when provided' });
      return;
    }
    if (body.archived !== undefined && typeof body.archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean when provided' });
      return;
    }

    const conversation = await db.updateConversation({
      session_id: sessionId,
      conversation_id: conversationId,
      ...(typeof body.title === 'string' ? { title: body.title.trim() || existing.title } : {}),
      ...(typeof body.archived === 'boolean' ? { archived: body.archived } : {}),
    });

    res.json({
      conversation,
      conversations: await db.listConversations(sessionId, existing.branch_id),
    });
  }));

  router.get('/sessions/:id/context', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof req.query['branch_id'] === 'string' ? req.query['branch_id'] : undefined,
    );
    if (!branch) {
      return;
    }

    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof req.query['conversation_id'] === 'string' ? req.query['conversation_id'] : undefined,
    );
    if (!conversation) {
      return;
    }

    const [attachments, resources, conversations, snapshot, currentConversationMessages] = await Promise.all([
      db.listConversationContextAttachments(conversation.id),
      db.listContextResources(sessionId, branch.id),
      db.listConversations(sessionId, branch.id),
      db.getWorkspaceSnapshot(sessionId, branch.id, { kind: 'draft' }),
      db.getBranchMessages(sessionId, branch.id, conversation.id),
    ]);

    const selectedResourceIds = new Set(attachments.map((attachment) => attachment.resource_id).filter(Boolean));
    const selectedConversationIds = new Set(
      attachments.map((attachment) => attachment.source_conversation_id).filter(Boolean),
    );
    const selectedFilePaths = new Set(attachments.map((attachment) => attachment.path).filter(Boolean));
    const availableFilePaths = new Set<string>();
    const conversationMessageCounts = new Map<string, number>();
    if (snapshot?.active_path) {
      availableFilePaths.add(snapshot.active_path);
    }
    for (const path of selectedFilePaths) {
      availableFilePaths.add(path as string);
    }

    conversationMessageCounts.set(conversation.id, countMeaningfulConversationMessages(currentConversationMessages));
    const missingConversationStats = conversations.filter((entry) => entry.id !== conversation.id);
    await Promise.all(missingConversationStats.map(async (entry) => {
      const storedMessages = await db.getBranchMessages(sessionId, branch.id, entry.id);
      conversationMessageCounts.set(entry.id, countMeaningfulConversationMessages(storedMessages));
    }));

    const conversationById = new Map(conversations.map((entry) => [entry.id, entry] as const));
    const currentHistoryMessages = buildHistory(currentConversationMessages).filter((message) => message.role !== 'system');
    const selectedContextMessages = await buildContextMessages(db, sessionId, branch.id, conversation.id);
    const contextTokensEstimate = estimateTokenCountFromMessages(currentHistoryMessages) + estimateTokenCountFromMessages(selectedContextMessages);
    for (const attachment of attachments) {
      if (attachment.kind !== 'summary' || !attachment.resource_id) {
        continue;
      }
      const resource = resources.find((candidate) => candidate.id === attachment.resource_id);
      if (resource?.source_conversation_id) {
        selectedConversationIds.add(resource.source_conversation_id);
      }
    }
    const attachedItems = attachments.map((attachment) => {
      if (attachment.kind === 'file') {
        return {
          id: attachment.id,
          kind: attachment.kind,
          title: attachment.label,
          preview: attachment.path ?? '',
          selected: true,
          removable: true,
          ...(attachment.path ? { path: attachment.path } : {}),
        };
      }

      if ((attachment.kind === 'repo_map' || attachment.kind === 'summary') && attachment.resource_id) {
        const resource = resources.find((candidate) => candidate.id === attachment.resource_id);
        const sourceConversation = resource?.source_conversation_id
          ? conversationById.get(resource.source_conversation_id)
          : null;
        return {
          id: attachment.id,
          kind: attachment.kind,
          title: attachment.label,
          preview: resource ? createPreview(resource.content) : '',
          selected: true,
          removable: true,
          ...(attachment.resource_id ? { resource_id: attachment.resource_id } : {}),
          ...(sourceConversation ? { source_conversation_title: sourceConversation.title } : {}),
          ...(resource ? { updated_at: resource.updated_at } : {}),
        };
      }

      const sourceConversation = attachment.source_conversation_id
        ? conversationById.get(attachment.source_conversation_id)
        : null;
      return {
        id: attachment.id,
        kind: attachment.kind,
        title: attachment.label,
        preview: sourceConversation ? `From chat "${sourceConversation.title}"` : '',
        selected: true,
        removable: true,
        ...(attachment.source_conversation_id ? { source_conversation_id: attachment.source_conversation_id } : {}),
      };
    });

    const usageAttachedLabels = summarizeAttachedItems(attachments);
    const conversationMessageCount = conversationMessageCounts.get(conversation.id) ?? 0;

    res.json({
      branch,
      conversation,
      conversations,
      attachments,
      resources,
      attached_items: attachedItems,
      usage_breakdown: {
        context_usage_pct: Math.round((contextTokensEstimate / Math.max(session.constraint.context_window, 1)) * 100),
        context_tokens_estimate: contextTokensEstimate,
        context_window: session.constraint.context_window,
        conversation_messages: conversationMessageCount,
        attached_summary: usageAttachedLabels.length > 0 ? usageAttachedLabels.join(', ') : 'current chat only',
        repo_map_attached: attachments.some((attachment) => attachment.kind === 'repo_map'),
        file_count: attachments.filter((attachment) => attachment.kind === 'file').length,
        summary_count: attachments.filter((attachment) => attachment.kind === 'summary').length,
        prior_chat_count: attachments.filter((attachment) => attachment.kind === 'prior_conversation').length,
        warnings: snapshot ? [] : ['No workspace snapshot is available yet.'],
      },
      available: {
        files: [...availableFilePaths].map((path) => ({
          path,
          label: path,
          selected: selectedFilePaths.has(path),
        })),
        resources: resources.map((resource) => {
          const sourceConversation = resource.source_conversation_id
            ? conversationById.get(resource.source_conversation_id)
            : null;
          const sourceMessageCount = sourceConversation
            ? (conversationMessageCounts.get(sourceConversation.id) ?? 0)
            : 0;
          return {
            id: resource.id,
            kind: resource.kind,
            title: resource.title,
            source_conversation_id: resource.source_conversation_id ?? null,
            source_conversation_title: sourceConversation?.title ?? null,
            updated_at: resource.updated_at,
            selected: selectedResourceIds.has(resource.id),
            preview: createPreview(resource.content),
            message_count: sourceMessageCount,
            empty: sourceConversation ? sourceMessageCount === 0 : resource.content.trim().length === 0,
          };
        }),
        prior_conversations: conversations
          .filter((entry) => entry.id !== conversation.id)
          .map((entry) => {
            const summaryResource = resources
              .filter((resource) => resource.kind === 'summary' && resource.source_conversation_id === entry.id)
              .sort((left, right) => right.updated_at - left.updated_at)[0];
            const messageCount = conversationMessageCounts.get(entry.id) ?? 0;
            return {
              id: entry.id,
              title: entry.title,
              updated_at: entry.updated_at,
              selected: selectedConversationIds.has(entry.id),
              active: entry.id === conversation.id,
              message_count: messageCount,
              empty: messageCount === 0,
              has_summary: !!summaryResource,
              summary_resource_id: summaryResource?.id ?? null,
              preview: summaryResource ? createPreview(summaryResource.content) : '',
              descriptor: messageCount === 0
                ? 'empty'
                : `${messageCount} message${messageCount === 1 ? '' : 's'}${summaryResource ? ' • has summary' : ''}`,
            };
          }),
      },
    });
  }));

  router.put('/sessions/:id/conversations/:conversationId/context', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const conversationId = req.params['conversationId'] as string;
    const body = req.body as { attachments?: unknown };

    const conversation = await db.getConversation(sessionId, conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (!Array.isArray(body.attachments)) {
      res.status(400).json({ error: 'attachments must be an array' });
      return;
    }

    const normalized = body.attachments.map((entry) => {
      const candidate = entry as Record<string, unknown>;
      const kind = candidate['kind'];
      const label = candidate['label'];
      if (
        (kind !== 'file' && kind !== 'repo_map' && kind !== 'summary' && kind !== 'prior_conversation')
        || typeof label !== 'string'
      ) {
        throw new Error('Invalid attachment');
      }

      return {
        kind,
        label,
        ...(typeof candidate['path'] === 'string' ? { path: candidate['path'] } : {}),
        ...(typeof candidate['resource_id'] === 'string' ? { resource_id: candidate['resource_id'] } : {}),
        ...(typeof candidate['source_conversation_id'] === 'string'
          ? { source_conversation_id: candidate['source_conversation_id'] }
          : {}),
      } as const;
    });

    const attachments = await db.replaceConversationContextAttachments(conversationId, normalized);
    res.json({ attachments, conversation: await db.getConversation(sessionId, conversationId) });
  }));

  router.post('/sessions/:id/context/repo-map', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as { branch_id?: unknown };
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }

    const snapshot = await db.getWorkspaceSnapshot(sessionId, branch.id, { kind: 'draft' });
    const content = buildRepoMapContent(snapshot?.filesystem ?? [], snapshot?.active_path);
    const resource = await db.upsertContextResource({
      session_id: sessionId,
      branch_id: branch.id,
      kind: 'repo_map',
      title: 'Repository Map',
      content,
    });

    res.status(201).json({ resource });
  }));

  router.post('/sessions/:id/context/summary', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as { branch_id?: unknown; conversation_id?: unknown; agent_config?: unknown };
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }

    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
    );
    if (!conversation) {
      return;
    }

    const summaryAdapter = await resolveAdapter(adapter, body.agent_config);
    const ensured = await ensureSummaryResourceForConversation(db, summaryAdapter, sessionId, branch.id, conversation);
    if (!ensured.resource) {
      res.status(400).json({
        error: 'No chat content to summarize yet',
        code: 'empty_chat',
      });
      return;
    }

    res.status(201).json({
      resource: ensured.resource,
      source_conversation_title: conversation.title,
      preview: createPreview(ensured.resource.content),
      message_count: ensured.messageCount,
      empty: false,
    });
  }));

  router.put('/sessions/:id/workspace', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      branch_id?: unknown;
      kind?: unknown;
      turn_sequence?: unknown;
      label?: unknown;
      active_path?: unknown;
      workspace_section?: unknown;
      filesystem?: unknown;
      mock_pg?: unknown;
    };

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }

    const kind = parseWorkspaceKind(body.kind) ?? 'draft';
    if (!isSnapshotFileArray(body.filesystem)) {
      res.status(400).json({ error: 'filesystem must be an array of snapshot files' });
      return;
    }
    if (!isMockPgExportArray(body.mock_pg)) {
      res.status(400).json({ error: 'mock_pg must be an array' });
      return;
    }
    if (body.turn_sequence !== undefined && (typeof body.turn_sequence !== 'number' || !Number.isInteger(body.turn_sequence))) {
      res.status(400).json({ error: 'turn_sequence must be an integer when provided' });
      return;
    }
    if (body.label !== undefined && typeof body.label !== 'string') {
      res.status(400).json({ error: 'label must be a string when provided' });
      return;
    }
    if (body.active_path !== undefined && typeof body.active_path !== 'string') {
      res.status(400).json({ error: 'active_path must be a string when provided' });
      return;
    }
    if (body.workspace_section !== undefined && !parseWorkspaceSection(body.workspace_section)) {
      res.status(400).json({ error: 'workspace_section must be code, database, or curl' });
      return;
    }

    const workspaceSection = parseWorkspaceSection(body.workspace_section);
    const input = {
      session_id: sessionId,
      branch_id: branch.id,
      kind,
      ...(typeof body.turn_sequence === 'number' ? { turn_sequence: body.turn_sequence } : {}),
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
      ...(typeof body.active_path === 'string' ? { active_path: body.active_path } : {}),
      ...(workspaceSection ? { workspace_section: workspaceSection } : {}),
      filesystem: body.filesystem,
      mock_pg: body.mock_pg,
    };

    const snapshot = kind === 'draft'
      ? await db.upsertWorkspaceSnapshot(input)
      : await db.createWorkspaceSnapshot(input);

    res.json({ snapshot });
  }));

  router.get('/sessions/:id/workspace', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof req.query['branch_id'] === 'string' ? req.query['branch_id'] : undefined,
    );
    if (!branch) {
      return;
    }

    const kind = parseWorkspaceKind(req.query['kind']);
    const turnSequence =
      typeof req.query['turn_sequence'] === 'string' && req.query['turn_sequence'].trim()
        ? Number(req.query['turn_sequence'])
        : undefined;
    if (turnSequence !== undefined && !Number.isInteger(turnSequence)) {
      res.status(400).json({ error: 'turn_sequence must be an integer when provided' });
      return;
    }

    const snapshot = await db.getWorkspaceSnapshot(sessionId, branch.id, {
      ...(kind ? { kind } : {}),
      ...(turnSequence !== undefined ? { turn_sequence: turnSequence } : {}),
    });

    res.json({ snapshot, branch, branches: await db.listBranches(sessionId) });
  }));

  // POST /api/sessions/:id/rewind — soft-hide messages after a turn sequence
  router.post('/sessions/:id/rewind', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      branch_id?: unknown;
      conversation_id?: unknown;
      turn_sequence?: unknown;
    };

    if (typeof body.turn_sequence !== 'number' || !Number.isInteger(body.turn_sequence)) {
      res.status(400).json({ error: 'turn_sequence must be an integer' });
      return;
    }

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db, res, sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) return;

    const conversation = await resolveConversationOrRespond(
      db, res, sessionId, branch.id,
      typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
    );
    if (!conversation) return;

    await db.rewindMessages(sessionId, branch.id, conversation.id, body.turn_sequence);
    res.json({ ok: true });
  }));

  // POST /api/sessions/:id/prune — soft-hide messages before a turn sequence
  router.post('/sessions/:id/prune', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as { branch_id?: unknown; conversation_id?: unknown; turn_sequence?: unknown };

    if (typeof body.turn_sequence !== 'number' || !Number.isInteger(body.turn_sequence) || body.turn_sequence < 1) {
      res.status(400).json({ error: 'turn_sequence must be a positive integer' });
      return;
    }

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }

    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
    );
    if (!conversation) {
      return;
    }

    await db.pruneMessagesBeforeTurnSequence(sessionId, branch.id, conversation.id, body.turn_sequence);
    res.json({ ok: true });
  }));

  router.post('/sessions/:id/checkpoints', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      branch_id?: unknown;
      label?: unknown;
      turn_sequence?: unknown;
    };

    if (typeof body.label !== 'string' || !body.label.trim()) {
      res.status(400).json({ error: 'label is required' });
      return;
    }

    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }

    const draft = await db.getWorkspaceSnapshot(sessionId, branch.id, { kind: 'draft' });
    if (!draft) {
      res.status(404).json({ error: 'No draft workspace snapshot found for this branch' });
      return;
    }

    if (body.turn_sequence !== undefined && (typeof body.turn_sequence !== 'number' || !Number.isInteger(body.turn_sequence))) {
      res.status(400).json({ error: 'turn_sequence must be an integer when provided' });
      return;
    }

    const checkpointInput = {
      session_id: sessionId,
      branch_id: branch.id,
      kind: 'checkpoint' as const,
      ...(
        typeof body.turn_sequence === 'number'
          ? { turn_sequence: body.turn_sequence }
          : draft.turn_sequence !== undefined
            ? { turn_sequence: draft.turn_sequence }
            : {}
      ),
      label: body.label.trim(),
      ...(draft.active_path ? { active_path: draft.active_path } : {}),
      ...(draft.workspace_section ? { workspace_section: draft.workspace_section } : {}),
      filesystem: draft.filesystem,
      mock_pg: draft.mock_pg,
    };
    const snapshot = await db.createWorkspaceSnapshot(checkpointInput);

    res.status(201).json({ snapshot });
  }));

  // POST /api/sessions/:id/messages — single LLM call; stores tool_calls in DB if stop_reason='tool_use'
  router.post('/sessions/:id/messages', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      message?: unknown;
      agent_config?: unknown;
      mode?: unknown;
      branch_id?: unknown;
      conversation_id?: unknown;
    };

    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }
    const message = body.message;

    const session = await resolveSessionWithExpiry(db, sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'active') {
      res.status(409).json({ error: session.status === 'expired' ? 'Session has expired' : 'Session is not active' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }
    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
    );
    if (!conversation) {
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

    const mode: AgentRequestMode = isAgentRequestMode(body.mode) ? body.mode : 'build';
    const planFilePath = mode === 'plan' ? generatePlanFilePath() : undefined;
    const turnSequence = await db.allocateTurnSequence(sessionId);
    const storedMessages = await db.getBranchMessages(sessionId, branch.id, conversation.id);
    const contextMessages = await buildContextMessages(db, sessionId, branch.id, conversation.id);
    const history: Message[] = createRequestHistory(storedMessages, mode, planFilePath, contextMessages);

    const constraints_remaining: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, session.constraint.max_session_tokens - session.tokens_used),
      interactions_remaining: Math.max(0, session.constraint.max_interactions - session.interactions_used),
      seconds_remaining: Math.max(0, timeLimitSeconds - elapsed),
    };

    const context: SessionContext = { session_id: sessionId, history, constraints_remaining };

    // Persist the user turn before calling the provider so it remains visible if the
    // adapter fails after the request has already been accepted.
    const titledConversation = await maybeRetitleConversationFromMessage(db, conversation, sessionId, branch.id, message);
    await db.addBranchMessage(sessionId, branch.id, turnSequence, 'user', message, 0, titledConversation.id);
    await db.addBranchReplayEvent(
      sessionId,
      branch.id,
      turnSequence,
      'message',
      Date.now(),
      { role: 'user', content: message },
      titledConversation.id,
    );

    const reqAdapter = await resolveAdapter(adapter, body.agent_config);

    let agentResponse;
    try {
      agentResponse = await reqAdapter.sendMessage(message, context);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown adapter error';
      await db.addBranchReplayEvent(sessionId, branch.id, turnSequence, 'agent_response', Date.now(), {
        content: null,
        stop_reason: 'error',
        error: errMsg,
      }, titledConversation.id);
      res.status(502).json({ error: `Agent adapter error: ${errMsg}` });
      return;
    }

    // Persist assistant message — encode tool_calls as JSON when stop_reason='tool_use'
    const assistantContent = encodeAssistantMessage({
      content: agentResponse.content,
      ...(agentResponse.stop_reason === 'tool_use' && agentResponse.tool_calls
        ? { tool_calls: agentResponse.tool_calls }
        : {}),
      ...(agentResponse.thinking !== undefined ? { thinking: agentResponse.thinking } : {}),
      ...(agentResponse.thinking_blocks ? { thinking_blocks: agentResponse.thinking_blocks } : {}),
    });
    await db.addBranchMessage(
      sessionId,
      branch.id,
      turnSequence,
      'assistant',
      assistantContent,
      agentResponse.usage.completion_tokens,
      titledConversation.id,
    );

    // Update usage counters (+1 interaction for the initial user message)
    await db.updateSessionUsage(sessionId, agentResponse.usage.total_tokens, 1);

    // Record replay events
    const now = Date.now();
    await db.addBranchReplayEvent(
      sessionId,
      branch.id,
      turnSequence,
      'agent_response',
      now,
      {
        content: agentResponse.content,
        thinking: agentResponse.thinking ?? null,
        stop_reason: agentResponse.stop_reason,
        usage: agentResponse.usage,
      },
      titledConversation.id,
    );
    await db.addBranchReplayEvent(
      sessionId,
      branch.id,
      turnSequence,
      'resource_usage',
      now,
      {
        prompt_tokens: agentResponse.usage.prompt_tokens,
        completion_tokens: agentResponse.usage.completion_tokens,
        total_tokens: agentResponse.usage.total_tokens,
      },
      titledConversation.id,
    );

    const updatedConstraints: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, constraints_remaining.tokens_remaining - agentResponse.usage.total_tokens),
      interactions_remaining: Math.max(0, constraints_remaining.interactions_remaining - 1),
      seconds_remaining: constraints_remaining.seconds_remaining,
    };

    res.json({
      content: agentResponse.content,
      thinking: agentResponse.thinking ?? null,
      stop_reason: agentResponse.stop_reason,
      tool_calls: agentResponse.tool_calls ?? [],
      usage: agentResponse.usage,
      constraints_remaining: updatedConstraints,
      branch_id: branch.id,
      conversation_id: titledConversation.id,
      turn_sequence: turnSequence,
    });
  }));

  // POST /api/sessions/:id/tool-results — round-trip continuation: store tool results and make one LLM call
  router.post('/sessions/:id/tool-results', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      tool_results?: unknown;
      agent_config?: unknown;
      mode?: unknown;
      branch_id?: unknown;
      conversation_id?: unknown;
      turn_sequence?: unknown;
    };

    if (!Array.isArray(body.tool_results)) {
      res.status(400).json({ error: 'tool_results must be a non-empty array' });
      return;
    }

    const session = await resolveSessionWithExpiry(db, sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'active') {
      res.status(409).json({ error: session.status === 'expired' ? 'Session has expired' : 'Session is not active' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof body.branch_id === 'string' ? body.branch_id : undefined,
    );
    if (!branch) {
      return;
    }
    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
    );
    if (!conversation) {
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
    const turnSequence = typeof body.turn_sequence === 'number' && Number.isInteger(body.turn_sequence)
      ? body.turn_sequence
      : await resolveContinuationTurnSequence(db, sessionId, branch.id, conversation.id);

    // Persist tool results
    await db.addBranchMessage(
      sessionId,
      branch.id,
      turnSequence,
      'tool',
      JSON.stringify(toolResults),
      0,
      conversation.id,
    );

    // Rebuild history (now includes the tool results we just stored)
    const mode: AgentRequestMode = isAgentRequestMode(body.mode) ? body.mode : 'build';
    const storedMessages = await db.getBranchMessages(sessionId, branch.id, conversation.id);
    const contextMessages = await buildContextMessages(db, sessionId, branch.id, conversation.id);
    const history: Message[] = createRequestHistory(storedMessages, mode, undefined, contextMessages);

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
      await db.addBranchReplayEvent(sessionId, branch.id, turnSequence, 'agent_response', Date.now(), {
        content: null,
        stop_reason: 'error',
        error: errMsg,
      }, conversation.id);
      res.status(502).json({ error: `Agent adapter error: ${errMsg}` });
      return;
    }

    // Persist assistant response
    const assistantContent = encodeAssistantMessage({
      content: agentResponse.content,
      ...(agentResponse.stop_reason === 'tool_use' && agentResponse.tool_calls
        ? { tool_calls: agentResponse.tool_calls }
        : {}),
      ...(agentResponse.thinking !== undefined ? { thinking: agentResponse.thinking } : {}),
      ...(agentResponse.thinking_blocks ? { thinking_blocks: agentResponse.thinking_blocks } : {}),
    });
    await db.addBranchMessage(
      sessionId,
      branch.id,
      turnSequence,
      'assistant',
      assistantContent,
      agentResponse.usage.completion_tokens,
      conversation.id,
    );

    // Tool-results continuations count tokens but NOT an additional interaction
    await db.updateSessionUsage(sessionId, agentResponse.usage.total_tokens, 0);

    // Record replay events
    const now = Date.now();
    await db.addBranchReplayEvent(
      sessionId,
      branch.id,
      turnSequence,
      'tool_result',
      now,
      { tool_results: toolResults },
      conversation.id,
    );
    await db.addBranchReplayEvent(
      sessionId,
      branch.id,
      turnSequence,
      'agent_response',
      now,
      {
        content: agentResponse.content,
        thinking: agentResponse.thinking ?? null,
        stop_reason: agentResponse.stop_reason,
        usage: agentResponse.usage,
      },
      conversation.id,
    );
    await db.addBranchReplayEvent(
      sessionId,
      branch.id,
      turnSequence,
      'resource_usage',
      now,
      {
        prompt_tokens: agentResponse.usage.prompt_tokens,
        completion_tokens: agentResponse.usage.completion_tokens,
        total_tokens: agentResponse.usage.total_tokens,
      },
      conversation.id,
    );

    const updatedConstraints: ConstraintsRemaining = {
      tokens_remaining: Math.max(0, constraints_remaining.tokens_remaining - agentResponse.usage.total_tokens),
      interactions_remaining: constraints_remaining.interactions_remaining,
      seconds_remaining: constraints_remaining.seconds_remaining,
    };

    res.json({
      content: agentResponse.content,
      thinking: agentResponse.thinking ?? null,
      stop_reason: agentResponse.stop_reason,
      tool_calls: agentResponse.tool_calls ?? [],
      usage: agentResponse.usage,
      constraints_remaining: updatedConstraints,
      branch_id: branch.id,
      conversation_id: conversation.id,
      turn_sequence: turnSequence,
    });
  }));

  // POST /api/sessions/:id/messages/stream — SSE agent loop (wires runAgentLoop server-side)
  router.post('/sessions/:id/messages/stream', requireToken(db), (req, res) => {
    const sessionId = req.params['id'] as string;
    const body = req.body as {
      message?: unknown;
      agent_config?: unknown;
      mode?: unknown;
      branch_id?: unknown;
      conversation_id?: unknown;
    };

    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }
    const message = body.message;
    const mode: AgentRequestMode = isAgentRequestMode(body.mode) ? body.mode : 'build';
    const planFilePath = mode === 'plan' ? generatePlanFilePath() : undefined;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    void (async () => {
      try {
        const session = await resolveSessionWithExpiry(db, sessionId);
        if (!session) { sendEvent('error', { error: 'Session not found' }); res.end(); return; }
        if (session.status !== 'active') {
          sendEvent('error', { error: session.status === 'expired' ? 'Session has expired' : 'Session is not active' });
          res.end();
          return;
        }

        const branch = await resolveBranchOrRespond(
          db,
          res,
          sessionId,
          typeof body.branch_id === 'string' ? body.branch_id : undefined,
        );
        if (!branch) {
          sendEvent('error', { error: 'Branch not found' });
          res.end();
          return;
        }
        const conversation = await resolveConversationOrRespond(
          db,
          res,
          sessionId,
          branch.id,
          typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
        );
        if (!conversation) {
          sendEvent('error', { error: 'Conversation not found' });
          res.end();
          return;
        }

        const elapsed = (Date.now() - session.created_at) / 1000;
        const timeLimitSeconds = session.constraint.time_limit_minutes * 60;
        if (
          session.tokens_used >= session.constraint.max_session_tokens ||
          session.interactions_used >= session.constraint.max_interactions ||
          elapsed >= timeLimitSeconds
        ) { sendEvent('error', { error: 'Session constraints exhausted' }); res.end(); return; }

        const turnSequence = await db.allocateTurnSequence(sessionId);
        const storedMessages = await db.getBranchMessages(sessionId, branch.id, conversation.id);
        const contextMessages = await buildContextMessages(db, sessionId, branch.id, conversation.id);
        const history = createRequestHistory(storedMessages, mode, planFilePath, contextMessages);
        const constraints_remaining: ConstraintsRemaining = {
          tokens_remaining: Math.max(0, session.constraint.max_session_tokens - session.tokens_used),
          interactions_remaining: Math.max(0, session.constraint.max_interactions - session.interactions_used),
          seconds_remaining: Math.max(0, timeLimitSeconds - elapsed),
        };
        const context: SessionContext = { session_id: sessionId, history, constraints_remaining };

        // Persist the user turn before entering the loop so it survives provider/tool failures.
        const titledConversation = await maybeRetitleConversationFromMessage(db, conversation, sessionId, branch.id, message);
        await db.addBranchMessage(sessionId, branch.id, turnSequence, 'user', message, 0, titledConversation.id);
        await db.addBranchReplayEvent(
          sessionId,
          branch.id,
          turnSequence,
          'message',
          Date.now(),
          {
            role: 'user',
            content: message,
          },
          titledConversation.id,
        );

        const reqAdapter = await resolveAdapter(adapter, body.agent_config);

        const toolRunner: ToolRunner = (calls, description, thinking) => {
          const requestId = randomUUID();
          sendEvent('tool_calls', {
            request_id: requestId,
            description,
            thinking,
            tool_calls: calls,
            branch_id: branch.id,
            conversation_id: titledConversation.id,
            turn_sequence: turnSequence,
          });
          return new Promise<ToolResult[]>((resolve) => registerPendingTools(requestId, resolve));
        };

        let loopResult;
        try {
          loopResult = await runAgentLoop(message, context, reqAdapter, toolRunner);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Agent loop error';
          await db.addBranchReplayEvent(sessionId, branch.id, turnSequence, 'agent_response', Date.now(), {
            content: null,
            stop_reason: 'error',
            error: errMsg,
          }, titledConversation.id);
          sendEvent('error', { error: errMsg });
          res.end();
          return;
        }

        // Persist each tool round-trip
        for (const action of loopResult.tool_actions) {
          const encoded = encodeAssistantMessage({
            content: action.description,
            tool_calls: action.tool_calls,
            thinking: action.thinking,
          });
          await db.addBranchMessage(sessionId, branch.id, turnSequence, 'assistant', encoded, 0, titledConversation.id);
          await db.addBranchMessage(sessionId, branch.id, turnSequence, 'tool', JSON.stringify(action.tool_results), 0, titledConversation.id);
        }

        // Persist final assistant message
        await db.addBranchMessage(
          sessionId,
          branch.id,
          turnSequence,
          'assistant',
          encodeAssistantMessage({
            content: loopResult.content,
            thinking: loopResult.thinking,
          }),
          loopResult.total_usage.completion_tokens,
          titledConversation.id,
        );

        // 1 interaction for the full agent turn; all LLM calls' tokens aggregated
        await db.updateSessionUsage(sessionId, loopResult.total_usage.total_tokens, 1);

        // Record replay events
        const now = Date.now();
        for (const action of loopResult.tool_actions) {
          await db.addBranchReplayEvent(sessionId, branch.id, turnSequence, 'tool_call', now, {
            description: action.description,
            thinking: action.thinking,
            tool_calls: action.tool_calls,
          }, titledConversation.id);
          await db.addBranchReplayEvent(sessionId, branch.id, turnSequence, 'tool_result', now, {
            tool_results: action.tool_results,
          }, titledConversation.id);
        }
        await db.addBranchReplayEvent(sessionId, branch.id, turnSequence, 'agent_response', now, {
          content: loopResult.content,
          thinking: loopResult.thinking,
          stop_reason: loopResult.stop_reason,
          usage: loopResult.total_usage,
        }, titledConversation.id);
        await db.addBranchReplayEvent(sessionId, branch.id, turnSequence, 'resource_usage', now, loopResult.total_usage, titledConversation.id);

        const updatedConstraints: ConstraintsRemaining = {
          tokens_remaining: Math.max(0, constraints_remaining.tokens_remaining - loopResult.total_usage.total_tokens),
          interactions_remaining: Math.max(0, constraints_remaining.interactions_remaining - 1),
          seconds_remaining: constraints_remaining.seconds_remaining,
        };

        sendEvent('done', {
          content: loopResult.content,
          thinking: loopResult.thinking,
          stop_reason: loopResult.stop_reason,
          tool_actions: loopResult.tool_actions,
          usage: loopResult.total_usage,
          constraints_remaining: updatedConstraints,
          branch_id: branch.id,
          conversation_id: titledConversation.id,
          turn_sequence: turnSequence,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        await recordAgentError(db, sessionId, errMsg);
        sendEvent('error', { error: errMsg });
      } finally {
        res.end();
      }
    })();
  });

  // POST /api/sessions/:id/tool-results/:requestId — deliver WebContainer tool results to waiting SSE loop
  router.post('/sessions/:id/tool-results/:requestId', requireToken(db), (req, res) => {
    const requestId = req.params['requestId'] as string;
    const body = req.body as { tool_results?: unknown };

    if (!Array.isArray(body.tool_results)) {
      res.status(400).json({ error: 'tool_results must be an array' });
      return;
    }

    const resolver = pendingToolResults.get(requestId);
    if (!resolver) {
      res.status(404).json({ error: 'No pending tool request with that ID' });
      return;
    }

    pendingToolResults.delete(requestId);
    resolver(body.tool_results as ToolResult[]);
    res.json({ ok: true });
  });

  // GET /api/sessions/:id/messages — full conversation history
  router.get('/sessions/:id/messages', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof req.query['branch_id'] === 'string' ? req.query['branch_id'] : undefined,
    );
    if (!branch) {
      return;
    }

    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof req.query['conversation_id'] === 'string' ? req.query['conversation_id'] : undefined,
    );
    if (!conversation) {
      return;
    }

    const messages = await db.getBranchMessages(sessionId, branch.id, conversation.id);
    res.json({
      messages,
      branch,
      branches: await db.listBranches(sessionId),
      conversation,
      conversations: await db.listConversations(sessionId, branch.id),
      active_conversation_id: conversation.id,
    });
  }));

  // GET /api/sessions/:id/replay — session recording for review
  router.get('/sessions/:id/replay', requireToken(db), asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof req.query['branch_id'] === 'string' ? req.query['branch_id'] : undefined,
    );
    if (!branch) {
      return;
    }

    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof req.query['conversation_id'] === 'string' ? req.query['conversation_id'] : undefined,
    );
    if (!conversation) {
      return;
    }

    const stored = await db.getBranchReplayEvents(sessionId, branch.id, conversation.id);
    const recording = {
      session_id: sessionId,
      branch_id: branch.id,
      conversation_id: conversation.id,
      events: stored.map((e) => ({ type: e.type, timestamp: e.timestamp, payload: e.payload })),
    };

    res.json({ ...recording, branch, branches: await db.listBranches(sessionId), conversation });
  }));

  // GET /api/review/:id — aggregate review data for replay dashboard
  router.get('/review/:id', asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const branch = await resolveBranchOrRespond(
      db,
      res,
      sessionId,
      typeof req.query['branch_id'] === 'string' ? req.query['branch_id'] : undefined,
    );
    if (!branch) {
      return;
    }

    const conversation = await resolveConversationOrRespond(
      db,
      res,
      sessionId,
      branch.id,
      typeof req.query['conversation_id'] === 'string' ? req.query['conversation_id'] : undefined,
    );
    if (!conversation) {
      return;
    }

    // Fetch all messages for the branch (no conversation filter) so the review
    // shows the complete history regardless of how many conversations exist.
    const allStoredMessages = await db.getBranchMessages(sessionId, branch.id, undefined, { includeRewound: true });
    const storedMessages = allStoredMessages.filter((m) => m.rewound_at === null);
    const messages = buildHistory(storedMessages);
    const rawMessages = allStoredMessages.map((m) => ({
      id: m.id,
      turn_sequence: m.turn_sequence,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      rewound_at: m.rewound_at,
    }));
    const storedEvents = await db.getBranchReplayEvents(sessionId, branch.id, undefined);
    const workspaceSnapshot = await db.getWorkspaceSnapshot(sessionId, branch.id);
    const recording = {
      session_id: sessionId,
      branch_id: branch.id,
      events: storedEvents.map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
        payload: event.payload,
      })),
    };
    const metrics = computeSessionMetrics({ session, messages, recording });
    const prompt = await db.getPrompt(session.prompt_id);
    const evaluation = await db.getSessionEvaluation(sessionId);

    res.json({
      session,
      messages,
      raw_messages: rawMessages,
      metrics,
      recording,
      prompt,
      evaluation,
      branch,
      branches: await db.listBranches(sessionId),
      conversation,
      workspace_snapshot: workspaceSnapshot,
    });
  }));

  // POST /api/sessions/:id/evaluate — run LLM evaluation and compute infra metrics (no session auth required, matches /review/:id)
  router.post('/sessions/:id/evaluate', asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!config.evaluation) {
      res.status(422).json({ error: 'No evaluation config found in lintic.yml — add an evaluation block to enable LLM scoring' });
      return;
    }

    const existingEvaluation = await db.getSessionEvaluation(sessionId);
    if (existingEvaluation) {
      res.json(existingEvaluation);
      return;
    }

    const branch = await db.getMainBranch(sessionId);
    if (!branch) {
      res.status(404).json({ error: 'Session branch not found' });
      return;
    }

    // Load all messages including rewound to build the iteration graph
    const allMessages = await db.getBranchMessages(sessionId, branch.id, undefined, { includeRewound: true });
    const iterations = buildIterations(allMessages);

    // Extract Redis stats from replay events
    const replayEvents = await db.getBranchReplayEvents(sessionId, branch.id);
    const redisStats = extractRedisStats(replayEvents);

    // Load workspace snapshot for Postgres stats (prefer checkpoint, fall back to turn)
    const snapshot =
      await db.getWorkspaceSnapshot(sessionId, branch.id, { kind: 'checkpoint' })
      ?? await db.getWorkspaceSnapshot(sessionId, branch.id, { kind: 'turn' })
      ?? null;
    const pgStats = aggregatePostgresStats(snapshot?.mock_pg ?? []);
    const infrastructure = computeInfrastructureMetrics(redisStats, pgStats);

    // Truncate history for evaluator context window
    const maxHistory = config.evaluation.max_history_messages ?? 50;
    const historyForEval = truncateHistory(allMessages, maxHistory)
      .flatMap((m) => (m.content === null ? [] : [{ role: m.role, content: m.content }]));

    const promptConfig = await db.getPrompt(session.prompt_id);

    const llm_evaluation = await evaluateSession({
      session,
      iterations,
      infrastructure,
      truncatedHistory: historyForEval,
      evaluationConfig: config.evaluation,
      ...(promptConfig?.acceptance_criteria ? { acceptanceCriteria: promptConfig.acceptance_criteria } : {}),
      ...(promptConfig?.rubric ? { customRubricQuestions: promptConfig.rubric } : {}),
    });

    const result: EvaluationResult = { infrastructure, llm_evaluation, iterations };
    const score = computeSessionAnalysisScore(result);
    const persisted = await db.upsertSessionEvaluation(sessionId, result, score);
    res.json(persisted);
  }));

  // POST /api/sessions/:id/ask — answer a reviewer question about the session using the evaluator LLM
  router.post('/sessions/:id/ask', asyncRoute(async (req, res) => {
    const sessionId = req.params['id'] as string;
    const session = await db.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!config.evaluation) {
      res.status(422).json({ error: 'No evaluation config found in lintic.yml' });
      return;
    }

    const body = req.body as { question?: unknown };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) {
      res.status(400).json({ error: 'question is required' });
      return;
    }

    const branch = await db.getMainBranch(sessionId);
    if (!branch) {
      res.status(404).json({ error: 'Session branch not found' });
      return;
    }

    const maxHistory = config.evaluation.max_history_messages ?? 50;
    const allMessages = await db.getBranchMessages(sessionId, branch.id, undefined, { includeRewound: false });
    const historyForContext = truncateHistory(allMessages, maxHistory)
      .flatMap((m) => (m.content === null ? [] : [{ role: m.role, content: m.content }]));

    const historyText = historyForContext
      .map((m) => {
        const role = m.role === 'user' ? 'Candidate' : m.role === 'assistant' ? 'Agent' : m.role;
        const text = (m.content?.length ?? 0) > 800 ? m.content.slice(0, 800) + '…' : m.content;
        return `[${role}]: ${text}`;
      })
      .join('\n\n');

    const answer = await askAboutSession({
      candidateEmail: session.candidate_email,
      promptId: session.prompt_id,
      tokensUsed: session.tokens_used,
      maxTokens: session.constraint.max_session_tokens,
      interactionsUsed: session.interactions_used,
      maxInteractions: session.constraint.max_interactions,
      historyText,
      question,
      evaluationConfig: config.evaluation,
    });

    res.json({ answer });
  }));

  // POST /api/sessions/:id/close — mark session as completed
  router.post('/sessions/:id/close', requireToken(db), asyncRoute(async (req, res) => {
    const session = await resolveSessionWithExpiry(db, req.params['id'] as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session.status === 'expired') {
      res.json({ status: 'expired' });
      return;
    }

    await db.closeSession(req.params['id'] as string, 'completed');
    res.json({ status: 'completed' });
  }));

  return router;
}
