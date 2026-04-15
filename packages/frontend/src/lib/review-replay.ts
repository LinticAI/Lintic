export interface ReviewMetric {
  name: string;
  label: string;
  score: number;
  details?: string;
}

export interface ReviewReplayEvent {
  type: string;
  timestamp: number;
  payload: unknown;
}

export interface ReviewInfraMetricScore {
  name: string;
  label: string;
  score: number;
  details: string;
}

export interface ReviewEvaluatorDimensionScore {
  dimension: string;
  label: string;
  score: number;
  rationale: string;
}

export interface ReviewAcceptanceCriterionResult {
  criterion: string;
  score: number;
  rationale: string;
}

export interface ReviewRubricQuestionScore {
  question: string;
  score: number;
  rationale: string;
  is_default: boolean;
}

export interface ReviewIteration {
  index: number;
  rewound_at?: number;
  message_count: number;
  user_messages: string[];
}

export interface ReviewEvaluationResult {
  infrastructure: {
    caching_effectiveness: ReviewInfraMetricScore;
    error_handling_coverage: ReviewInfraMetricScore;
    scaling_awareness: ReviewInfraMetricScore;
  };
  llm_evaluation: {
    scores: ReviewEvaluatorDimensionScore[];
    overall_summary: string;
    acceptance_criteria_results?: ReviewAcceptanceCriterionResult[];
    rubric_scores?: ReviewRubricQuestionScore[];
  };
  iterations: ReviewIteration[];
}

export interface ReviewSessionEvaluation {
  session_id: string;
  score: number;
  result: ReviewEvaluationResult;
  created_at: number;
  updated_at: number;
}

export interface ReviewPromptSummary {
  id: string;
  title: string;
  description?: string;
}

export interface ReviewSessionSummary {
  id: string;
  prompt_id: string;
  candidate_email: string;
  status: string;
  created_at: number;
  closed_at?: number;
  tokens_used: number;
  interactions_used: number;
  constraint: {
    max_session_tokens: number;
    max_interactions: number;
    time_limit_minutes: number;
  };
  score?: number;
}

export interface ReviewDataPayload {
  session: ReviewSessionSummary;
  branch?: {
    id: string;
    name: string;
  };
  branches?: Array<{
    id: string;
    name: string;
  }>;
  metrics: ReviewMetric[];
  recording: {
    session_id: string;
    events: ReviewReplayEvent[];
  };
  messages: Array<{
    role: string;
    content: string | null;
    tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    tool_results?: Array<{ tool_call_id: string; name: string; output: string; is_error: boolean }>;
  }>;
  raw_messages?: Array<{
    id: number;
    turn_sequence: number | null;
    role: string;
    content: string;
    created_at: number;
    rewound_at: number | null;
  }>;
  prompt?: ReviewPromptSummary | null;
  evaluation?: ReviewSessionEvaluation | null;
  workspace_snapshot?: {
    active_path?: string;
    filesystem: Array<{ path: string; encoding: 'utf-8' | 'base64'; content: string }>;
  } | null;
}

export interface ReviewMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  tool_results?: Array<{ tool_call_id: string; name: string; output: string; is_error: boolean }>;
}

export interface ConversationEntry {
  id: string;
  eventIndex: number;
  timestamp: number;
  title: string;
  body: string;
}

export interface CodeStateSnapshot {
  files: Record<string, string>;
  activePath: string | null;
  diff: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function getErrorFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload['error'] === 'string' ? payload['error'] : null;
}

export function getReviewSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/review\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function isComparisonDashboardRoute(pathname: string): boolean {
  return pathname === '/review';
}

export function formatMetricScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function describeReviewEvent(event: ReviewReplayEvent): string {
  switch (event.type) {
    case 'message':
      return 'Candidate Message';
    case 'agent_response':
      return getErrorFromPayload(event.payload) ? 'Agent Error' : 'Agent Response';
    case 'tool_call':
      return 'Tool Call';
    case 'tool_result':
      return 'Tool Result';
    case 'code_change':
      return 'Code Change';
    case 'terminal_output':
      return 'Terminal Output';
    case 'resource_usage':
      return 'Resource Usage';
    default:
      return event.type;
  }
}

function formatToolCalls(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload['tool_calls'])) {
    return '';
  }
  return payload['tool_calls']
    .map((toolCall) => {
      if (!isRecord(toolCall)) {
        return stringifyValue(toolCall);
      }
      const name = typeof toolCall['name'] === 'string' ? toolCall['name'] : 'tool';
      return `${name} ${stringifyValue(toolCall['input'] ?? {})}`;
    })
    .join('\n');
}

function formatToolResults(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload['tool_results'])) {
    return '';
  }
  return payload['tool_results']
    .map((toolResult) => {
      if (!isRecord(toolResult)) {
        return stringifyValue(toolResult);
      }
      const name = typeof toolResult['name'] === 'string' ? toolResult['name'] : 'tool';
      const output = typeof toolResult['output'] === 'string' ? toolResult['output'] : stringifyValue(toolResult['output']);
      return `${name}\n${output}`;
    })
    .join('\n\n');
}

export function buildConversationEntries(events: ReviewReplayEvent[]): ConversationEntry[] {
  return events.flatMap((event, eventIndex) => {
    switch (event.type) {
      case 'message': {
        if (!isRecord(event.payload)) return [];
        return [{
          id: `event-${eventIndex}`,
          eventIndex,
          timestamp: event.timestamp,
          title: 'You',
          body: typeof event.payload['content'] === 'string' ? event.payload['content'] : '',
        }];
      }
      case 'agent_response': {
        if (!isRecord(event.payload)) return [];
        const content = typeof event.payload['content'] === 'string' ? event.payload['content'] : '';
        const stopReason = typeof event.payload['stop_reason'] === 'string' ? event.payload['stop_reason'] : null;
        const error = getErrorFromPayload(event.payload);
        return [{
          id: `event-${eventIndex}`,
          eventIndex,
          timestamp: event.timestamp,
          title: error ? 'Agent Error' : 'Agent',
          body: error ? `Error: ${error}` : content || (stopReason ? `Stopped: ${stopReason}` : ''),
        }];
      }
      case 'tool_call':
        return [{
          id: `event-${eventIndex}`,
          eventIndex,
          timestamp: event.timestamp,
          title: 'Tool Call',
          body: formatToolCalls(event.payload),
        }];
      case 'tool_result':
        return [{
          id: `event-${eventIndex}`,
          eventIndex,
          timestamp: event.timestamp,
          title: 'Tool Result',
          body: formatToolResults(event.payload),
        }];
      default:
        return [];
    }
  });
}

export function synthesizeReplayEventsFromMessages(
  messages: ReviewMessage[],
  baseTimestamp = 0,
): ReviewReplayEvent[] {
  const events: ReviewReplayEvent[] = [];
  let timestamp = baseTimestamp;

  for (const message of messages) {
    timestamp += 1;

    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'user') {
      events.push({
        type: 'message',
        timestamp,
        payload: { role: 'user', content: message.content ?? '' },
      });
      continue;
    }

    if (message.role === 'assistant') {
      const content = typeof message.content === 'string' ? message.content : null;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        if (content && content.trim().length > 0) {
          events.push({
            type: 'agent_response',
            timestamp,
            payload: { content, stop_reason: 'tool_use' },
          });
          timestamp += 1;
        }
        events.push({
          type: 'tool_call',
          timestamp,
          payload: { tool_calls: message.tool_calls },
        });
        continue;
      }

      events.push({
        type: 'agent_response',
        timestamp,
        payload: { content: content ?? '', stop_reason: 'end_turn' },
      });
      continue;
    }

    if (message.role === 'tool' && Array.isArray(message.tool_results) && message.tool_results.length > 0) {
      events.push({
        type: 'tool_result',
        timestamp,
        payload: { tool_results: message.tool_results },
      });
    }
  }

  return events;
}

export function getConversationAnchorIndex(entries: ConversationEntry[], selectedEventIndex: number): number {
  let anchorIndex = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.eventIndex <= selectedEventIndex) {
      anchorIndex = index;
    }
  }
  return anchorIndex;
}

export function buildCodeStateSnapshot(
  events: ReviewReplayEvent[],
  selectedEventIndex: number,
): CodeStateSnapshot {
  const files: Record<string, string> = {};
  let activePath: string | null = null;
  let diff: string | null = null;

  for (const [index, event] of events.entries()) {
    if (index > selectedEventIndex) {
      break;
    }

    if (event.type === 'tool_call' && isRecord(event.payload) && Array.isArray(event.payload['tool_calls'])) {
      for (const toolCall of event.payload['tool_calls']) {
        if (!isRecord(toolCall) || toolCall['name'] !== 'write_file' || !isRecord(toolCall['input'])) {
          continue;
        }
        const path = typeof toolCall['input']['path'] === 'string' ? toolCall['input']['path'] : null;
        const content = typeof toolCall['input']['content'] === 'string' ? toolCall['input']['content'] : null;
        if (path && content !== null) {
          files[path] = content;
          activePath = path;
          diff = content
            .split('\n')
            .map((line) => `+ ${line}`)
            .join('\n');
        }
      }
    }

    if (event.type === 'code_change' && isRecord(event.payload)) {
      const path = typeof event.payload['file_path'] === 'string' ? event.payload['file_path'] : null;
      const nextDiff = typeof event.payload['diff'] === 'string' ? event.payload['diff'] : null;
      if (path) {
        activePath = path;
      }
      if (nextDiff) {
        diff = nextDiff;
      }
    }
  }

  return { files, activePath, diff };
}
