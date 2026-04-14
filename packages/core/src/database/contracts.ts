import type {
  AssessmentLinkRecord,
  ContextAttachment,
  ContextAttachmentKind,
  ContextResource,
  ContextResourceKind,
  ConversationSummary,
  MockPgPoolExport,
  Session,
  SessionBranch,
  SessionStatus,
  Constraint,
  MessageRole,
  ReplayEventType,
  SnapshotFile,
  WorkspaceSection,
  WorkspaceSnapshot,
  WorkspaceSnapshotKind,
} from '../types.js';

export interface StoredMessage {
  id: number;
  session_id: string;
  branch_id: string;
  conversation_id: string;
  turn_sequence: number | null;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: number;
  rewound_at: number | null;
}

export interface StoredReplayEvent {
  id: number;
  session_id: string;
  branch_id: string;
  conversation_id: string;
  turn_sequence: number | null;
  type: ReplayEventType;
  timestamp: number;
  payload: unknown;
}

export interface CreateBranchConfig {
  session_id: string;
  name: string;
  parent_branch_id: string;
  forked_from_sequence: number;
  conversation_id?: string;
}

export interface CreateConversationConfig {
  session_id: string;
  branch_id: string;
  title?: string;
  archived?: boolean;
}

export interface UpdateConversationConfig {
  session_id: string;
  conversation_id: string;
  title?: string;
  archived?: boolean;
}

export interface ContextAttachmentInput {
  kind: ContextAttachmentKind;
  label: string;
  path?: string;
  resource_id?: string;
  source_conversation_id?: string;
}

export interface ContextResourceInput {
  session_id: string;
  branch_id: string;
  kind: ContextResourceKind;
  title: string;
  content: string;
  source_conversation_id?: string;
}

export interface WorkspaceSnapshotInput {
  session_id: string;
  branch_id: string;
  kind: WorkspaceSnapshotKind;
  turn_sequence?: number;
  label?: string;
  created_at?: number;
  active_path?: string;
  workspace_section?: WorkspaceSection;
  filesystem: SnapshotFile[];
  mock_pg: MockPgPoolExport[];
}

export interface CreateSessionConfig {
  prompt_id: string;
  candidate_email: string;
  constraint: Constraint;
}

export interface CreateAssessmentLinkConfig {
  id: string;
  token: string;
  url: string;
  prompt_id: string;
  candidate_email: string;
  created_at: number;
  expires_at: number;
  constraint: Constraint;
}

export interface DatabaseAdapter {
  createSession(config: CreateSessionConfig): Promise<{ id: string; token: string }>;
  createAssessmentLink(config: CreateAssessmentLinkConfig): Promise<AssessmentLinkRecord>;
  getSession(id: string): Promise<Session | null>;
  getSessionToken(id: string): Promise<string | null>;
  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  closeSession(id: string, status?: Exclude<SessionStatus, 'active'>): Promise<void>;
  listSessions(): Promise<Session[]>;
  getSessionsByPrompt(promptId: string): Promise<Session[]>;
  listAssessmentLinks(): Promise<AssessmentLinkRecord[]>;
  getAssessmentLink(id: string): Promise<AssessmentLinkRecord | null>;
  validateSessionToken(id: string, token: string): Promise<boolean>;
  updateSessionUsage(id: string, additionalTokens: number, additionalInteractions: number): Promise<void>;
  addReplayEvent(sessionId: string, type: ReplayEventType, timestamp: number, payload: unknown): Promise<void>;
  getReplayEvents(sessionId: string): Promise<StoredReplayEvent[]>;
  getMainBranch(sessionId: string): Promise<SessionBranch | null>;
  getBranch(sessionId: string, branchId: string): Promise<SessionBranch | null>;
  listBranches(sessionId: string): Promise<SessionBranch[]>;
  createBranch(config: CreateBranchConfig): Promise<SessionBranch>;
  getMainConversation(sessionId: string, branchId: string): Promise<ConversationSummary | null>;
  getConversation(sessionId: string, conversationId: string): Promise<ConversationSummary | null>;
  listConversations(sessionId: string, branchId: string): Promise<ConversationSummary[]>;
  createConversation(config: CreateConversationConfig): Promise<ConversationSummary>;
  updateConversation(config: UpdateConversationConfig): Promise<ConversationSummary | null>;
  allocateTurnSequence(sessionId: string): Promise<number>;
  addBranchMessage(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    role: MessageRole,
    content: string,
    tokenCount: number,
    conversationId?: string,
  ): Promise<void>;
  getBranchMessages(
    sessionId: string,
    branchId: string,
    conversationId?: string,
    options?: { includeRewound?: boolean },
  ): Promise<StoredMessage[]>;
  rewindMessages(
    sessionId: string,
    branchId: string,
    conversationId: string,
    afterTurnSequence: number,
  ): Promise<void>;
  addBranchReplayEvent(
    sessionId: string,
    branchId: string,
    turnSequence: number | null,
    type: ReplayEventType,
    timestamp: number,
    payload: unknown,
    conversationId?: string,
  ): Promise<void>;
  getBranchReplayEvents(sessionId: string, branchId: string, conversationId?: string): Promise<StoredReplayEvent[]>;
  listConversationContextAttachments(conversationId: string): Promise<ContextAttachment[]>;
  replaceConversationContextAttachments(
    conversationId: string,
    attachments: ContextAttachmentInput[],
  ): Promise<ContextAttachment[]>;
  listContextResources(sessionId: string, branchId: string): Promise<ContextResource[]>;
  upsertContextResource(input: ContextResourceInput): Promise<ContextResource>;
  upsertWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot>;
  createWorkspaceSnapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshot>;
  getWorkspaceSnapshot(
    sessionId: string,
    branchId: string,
    options?: { kind?: WorkspaceSnapshotKind; turn_sequence?: number },
  ): Promise<WorkspaceSnapshot | null>;
  markAssessmentLinkUsed(linkId: string, sessionId: string): Promise<boolean>;
  isAssessmentLinkUsed(linkId: string): Promise<boolean>;
  getAssessmentLinkSessionId(linkId: string): Promise<string | null>;
  deleteAssessmentLink(id: string): Promise<boolean>;
  deleteAssessmentLinks(ids: string[]): Promise<number>;
}
