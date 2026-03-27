import type { Session, MessageRole, Message, Constraint } from './types.js';

export interface CreateSessionParams {
  promptId: string;
  candidateEmail: string;
  constraint: Constraint;
}

export interface DatabaseAdapter {
  createSession(params: CreateSessionParams): Promise<{ sessionId: string; linkToken: string }>;
  getSession(id: string): Promise<Session | null>;
  addMessage(sessionId: string, role: MessageRole, content: string, tokenCount: number): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  closeSession(id: string): Promise<void>;
  listSessions(): Promise<Session[]>;
  getSessionsByPrompt(promptId: string): Promise<Session[]>;
}
