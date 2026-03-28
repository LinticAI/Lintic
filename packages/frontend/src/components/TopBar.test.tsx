import { render, screen } from '@testing-library/react';
import { TopBar } from './TopBar.js';

const DEFAULT_PROPS = {
  secondsRemaining: 3600,
  tokensRemaining: 40000,
  interactionsRemaining: 25,
  maxTokens: 50000,
  maxInteractions: 30,
};

describe('TopBar', () => {
  test('renders without crashing', () => {
    render(<TopBar {...DEFAULT_PROPS} />);
    expect(screen.getByTestId('timer')).toBeInTheDocument();
  });

  test('displays formatted time for hours and minutes', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={3661} />);
    expect(screen.getByTestId('timer').textContent).toBe('01:01:01');
  });

  test('displays mm:ss format when under one hour', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={125} />);
    expect(screen.getByTestId('timer').textContent).toBe('02:05');
  });

  test('clamps timer display to 00:00 when time is exhausted', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={-10} />);
    expect(screen.getByTestId('timer').textContent).toBe('00:00');
  });

  test('applies warning style when time is below 5 minutes', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={299} />);
    expect(screen.getByTestId('timer')).toHaveClass('text-red-400');
  });

  test('does not apply warning style when time is above 5 minutes', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={300} />);
    expect(screen.getByTestId('timer')).not.toHaveClass('text-red-400');
  });

  test('displays tokens remaining', () => {
    render(<TopBar {...DEFAULT_PROPS} tokensRemaining={12345} />);
    expect(screen.getByTestId('tokens-remaining').textContent).toBe('12,345');
  });

  test('applies low-token warning style when below 20% of budget', () => {
    render(<TopBar {...DEFAULT_PROPS} tokensRemaining={9999} maxTokens={50000} />);
    expect(screen.getByTestId('tokens-remaining')).toHaveClass('text-yellow-400');
  });

  test('token progress bar width reflects remaining percentage', () => {
    render(<TopBar {...DEFAULT_PROPS} tokensRemaining={25000} maxTokens={50000} />);
    const bar = screen.getByTestId('token-bar');
    expect(bar).toHaveStyle({ width: '50%' });
  });

  test('displays interactions remaining and max', () => {
    render(<TopBar {...DEFAULT_PROPS} interactionsRemaining={18} maxInteractions={30} />);
    const el = screen.getByTestId('interactions-remaining');
    expect(el.textContent).toContain('18');
    expect(el.textContent).toContain('30');
  });
});
