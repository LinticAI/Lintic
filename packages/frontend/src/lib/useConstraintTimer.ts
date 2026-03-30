import { useEffect, useRef, useState } from 'react';

export interface ConstraintState {
  secondsRemaining: number;
  tokensRemaining: number;
  interactionsRemaining: number;
  maxTokens: number;
  maxInteractions: number;
  timeLimitSeconds: number;
}

/**
 * Manages a live countdown of secondsRemaining and fires callbacks when
 * token / interaction / time warning thresholds are crossed.
 *
 * @param initial  Starting constraint values.
 * @param onWarning  Called once when a threshold is crossed with a message string.
 */
export function useConstraintTimer(
  initial: ConstraintState,
  onWarning: (message: string) => void,
): [ConstraintState, (patch: Partial<ConstraintState>) => void] {
  const [state, setState] = useState<ConstraintState>(initial);

  // Track which warnings have already fired so we don't repeat them.
  const warned = useRef({
    tokens20: false,
    interactions20: false,
    time5min: false,
  });

  // Live countdown — ticks every second.
  useEffect(() => {
    const id = setInterval(() => {
      setState((prev) => {
        const next = { ...prev, secondsRemaining: Math.max(0, prev.secondsRemaining - 1) };

        // 5-minute warning
        if (!warned.current.time5min && next.secondsRemaining > 0 && next.secondsRemaining <= 300) {
          warned.current.time5min = true;
          onWarning('Less than 5 minutes remaining.');
        }

        return next;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [onWarning]);

  // Watch for token / interaction threshold warnings.
  useEffect(() => {
    const tokenPct = state.maxTokens > 0 ? (state.tokensRemaining / state.maxTokens) * 100 : 100;
    const interPct =
      state.maxInteractions > 0
        ? (state.interactionsRemaining / state.maxInteractions) * 100
        : 100;

    if (!warned.current.tokens20 && tokenPct <= 20 && state.tokensRemaining > 0) {
      warned.current.tokens20 = true;
      onWarning('Token budget is at 20% — use remaining interactions wisely.');
    }

    if (
      !warned.current.interactions20 &&
      interPct <= 20 &&
      state.interactionsRemaining > 0
    ) {
      warned.current.interactions20 = true;
      onWarning('Only 20% of agent interactions remain.');
    }
  }, [state, onWarning]);

  function patch(update: Partial<ConstraintState>) {
    setState((prev) => ({ ...prev, ...update }));
  }

  return [state, patch];
}
