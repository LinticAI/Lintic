export interface SessionRow {
  id: string;
  token: string;
  prompt_id: string;
  candidate_email: string;
  status: string;
  created_at: number;
  closed_at: number | null;
  max_session_tokens: number;
  max_message_tokens: number;
  max_interactions: number;
  context_window: number;
  time_limit_minutes: number;
  tokens_used: number;
  interactions_used: number;
  score: number | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  branch_id: string;
  conversation_id: string;
  turn_sequence: number | null;
  role: string;
  content: string;
  token_count: number;
  created_at: number;
  rewound_at: number | null;
}

export interface ReplayEventRow {
  id: number;
  session_id: string;
  branch_id: string;
  conversation_id: string;
  turn_sequence: number | null;
  type: string;
  timestamp: number;
  payload: string;
}

export interface SessionBranchRow {
  id: string;
  session_id: string;
  name: string;
  parent_branch_id: string | null;
  forked_from_sequence: number | null;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  session_id: string;
  branch_id: string;
  title: string;
  archived: number | boolean;
  created_at: number;
  updated_at: number;
}

export interface ContextAttachmentRow {
  id: string;
  conversation_id: string;
  kind: string;
  label: string;
  path: string | null;
  resource_id: string | null;
  source_conversation_id: string | null;
  created_at: number;
}

export interface ContextResourceRow {
  id: string;
  session_id: string;
  branch_id: string;
  kind: string;
  title: string;
  content: string;
  source_conversation_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceSnapshotRow {
  id: string;
  session_id: string;
  branch_id: string;
  kind: string;
  turn_sequence: number | null;
  label: string | null;
  created_at: number;
  active_path: string | null;
  workspace_section: string | null;
  filesystem_json: string;
  mock_pg_json: string;
}

export interface AssessmentLinkRow {
  id: string;
  token: string;
  url: string;
  prompt_id: string;
  candidate_email: string;
  created_at: number;
  expires_at: number;
  constraint_json: string;
  consumed_session_id?: string | null;
  consumed_at?: number | null;
}
