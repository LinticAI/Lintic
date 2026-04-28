import type {
  AssessmentLinkRecord,
  ContextAttachment,
  ContextAttachmentKind,
  ContextResource,
  ContextResourceKind,
  ConversationSummary,
  EvaluationResult,
  SessionComparisonAnalysis,
  SessionEvaluation,
  SessionReviewState,
  SessionReviewStatus,
  MockPgPoolExport,
  Session,
  SessionBranch,
  SessionStatus,
  Constraint,
  SnapshotFile,
  WorkspaceSection,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from '../types.js';
import type { PromptConfig, PromptRubricQuestion } from '../config.js';
import type {
  AssessmentLinkRow,
  ContextAttachmentRow,
  ContextResourceRow,
  ConversationRow,
  PromptRow,
  SessionComparisonAnalysisRow,
  SessionEvaluationRow,
  SessionReviewStateRow,
  SessionBranchRow,
  SessionRow,
  WorkspaceSnapshotRow,
} from './rows.js';

export function normalizeSessionRow(row: SessionRow): SessionRow {
  return {
    ...row,
    created_at: Number(row.created_at),
    closed_at: row.closed_at === null ? null : Number(row.closed_at),
    archived_at:
      row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
    max_session_tokens: Number(row.max_session_tokens),
    max_message_tokens: Number(row.max_message_tokens),
    max_interactions: Number(row.max_interactions),
    context_window: Number(row.context_window),
    time_limit_minutes: Number(row.time_limit_minutes),
    tokens_used: Number(row.tokens_used),
    interactions_used: Number(row.interactions_used),
    score: row.score === null ? null : Number(row.score),
  };
}

export function normalizeAssessmentLinkRow(row: AssessmentLinkRow): AssessmentLinkRow {
  return {
    ...row,
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    consumed_at: row.consumed_at === null || row.consumed_at === undefined ? null : Number(row.consumed_at),
  };
}

export function normalizeSessionEvaluationRow(row: SessionEvaluationRow): SessionEvaluationRow {
  return {
    ...row,
    score: Number(row.score),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function normalizeSessionReviewStateRow(row: SessionReviewStateRow): SessionReviewStateRow {
  return {
    ...row,
    first_viewed_at: row.first_viewed_at === null ? null : Number(row.first_viewed_at),
    last_viewed_at: row.last_viewed_at === null ? null : Number(row.last_viewed_at),
    passed_at: row.passed_at === null ? null : Number(row.passed_at),
    updated_at: Number(row.updated_at),
  };
}

export function normalizeSessionComparisonAnalysisRow(
  row: SessionComparisonAnalysisRow,
): SessionComparisonAnalysisRow {
  return {
    ...row,
    comparison_score: Number(row.comparison_score),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function normalizeSessionBranchRow(row: SessionBranchRow): SessionBranchRow {
  return {
    ...row,
    forked_from_sequence:
      row.forked_from_sequence === null || row.forked_from_sequence === undefined
        ? null
        : Number(row.forked_from_sequence),
    created_at: Number(row.created_at),
  };
}

export function normalizeConversationRow(row: ConversationRow): ConversationRow {
  return {
    ...row,
    archived: typeof row.archived === 'boolean' ? row.archived : Number(row.archived),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function normalizeContextAttachmentRow(row: ContextAttachmentRow): ContextAttachmentRow {
  return {
    ...row,
    created_at: Number(row.created_at),
  };
}

export function normalizeContextResourceRow(row: ContextResourceRow): ContextResourceRow {
  return {
    ...row,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function normalizeWorkspaceSnapshotRow(row: WorkspaceSnapshotRow): WorkspaceSnapshotRow {
  return {
    ...row,
    turn_sequence:
      row.turn_sequence === null || row.turn_sequence === undefined ? null : Number(row.turn_sequence),
    created_at: Number(row.created_at),
  };
}

export function rowToSession(row: SessionRow): Session {
  const constraint: Constraint = {
    max_session_tokens: row.max_session_tokens,
    max_message_tokens: row.max_message_tokens,
    max_interactions: row.max_interactions,
    context_window: row.context_window,
    time_limit_minutes: row.time_limit_minutes,
  };

  const session: Session = {
    id: row.id,
    prompt_id: row.prompt_id,
    candidate_email: row.candidate_email,
    status: row.status as SessionStatus,
    created_at: row.created_at,
    constraint,
    tokens_used: row.tokens_used,
    interactions_used: row.interactions_used,
  };

  if (row.closed_at !== null) {
    session.closed_at = row.closed_at;
  }
  if (row.archived_at !== null) {
    session.archived_at = row.archived_at;
  }
  if (row.score !== null) {
    session.score = row.score;
  }

  return session;
}

export function rowToSessionEvaluation(row: SessionEvaluationRow): SessionEvaluation {
  return {
    session_id: row.session_id,
    score: Number(row.score),
    result: JSON.parse(row.result_json) as EvaluationResult,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function rowToSessionReviewState(row: SessionReviewStateRow): SessionReviewState {
  const state: SessionReviewState = {
    session_id: row.session_id,
    status: row.status as SessionReviewStatus,
    updated_at: Number(row.updated_at),
  };
  if (row.first_viewed_at !== null) state.first_viewed_at = Number(row.first_viewed_at);
  if (row.last_viewed_at !== null) state.last_viewed_at = Number(row.last_viewed_at);
  if (row.passed_at !== null) state.passed_at = Number(row.passed_at);
  return state;
}

export function rowToSessionComparisonAnalysis(
  row: SessionComparisonAnalysisRow,
): SessionComparisonAnalysis {
  return {
    session_id: row.session_id,
    prompt_id: row.prompt_id,
    schema_version: row.schema_version,
    comparison_score: Number(row.comparison_score),
    recommendation: row.recommendation,
    strengths: JSON.parse(row.strengths_json) as string[],
    risks: JSON.parse(row.risks_json) as string[],
    summary: row.summary,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function rowToSessionBranch(row: SessionBranchRow): SessionBranch {
  const branch: SessionBranch = {
    id: row.id,
    session_id: row.session_id,
    name: row.name,
    created_at: row.created_at,
  };

  if (row.parent_branch_id) {
    branch.parent_branch_id = row.parent_branch_id;
  }

  if (row.forked_from_sequence !== null && row.forked_from_sequence !== undefined) {
    branch.forked_from_sequence = row.forked_from_sequence;
  }

  return branch;
}

export function rowToConversation(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    session_id: row.session_id,
    branch_id: row.branch_id,
    title: row.title,
    archived: Boolean(row.archived),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function rowToContextAttachment(row: ContextAttachmentRow): ContextAttachment {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    kind: row.kind as ContextAttachmentKind,
    label: row.label,
    created_at: Number(row.created_at),
    ...(row.path ? { path: row.path } : {}),
    ...(row.resource_id ? { resource_id: row.resource_id } : {}),
    ...(row.source_conversation_id ? { source_conversation_id: row.source_conversation_id } : {}),
  };
}

export function rowToContextResource(row: ContextResourceRow): ContextResource {
  return {
    id: row.id,
    session_id: row.session_id,
    branch_id: row.branch_id,
    kind: row.kind as ContextResourceKind,
    title: row.title,
    content: row.content,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    ...(row.source_conversation_id ? { source_conversation_id: row.source_conversation_id } : {}),
  };
}

export function rowToWorkspaceSnapshot(row: WorkspaceSnapshotRow): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = {
    id: row.id,
    session_id: row.session_id,
    branch_id: row.branch_id,
    kind: row.kind as WorkspaceSnapshotKind,
    created_at: row.created_at,
    filesystem: JSON.parse(row.filesystem_json) as SnapshotFile[],
    mock_pg: JSON.parse(row.mock_pg_json) as MockPgPoolExport[],
  };

  if (row.turn_sequence !== null && row.turn_sequence !== undefined) {
    snapshot.turn_sequence = row.turn_sequence;
  }

  if (row.label) {
    snapshot.label = row.label;
  }

  if (row.active_path) {
    snapshot.active_path = row.active_path;
  }

  if (row.workspace_section) {
    snapshot.workspace_section = row.workspace_section as WorkspaceSection;
  }

  return snapshot;
}

export function rowToPromptConfig(row: PromptRow): PromptConfig {
  const prompt: PromptConfig = {
    id: row.id,
    title: row.title,
  };

  if (row.description) prompt.description = row.description;
  if (row.difficulty) prompt.difficulty = row.difficulty;

  const tags = JSON.parse(row.tags_json) as string[];
  if (tags.length > 0) prompt.tags = tags;

  const acceptance_criteria = JSON.parse(row.acceptance_criteria_json) as string[];
  if (acceptance_criteria.length > 0) prompt.acceptance_criteria = acceptance_criteria;

  const rubric = JSON.parse(row.rubric_json) as PromptRubricQuestion[];
  if (rubric.length > 0) prompt.rubric = rubric;

  return prompt;
}

export function rowToAssessmentLink(row: AssessmentLinkRow): AssessmentLinkRecord {
  const link: AssessmentLinkRecord = {
    id: row.id,
    token: row.token,
    url: row.url,
    prompt_id: row.prompt_id,
    candidate_email: row.candidate_email,
    created_at: row.created_at,
    expires_at: row.expires_at,
    constraint: JSON.parse(row.constraint_json) as Constraint,
  };

  if (row.consumed_session_id) {
    link.consumed_session_id = row.consumed_session_id;
  }
  if (row.consumed_at !== null && row.consumed_at !== undefined) {
    link.consumed_at = row.consumed_at;
  }

  return link;
}
