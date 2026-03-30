import { renderHook, act } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConstraintTimer } from './useConstraintTimer.js';

const initial = {
  secondsRemaining: 600,
  tokensRemaining: 50000,
  interactionsRemaining: 30,
  maxTokens: 50000,
  maxInteractions: 30,
  timeLimitSeconds: 600,
};

describe('useConstraintTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('decrements secondsRemaining each second', () => {
    const { result } = renderHook(() =>
      useConstraintTimer(initial, vi.fn()),
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current[0].secondsRemaining).toBe(597);
  });

  test('does not go below 0', () => {
    const { result } = renderHook(() =>
      useConstraintTimer({ ...initial, secondsRemaining: 2 }, vi.fn()),
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current[0].secondsRemaining).toBe(0);
  });

  test('fires time warning when secondsRemaining reaches 300', () => {
    const onWarning = vi.fn();
    renderHook(() =>
      useConstraintTimer({ ...initial, secondsRemaining: 302 }, onWarning),
    );

    act(() => {
      vi.advanceTimersByTime(3000); // 302 → 299 (crosses 300)
    });

    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('5 minute'));
  });

  test('fires time warning only once', () => {
    const onWarning = vi.fn();
    renderHook(() =>
      useConstraintTimer({ ...initial, secondsRemaining: 305 }, onWarning),
    );

    act(() => {
      vi.advanceTimersByTime(10000); // 305 → 295
    });

    const timeCalls = onWarning.mock.calls.filter((c) =>
      (c[0] as string).includes('5 minute'),
    );
    expect(timeCalls).toHaveLength(1);
  });

  test('fires token warning at 20% remaining', () => {
    const onWarning = vi.fn();
    const { result } = renderHook(() =>
      useConstraintTimer({ ...initial, tokensRemaining: 50000 }, onWarning),
    );

    act(() => {
      result.current[1]({ tokensRemaining: 10000 }); // exactly 20%
    });

    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Token budget'));
  });

  test('fires interaction warning at 20% remaining', () => {
    const onWarning = vi.fn();
    const { result } = renderHook(() =>
      useConstraintTimer({ ...initial, interactionsRemaining: 30 }, onWarning),
    );

    act(() => {
      result.current[1]({ interactionsRemaining: 6 }); // 20% of 30
    });

    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('interaction'));
  });

  test('patch updates the returned state', () => {
    const { result } = renderHook(() =>
      useConstraintTimer(initial, vi.fn()),
    );

    act(() => {
      result.current[1]({ tokensRemaining: 30000, interactionsRemaining: 20 });
    });

    expect(result.current[0].tokensRemaining).toBe(30000);
    expect(result.current[0].interactionsRemaining).toBe(20);
  });
});
