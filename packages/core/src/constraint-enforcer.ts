import type { Constraint, ConstraintsRemaining } from './types.js';

export class ConstraintEnforcer {
  private readonly constraint: Constraint;
  private readonly startedAt: number;
  private tokensUsed: number = 0;
  private interactionsUsed: number = 0;

  constructor(constraint: Constraint, startedAt?: number) {
    this.constraint = constraint;
    this.startedAt = startedAt ?? Date.now();
  }

  canSend(): boolean {
    return (
      this.tokensUsed < this.constraint.max_session_tokens &&
      this.interactionsUsed < this.constraint.max_interactions &&
      this.elapsedSeconds() < this.constraint.time_limit_minutes * 60
    );
  }

  recordUsage(tokens: number): void {
    this.tokensUsed += tokens;
    this.interactionsUsed += 1;

    if (tokens > this.constraint.max_message_tokens) {
      throw new Error(
        `Constraint violated: message used ${tokens} tokens, limit is ${this.constraint.max_message_tokens} per message`
      );
    }
  }

  getRemaining(): ConstraintsRemaining {
    const secondsAllowed = this.constraint.time_limit_minutes * 60;
    return {
      tokens_remaining: Math.max(0, this.constraint.max_session_tokens - this.tokensUsed),
      interactions_remaining: Math.max(0, this.constraint.max_interactions - this.interactionsUsed),
      seconds_remaining: Math.max(0, secondsAllowed - this.elapsedSeconds()),
    };
  }

  private elapsedSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }
}
