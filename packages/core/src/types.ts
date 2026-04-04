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

// 'groq' uses the openai-compatible adapter internally;
// named explicitly so the backend can auto-set Groq's base_url.
export type AgentProvider = 'openai-compatible' | 'anthropic-native' | 'groq';

export interface AgentConfig {
  provider: AgentProvider;
  base_url?: string; // optional for anthropic-native and groq (has known default)
  api_key: string;
  model: string;
}

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
