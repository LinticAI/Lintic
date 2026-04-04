import type { PromptSummary } from '@lintic/core';
import { getWebContainer } from './webcontainer.js';

const STORAGE_KEY = 'lintic_session';

export interface PersistedSession {
  sessionId: string;
  sessionToken: string;
  prompt: PromptSummary;
}

export interface RestoredConstraints {
  tokensRemaining: number;
  interactionsRemaining: number;
  secondsRemaining: number;
  maxTokens: number;
  maxInteractions: number;
  timeLimitSeconds: number;
}

export function saveSession(session: PersistedSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch { /* ignore storage errors */ }
}

export function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export async function validateSession(
  sessionId: string,
  sessionToken: string,
  apiBase = '',
): Promise<RestoredConstraints | null> {
  try {
    const res = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      session: {
        status: string;
        constraint: {
          max_session_tokens: number;
          max_interactions: number;
          time_limit_minutes: number;
        };
      };
      constraints_remaining: {
        tokens_remaining: number;
        interactions_remaining: number;
        seconds_remaining: number;
      };
    };
    if (data.session.status !== 'active') return null;
    return {
      tokensRemaining: data.constraints_remaining.tokens_remaining,
      interactionsRemaining: data.constraints_remaining.interactions_remaining,
      secondsRemaining: data.constraints_remaining.seconds_remaining,
      maxTokens: data.session.constraint.max_session_tokens,
      maxInteractions: data.session.constraint.max_interactions,
      timeLimitSeconds: data.session.constraint.time_limit_minutes * 60,
    };
  } catch {
    return null;
  }
}

export async function restoreFiles(
  sessionId: string,
  sessionToken: string,
  apiBase = '',
): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) return;
    const data = await res.json() as {
      messages: Array<{ role: string; content: string }>;
    };

    const wc = await getWebContainer();

    for (const msg of data.messages) {
      if (msg.role !== 'assistant') continue;
      try {
        const parsed = JSON.parse(msg.content) as {
          __type?: string;
          tool_calls?: Array<{ name: string; input: unknown }>;
        };
        if (parsed.__type !== 'tool_use' || !Array.isArray(parsed.tool_calls)) continue;
        for (const tc of parsed.tool_calls) {
          if (tc.name !== 'write_file') continue;
          const { path, content } = tc.input as { path: string; content: string };
          const lastSlash = path.lastIndexOf('/');
          if (lastSlash > 0) {
            try { await wc.fs.mkdir(path.slice(0, lastSlash), { recursive: true }); } catch { /* ignore */ }
          }
          await wc.fs.writeFile(path, content);
        }
      } catch { /* ignore non-JSON or malformed messages */ }
    }
  } catch { /* ignore all restore errors */ }
}
