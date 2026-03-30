import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Toast } from './Toast.js';
import type { ToastMessage } from './Toast.js';

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('renders a toast message', () => {
    const toasts: ToastMessage[] = [{ id: '1', message: 'Hello toast' }];
    render(<Toast toasts={toasts} onDismiss={vi.fn()} />);
    expect(screen.getByText('Hello toast')).toBeInTheDocument();
  });

  test('renders multiple toasts', () => {
    const toasts: ToastMessage[] = [
      { id: '1', message: 'First' },
      { id: '2', message: 'Second' },
    ];
    render(<Toast toasts={toasts} onDismiss={vi.fn()} />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  test('calls onDismiss when dismiss button clicked', () => {
    const onDismiss = vi.fn();
    const toasts: ToastMessage[] = [{ id: 'abc', message: 'Test' }];
    render(<Toast toasts={toasts} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith('abc');
  });

  test('auto-dismisses after duration', () => {
    const onDismiss = vi.fn();
    const toasts: ToastMessage[] = [{ id: 'x', message: 'Auto', duration: 3000 }];
    render(<Toast toasts={toasts} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(onDismiss).toHaveBeenCalledWith('x');
  });

  test('auto-dismisses after default 5000ms when no duration specified', () => {
    const onDismiss = vi.fn();
    const toasts: ToastMessage[] = [{ id: 'y', message: 'Default' }];
    render(<Toast toasts={toasts} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(4999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledWith('y');
  });

  test('renders nothing when toasts array is empty', () => {
    render(<Toast toasts={[]} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});
