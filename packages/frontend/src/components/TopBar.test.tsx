import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { TopBar } from './TopBar.js';

const DEFAULT_PROPS = {
  secondsRemaining: 3600,
  tokensRemaining: 40000,
  interactionsRemaining: 25,
  maxTokens: 50000,
  maxInteractions: 30,
  isDark: false,
  onToggleTheme: () => {},
};

describe('TopBar', () => {
  test('renders the brand, metadata, and timer', () => {
    render(<TopBar {...DEFAULT_PROPS} />);

    expect(screen.getByAltText('Lintic')).toHaveAttribute('src', '/logo-light.png');
    expect(screen.getByText('Lintic')).toBeInTheDocument();
    expect(screen.getByText('Library Backend Service')).toBeInTheDocument();
    expect(screen.getByText('PRD + Implementation')).toBeInTheDocument();
    expect(screen.getByTestId('timer').textContent).toBe('60:00 min');
  });

  test('uses the dark logo variant when dark mode is enabled', () => {
    render(<TopBar {...DEFAULT_PROPS} isDark />);
    expect(screen.getByAltText('Lintic')).toHaveAttribute('src', '/logo-dark.png');
  });

  test('formats long durations without wrapping at one hour', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={3661} />);
    expect(screen.getByTestId('timer').textContent).toBe('61:01 min');
  });

  test('formats short durations as minutes and seconds', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={125} />);
    expect(screen.getByTestId('timer').textContent).toBe('2:05 min');
  });

  test('clamps timer display to zero when time is exhausted', () => {
    render(<TopBar {...DEFAULT_PROPS} secondsRemaining={-10} />);
    expect(screen.getByTestId('timer').textContent).toBe('0:00 min');
  });

  test('renders custom task details when provided', () => {
    render(
      <TopBar
        {...DEFAULT_PROPS}
        taskName="Frontend redesign"
        deliverables="Prototype"
      />,
    );

    expect(screen.getByText('Frontend redesign')).toBeInTheDocument();
    expect(screen.getByText('Prototype')).toBeInTheDocument();
  });

  test('only renders the view prompt button when a handler is provided', () => {
    const { rerender } = render(<TopBar {...DEFAULT_PROPS} />);
    expect(screen.queryByTestId('view-prompt')).toBeNull();

    rerender(<TopBar {...DEFAULT_PROPS} onViewPrompt={() => {}} />);
    expect(screen.getByTestId('view-prompt')).toBeInTheDocument();
  });

  test('calls the view prompt handler when clicked', () => {
    const onViewPrompt = vi.fn();
    render(<TopBar {...DEFAULT_PROPS} onViewPrompt={onViewPrompt} />);

    fireEvent.click(screen.getByTestId('view-prompt'));
    expect(onViewPrompt).toHaveBeenCalledTimes(1);
  });

  test('only renders the dev review button when a handler is provided', () => {
    const { rerender } = render(<TopBar {...DEFAULT_PROPS} />);
    expect(screen.queryByTestId('open-review-debug')).toBeNull();

    rerender(<TopBar {...DEFAULT_PROPS} onOpenReviewDebug={() => {}} />);
    expect(screen.getByTestId('open-review-debug')).toBeInTheDocument();
  });

  test('calls the dev review handler when clicked', () => {
    const onOpenReviewDebug = vi.fn();
    render(<TopBar {...DEFAULT_PROPS} onOpenReviewDebug={onOpenReviewDebug} />);

    fireEvent.click(screen.getByTestId('open-review-debug'));
    expect(onOpenReviewDebug).toHaveBeenCalledTimes(1);
  });

  test('calls the submit handler when clicked', () => {
    const onSubmitTask = vi.fn();
    render(<TopBar {...DEFAULT_PROPS} onSubmitTask={onSubmitTask} />);

    fireEvent.click(screen.getByTestId('submit-task'));
    expect(onSubmitTask).toHaveBeenCalledTimes(1);
  });

  test('disables submit when requested', () => {
    render(<TopBar {...DEFAULT_PROPS} onSubmitTask={() => undefined} submitDisabled />);

    expect(screen.getByTestId('submit-task')).toBeDisabled();
  });

  test('shows submitting state label', () => {
    render(<TopBar {...DEFAULT_PROPS} onSubmitTask={() => undefined} submittingTask />);

    expect(screen.getByTestId('submit-task')).toHaveTextContent('Submitting...');
  });

  test('allows the header content to wrap on narrower viewports', () => {
    render(<TopBar {...DEFAULT_PROPS} onViewPrompt={() => {}} onSubmitTask={() => undefined} />);

    const promptButton = screen.getByTestId('view-prompt');
    expect(promptButton.className).toContain('shrink-0');
    expect(screen.getByText('Library Backend Service').className).toContain('truncate');
    expect(screen.getByText('PRD + Implementation').className).toContain('truncate');
  });
});
