import type {
  Constraint,
  Message,
  MetricResult,
  ReplayEvent,
  Session,
  SessionRecording,
  ToolCall,
  ToolResult,
} from './types.js';

export interface MetricComputationInput {
  session?: Pick<Session, 'tokens_used' | 'interactions_used' | 'score' | 'constraint'>;
  messages?: Message[];
  recording?: Pick<SessionRecording, 'events'>;
  finalFiles?: Record<string, string>;
  correctnessScore?: number;
}

interface InteractionWindow {
  events: ReplayEvent[];
}

interface ToolResultEntry {
  index: number;
  name: string;
  isError: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function countLines(content: string): number {
  if (!content.trim()) {
    return 0;
  }
  return content.split('\n').length;
}

function getEvents(recording?: Pick<SessionRecording, 'events'>): ReplayEvent[] {
  return recording?.events ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getToolCallsFromPayload(payload: unknown): ToolCall[] {
  if (!isRecord(payload) || !Array.isArray(payload['tool_calls'])) {
    return [];
  }
  return payload['tool_calls'] as ToolCall[];
}

function getToolResultsFromPayload(payload: unknown): ToolResult[] {
  if (!isRecord(payload) || !Array.isArray(payload['tool_results'])) {
    return [];
  }
  return payload['tool_results'] as ToolResult[];
}

function getContentFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload['content'] === 'string' ? payload['content'] : null;
}

function getStopReasonFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload['stop_reason'] === 'string' ? payload['stop_reason'] : null;
}

function getRoleFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload['role'] === 'string' ? payload['role'] : null;
}

function getTotalTokensFromPayload(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload['total_tokens'] === 'number' ? payload['total_tokens'] : null;
}

function getConstraint(session?: Pick<Session, 'constraint'>): Constraint | undefined {
  return session?.constraint;
}

function getUserInteractionCount(input: MetricComputationInput): number {
  const messageCount = input.messages?.filter((message) => message.role === 'user').length ?? 0;
  if (messageCount > 0) {
    return messageCount;
  }

  const eventCount = getEvents(input.recording).filter(
    (event) => event.type === 'message' && getRoleFromPayload(event.payload) === 'user',
  ).length;
  if (eventCount > 0) {
    return eventCount;
  }

  return input.session?.interactions_used ?? 0;
}

function buildInteractionWindows(events: ReplayEvent[]): InteractionWindow[] {
  const windows: InteractionWindow[] = [];
  let current: InteractionWindow | null = null;

  for (const event of events) {
    if (event.type === 'message' && getRoleFromPayload(event.payload) === 'user') {
      current = { events: [event] };
      windows.push(current);
      continue;
    }

    if (current) {
      current.events.push(event);
    }
  }

  return windows;
}

function hasSuccessfulToolResult(events: ReplayEvent[]): boolean {
  return events.some((event) =>
    event.type === 'tool_result'
      && getToolResultsFromPayload(event.payload).some((result) => !result.is_error),
  );
}

function hasMeaningfulAgentResponse(events: ReplayEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== 'agent_response') {
      return false;
    }

    const stopReason = getStopReasonFromPayload(event.payload);
    const content = getContentFromPayload(event.payload);
    return stopReason !== 'max_tokens' && typeof content === 'string' && content.trim().length > 0;
  });
}

function countProductiveInteractions(input: MetricComputationInput): number {
  const events = getEvents(input.recording);
  const windows = buildInteractionWindows(events);

  if (windows.length > 0) {
    return windows.filter((window) =>
      hasMeaningfulAgentResponse(window.events) || hasSuccessfulToolResult(window.events),
    ).length;
  }

  const assistantMessages = input.messages?.filter(
    (message) => message.role === 'assistant' && (message.content ?? '').trim().length > 0,
  ).length ?? 0;
  const totalInteractions = getUserInteractionCount(input);

  return Math.min(totalInteractions, assistantMessages);
}

function getTotalTokensUsed(input: MetricComputationInput): number {
  const fromSession = input.session?.tokens_used;
  if (typeof fromSession === 'number' && fromSession > 0) {
    return fromSession;
  }

  const fromEvents = getEvents(input.recording)
    .filter((event) => event.type === 'resource_usage')
    .map((event) => getTotalTokensFromPayload(event.payload) ?? 0)
    .reduce((sum, value) => sum + value, 0);

  return fromEvents;
}

function getCorrectnessScore(input: MetricComputationInput): number {
  const score = input.correctnessScore ?? input.session?.score ?? 0;
  return clamp01(score);
}

function countAddedLines(diff: string): number {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .length;
}

function getManualEditedLineCount(recording?: Pick<SessionRecording, 'events'>): number {
  return getEvents(recording)
    .filter((event) => event.type === 'code_change')
    .map((event) => {
      if (!isRecord(event.payload) || typeof event.payload['diff'] !== 'string') {
        return 0;
      }
      return countAddedLines(event.payload['diff']);
    })
    .reduce((sum, value) => sum + value, 0);
}

function getFinalLineCount(input: MetricComputationInput): number {
  if (input.finalFiles) {
    const finalLines = Object.values(input.finalFiles)
      .map((content) => countLines(content))
      .reduce((sum, value) => sum + value, 0);

    if (finalLines > 0) {
      return finalLines;
    }
  }

  const latestWrites = new Map<string, string>();
  for (const event of getEvents(input.recording)) {
    if (event.type !== 'tool_call') {
      continue;
    }

    for (const toolCall of getToolCallsFromPayload(event.payload)) {
      if (toolCall.name !== 'write_file') {
        continue;
      }
      const path = typeof toolCall.input['path'] === 'string' ? toolCall.input['path'] : null;
      const content = typeof toolCall.input['content'] === 'string' ? toolCall.input['content'] : null;
      if (path && content !== null) {
        latestWrites.set(path, content);
      }
    }
  }

  const finalLines = [...latestWrites.values()]
    .map((content) => countLines(content))
    .reduce((sum, value) => sum + value, 0);

  return Math.max(finalLines, getManualEditedLineCount(input.recording));
}

function getToolResultEntries(recording?: Pick<SessionRecording, 'events'>): ToolResultEntry[] {
  const entries: ToolResultEntry[] = [];
  for (const [index, event] of getEvents(recording).entries()) {
    if (event.type !== 'tool_result') {
      continue;
    }
    for (const result of getToolResultsFromPayload(event.payload)) {
      entries.push({
        index,
        name: result.name,
        isError: result.is_error,
      });
    }
  }
  return entries;
}

function getAgentResponseEntries(recording?: Pick<SessionRecording, 'events'>): Array<{
  index: number;
  isError: boolean;
  isRecovery: boolean;
}> {
  const entries: Array<{ index: number; isError: boolean; isRecovery: boolean }> = [];
  for (const [index, event] of getEvents(recording).entries()) {
    if (event.type !== 'agent_response') {
      continue;
    }

    const stopReason = getStopReasonFromPayload(event.payload);
    const content = getContentFromPayload(event.payload);
    entries.push({
      index,
      isError: stopReason === 'max_tokens',
      isRecovery: stopReason !== 'max_tokens' && typeof content === 'string' && content.trim().length > 0,
    });
  }
  return entries;
}

export function computeIterationEfficiency(input: MetricComputationInput): MetricResult {
  const totalInteractions = getUserInteractionCount(input);
  const productiveInteractions = countProductiveInteractions(input);
  const score = totalInteractions === 0 ? 0 : productiveInteractions / totalInteractions;

  return {
    name: 'iteration_efficiency',
    label: 'Iteration Efficiency',
    score: clamp01(score),
    details: `${productiveInteractions}/${totalInteractions} productive interactions`,
  };
}

export function computeTokenEfficiency(input: MetricComputationInput): MetricResult {
  const correctness = getCorrectnessScore(input);
  const totalTokens = getTotalTokensUsed(input);
  const maxTokens = Math.max(getConstraint(input.session)?.max_session_tokens ?? 0, totalTokens, 1);
  const normalizedTokenUsage = totalTokens / maxTokens;
  const score = normalizedTokenUsage <= 0 ? correctness : correctness / normalizedTokenUsage;

  return {
    name: 'token_efficiency',
    label: 'Token Efficiency',
    score: clamp01(score),
    details: `correctness=${correctness.toFixed(2)}, tokens=${totalTokens}`,
  };
}

export function computeIndependenceRatio(input: MetricComputationInput): MetricResult {
  const manualLines = getManualEditedLineCount(input.recording);
  const totalLines = getFinalLineCount(input);
  const score = totalLines === 0 ? 0 : manualLines / totalLines;

  return {
    name: 'independence_ratio',
    label: 'Independence Ratio',
    score: clamp01(score),
    details: `${manualLines}/${totalLines} final lines edited manually`,
  };
}

export function computeRecoveryScore(input: MetricComputationInput): MetricResult {
  const toolResults = getToolResultEntries(input.recording);
  const agentResponses = getAgentResponseEntries(input.recording);

  const errorEntries = [
    ...toolResults.filter((entry) => entry.isError).map((entry) => ({
      index: entry.index,
      matchesRecovery: (candidate: ToolResultEntry) => !candidate.isError && candidate.name === entry.name,
    })),
    ...agentResponses.filter((entry) => entry.isError).map((entry) => ({
      index: entry.index,
      matchesRecovery: (_candidate: ToolResultEntry) => false,
    })),
  ];

  if (errorEntries.length === 0) {
    return {
      name: 'recovery_score',
      label: 'Recovery Score',
      score: 1,
      details: 'No agent errors encountered',
    };
  }

  const corrected = errorEntries.filter((entry) => {
    const recoveredByTool = toolResults.some(
      (candidate) => candidate.index > entry.index && entry.matchesRecovery(candidate),
    );
    const recoveredByResponse = agentResponses.some(
      (candidate) => candidate.index > entry.index && candidate.isRecovery,
    );
    return recoveredByTool || recoveredByResponse;
  }).length;

  return {
    name: 'recovery_score',
    label: 'Recovery Score',
    score: clamp01(corrected / errorEntries.length),
    details: `${corrected}/${errorEntries.length} agent errors recovered`,
  };
}

export function computeSessionMetrics(input: MetricComputationInput): MetricResult[] {
  return [
    computeIterationEfficiency(input),
    computeTokenEfficiency(input),
    computeIndependenceRatio(input),
    computeRecoveryScore(input),
  ];
}
