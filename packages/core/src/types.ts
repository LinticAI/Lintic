// ─── Constraints ────────────────────────────────────────────────────────────

export interface Constraint {
  max_session_tokens: number;
  max_message_tokens: number;
  max_interactions: number;
  context_window: number;
  time_limit_minutes: number;
}

export interface ConstraintsRemaining {
  tokens_remaining: number;
  interactions_remaining: number;
  seconds_remaining: number;
}

// ─── Agent Configuration ─────────────────────────────────────────────────────

// 'groq', 'cerebras', and 'local-openai' use the openai-compatible adapter internally;
// named explicitly so the backend can auto-set their default base URLs.
export type AgentProvider = 'openai-compatible' | 'anthropic-native' | 'groq' | 'cerebras' | 'local-openai';

export interface AgentConfig {
  provider: AgentProvider;
  base_url?: string; // optional for anthropic-native, groq, cerebras, and local-openai (known defaults)
  api_key: string;
  model: string;
}

export type AgentRequestMode = 'build' | 'plan';

// ─── Tool Calling ────────────────────────────────────────────────────────────

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'run_command'
  | 'read_terminal_output'
  | 'list_processes'
  | 'kill_process'
  | 'list_directory'
  | 'search_files';

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, ToolParameter>;
  required: string[];
}

export interface ToolCall {
  id: string; // LLM-provided ID, used to match results back to calls
  name: ToolName;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  name: ToolName;
  output: string;
  is_error: boolean;
}

// ─── Messages and Conversation History ───────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  role: MessageRole;
  content: string | null; // null when assistant turn contains only tool_calls
  tool_calls?: ToolCall[];     // set when role='assistant' and LLM called tools
  tool_results?: ToolResult[]; // set when role='tool'
}

export interface SessionContext {
  session_id: string;
  history: Message[]; // full conversation excluding the new message being sent
  constraints_remaining: ConstraintsRemaining;
}

// ─── Agent Response ───────────────────────────────────────────────────────────

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AgentResponse {
  content: string | null; // null when stop_reason='tool_use'
  tool_calls?: ToolCall[];
  usage: TokenUsage;
  stop_reason: StopReason;
}

export interface AgentCapabilities {
  supports_system_prompt: boolean;
  supports_tool_use: boolean;
  max_context_window: number;
}

// ─── AgentAdapter Interface ───────────────────────────────────────────────────

export interface AgentAdapter {
  init(config: AgentConfig): Promise<void>;
  sendMessage(msg: string | null, context: SessionContext): Promise<AgentResponse>;
  getTokenUsage(): TokenUsage;
  getCapabilities(): AgentCapabilities;
  getTools(): ToolDefinition[];
}

// ─── Session ──────────────────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'completed' | 'expired';

export interface Session {
  id: string;
  prompt_id: string;
  candidate_email: string;
  status: SessionStatus;
  created_at: number;  // Unix ms
  closed_at?: number;  // Unix ms, set when status becomes 'completed' or 'expired'
  constraint: Constraint;
  tokens_used: number;
  interactions_used: number;
  score?: number; // composite 0–1, set after metrics are computed
}

export interface PromptSummary {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
}

export interface SessionBranch {
  id: string;
  session_id: string;
  name: string;
  parent_branch_id?: string;
  forked_from_sequence?: number;
  created_at: number;
}

export interface ConversationSummary {
  id: string;
  session_id: string;
  branch_id: string;
  title: string;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

export type ContextAttachmentKind = 'file' | 'repo_map' | 'summary' | 'prior_conversation';

export interface ContextAttachment {
  id: string;
  conversation_id: string;
  kind: ContextAttachmentKind;
  label: string;
  path?: string;
  resource_id?: string;
  source_conversation_id?: string;
  created_at: number;
}

export type ContextResourceKind = 'repo_map' | 'summary';

export interface ContextResource {
  id: string;
  session_id: string;
  branch_id: string;
  kind: ContextResourceKind;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
  source_conversation_id?: string;
}

export type WorkspaceSection = 'code' | 'database' | 'git';

export type SnapshotEncoding = 'utf-8' | 'base64';

export interface SnapshotFile {
  path: string;
  encoding: SnapshotEncoding;
  content: string;
}

export type WorkspaceSnapshotKind = 'draft' | 'turn' | 'checkpoint';

export interface MockPgPoolExport {
  id: string;
  name: string;
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; primaryKey: boolean }>;
    rows: Array<Record<string, string | number | boolean | null>>;
  }>;
  indexes: Array<{ name: string; table: string; columns: string[]; kind: 'primary' | 'index' }>;
  recentQueries: Array<{
    sql: string;
    params: Array<string | number | boolean | null>;
    operation: string;
    table: string | null;
    rowCount: number;
    usedIndex?: string;
    slowQueryReason?: string;
    timestamp: number;
  }>;
}

export interface WorkspaceSnapshot {
  id: string;
  session_id: string;
  branch_id: string;
  kind: WorkspaceSnapshotKind;
  turn_sequence?: number;
  label?: string;
  created_at: number;
  active_path?: string;
  workspace_section?: WorkspaceSection;
  filesystem: SnapshotFile[];
  mock_pg: MockPgPoolExport[];
}

export type AssessmentLinkStatus = 'active' | 'consumed' | 'expired' | 'invalid';

export interface AssessmentLinkRecord {
  id: string;
  token: string;
  url: string;
  prompt_id: string;
  candidate_email: string;
  created_at: number; // Unix ms
  expires_at: number; // Unix ms
  constraint: Constraint;
  consumed_session_id?: string;
  consumed_at?: number; // Unix ms
}

export interface AdminAssessmentLinkSummary {
  id: string;
  url: string;
  prompt_id: string;
  candidate_email: string;
  created_at: number;
  expires_at: number;
  status: AssessmentLinkStatus;
  session_status?: SessionStatus;
  prompt?: PromptSummary | null;
  consumed_session_id?: string;
}

export interface AdminAssessmentLinkDetail extends AdminAssessmentLinkSummary {
  token: string;
  constraint: Constraint;
  consumed_at?: number;
}

export interface AdminAssessmentLinksResponse {
  links: AdminAssessmentLinkSummary[];
}

export interface AdminAssessmentLinkDetailResponse {
  link: AdminAssessmentLinkDetail;
}

export interface AdminPromptsResponse {
  prompts: PromptSummary[];
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface MetricResult {
  name: string;
  score: number; // 0–1 normalized
  label: string;
  details?: string;
}

// ─── Session Recording and Replay ────────────────────────────────────────────

export type ReplayEventType =
  | 'message'
  | 'agent_response'
  | 'tool_call'
  | 'tool_result'
  | 'code_change'
  | 'terminal_output'
  | 'resource_usage';

export interface ReplayEvent {
  type: ReplayEventType;
  timestamp: number; // Unix ms
  // Kept as `unknown` to avoid circular dependencies; consumers narrow the type.
  payload: unknown;
}

export interface SessionRecording {
  session_id: string;
  events: ReplayEvent[];
}

// ─── Review Dashboard ─────────────────────────────────────────────────────────

export interface ReviewData {
  session: Session;
  messages: Message[];
  metrics: MetricResult[];
  recording: SessionRecording;
}

// ─── Session Analysis ─────────────────────────────────────────────────────────

/** One cohesive work attempt between rewind boundaries. */
export interface Iteration {
  index: number;            // 1-indexed
  rewound_at?: number;      // Unix ms – set if iteration was abandoned via rewind
  message_count: number;
  user_messages: string[];  // candidate prompt texts (for LLM context)
}

export interface RedisStats {
  hits: number;
  misses: number;
  evictions: number;
}

export interface PostgresStats {
  total_queries: number;
  slow_queries: number;
  indexed_data_queries: number;
  total_data_queries: number;  // SELECT + UPDATE + DELETE
}

export interface InfrastructureMetricScore {
  name: string;
  label: string;
  score: number; // 0–1
  details: string;
}

export interface InfrastructureMetrics {
  caching_effectiveness: InfrastructureMetricScore;
  error_handling_coverage: InfrastructureMetricScore;
  scaling_awareness: InfrastructureMetricScore;
}

export type RubricDimension =
  | 'context_management'
  | 'problem_decomposition'
  | 'debugging_collaboration'
  | 'task_iteration_velocity'
  | 'security_awareness'
  | 'strategic_backtracking'
  | 'domain_knowledge_directiveness';

export interface EvaluatorDimensionScore {
  dimension: RubricDimension;
  label: string;
  score: number; // 0–10
  rationale: string;
}

export interface EvaluatorResponse {
  scores: EvaluatorDimensionScore[];
  overall_summary: string;
}

export interface EvaluationResult {
  infrastructure: InfrastructureMetrics;
  llm_evaluation: EvaluatorResponse;
  iterations: Iteration[];
}
