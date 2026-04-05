import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';

const { mockWriteFile, mockReadFile, mockIdePanel } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockResolvedValue('# Approved plan'),
  mockIdePanel: vi.fn(),
}));

vi.mock('./components/DevSetup.js', () => ({
  DevSetup: ({ onSessionReady }: { onSessionReady: (session: unknown) => void }) => (
    <button
      type="button"
      data-testid="mock-start-session"
      onClick={() => onSessionReady({
        sessionId: 'sess-1',
        sessionToken: 'tok-1',
        agentConfig: {
          provider: 'openai-compatible',
          api_key: 'sk-test',
          model: 'gpt-4o',
        },
        prompt: {
          id: 'prompt-1',
          title: 'Build a task runner',
          description: 'Create a CLI utility that queues and runs jobs.',
          tags: ['backend', 'cli'],
        },
      })}
    >
      Start
    </button>
  ),
}));

vi.mock('./components/TopBar.js', () => ({
  TopBar: ({
    onViewPrompt,
    onSubmitTask,
    submitDisabled,
    submittingTask,
  }: {
    onViewPrompt?: () => void;
    onSubmitTask?: () => void;
    submitDisabled?: boolean;
    submittingTask?: boolean;
  }) => (
    <div>
      <button type="button" data-testid="mock-view-prompt" onClick={onViewPrompt}>
        View Prompt
      </button>
      <button
        type="button"
        data-testid="mock-submit-task"
        onClick={onSubmitTask}
        disabled={submitDisabled}
      >
        {submittingTask ? 'Submitting...' : 'Submit task'}
      </button>
    </div>
  ),
}));

vi.mock('./components/SplitPane.js', () => ({
  SplitPane: ({ left, right }: { left: ReactNode; right: ReactNode }) => (
    <div data-testid="split-pane">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  ),
}));

vi.mock('./components/IdePanel.js', () => ({
  IdePanel: ({ requestOpenFile }: { requestOpenFile?: string | null }) => {
    mockIdePanel(requestOpenFile);
    return <div data-testid="ide-panel">{requestOpenFile ?? 'IDE'}</div>;
  },
}));

vi.mock('./components/DatabasePanel.js', () => ({
  DatabasePanel: ({ onOpenSetupFile }: { onOpenSetupFile?: (path: string) => void }) => (
    <div data-testid="database-panel">
      DB
      <button
        type="button"
        data-testid="mock-db-setup"
        onClick={() => onOpenSetupFile?.('src/lib/mock-postgres.js')}
      >
        Setup
      </button>
    </div>
  ),
}));

vi.mock('./components/ChatPanel.js', () => ({
  ChatPanel: ({
    onLoadingChange,
    mode,
    onModeChange,
    latestPlanPath,
    onPlanGenerated,
    onApprovePlan,
    modelLabel,
  }: {
    onLoadingChange?: (loading: boolean) => void;
    mode?: 'build' | 'plan';
    onModeChange?: (mode: 'build' | 'plan') => void;
    latestPlanPath?: string | null;
    onPlanGenerated?: (path: string) => void;
    onApprovePlan?: (path: string) => Promise<string>;
    modelLabel?: string;
  }) => (
    <div data-testid="chat-panel">
      <div data-testid="mock-chat-mode">{mode}</div>
      <div data-testid="mock-chat-model">{modelLabel}</div>
      <button type="button" data-testid="mock-chat-busy" onClick={() => onLoadingChange?.(true)}>
        Busy
      </button>
      <button type="button" data-testid="mock-chat-idle" onClick={() => onLoadingChange?.(false)}>
        Idle
      </button>
      <button type="button" data-testid="mock-switch-plan" onClick={() => onModeChange?.('plan')}>
        Plan
      </button>
      <button
        type="button"
        data-testid="mock-plan-generated"
        onClick={() => onPlanGenerated?.('plans/2026-04-04-101500-plan.md')}
      >
        Plan Generated
      </button>
      <button
        type="button"
        data-testid="mock-approve-plan"
        onClick={() => void onApprovePlan?.(latestPlanPath ?? 'plans/2026-04-04-101500-plan.md')}
      >
        Approve Plan
      </button>
    </div>
  ),
}));

vi.mock('./components/Toast.js', () => ({
  Toast: () => null,
}));

vi.mock('./components/ReviewDashboard.js', () => ({
  ReviewDashboard: () => <div data-testid="review-dashboard">Review</div>,
}));

vi.mock('./components/AssessmentSubmittedModal.js', () => ({
  AssessmentSubmittedModal: ({
    mode,
    onDone,
    onCancel,
    onConfirm,
    promptTitle,
    stats,
    submitting,
  }: {
    mode: 'confirm' | 'submitted';
    onDone: () => void;
    onCancel?: () => void;
    onConfirm?: () => void;
    promptTitle?: string | null;
    stats: { tokensUsed: number; interactionsUsed: number };
    submitting?: boolean;
  }) => (
    <div data-testid={mode === 'confirm' ? 'submit-confirmation-modal' : 'submitted-modal'}>
      <div>{promptTitle}</div>
      {stats ? (
        <>
          <div>{stats.tokensUsed}</div>
          <div>{stats.interactionsUsed}</div>
        </>
      ) : null}
      {mode === 'confirm' ? (
        <>
          <div>{submitting ? 'Submitting your assessment...' : 'Ready to submit'}</div>
          <button type="button" data-testid="submit-confirmation-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" data-testid="submit-confirmation-submit" onClick={onConfirm}>
            Submit
          </button>
        </>
      ) : (
        <button type="button" data-testid="submitted-done" onClick={onDone}>
          Done
        </button>
      )}
    </div>
  ),
}));

vi.mock('./components/AssessmentLinkLoader.js', () => ({
  AssessmentLinkLoader: () => <div data-testid="assessment-loader">Assessment</div>,
}));

vi.mock('./components/AdminLinksDashboard.js', () => ({
  AdminLinksDashboard: () => <div data-testid="admin-links-dashboard">Admin Links</div>,
}));

vi.mock('./lib/useConstraintTimer.js', () => ({
  useConstraintTimer: () => [
    {
      secondsRemaining: 3600,
      tokensRemaining: 50000,
      interactionsRemaining: 30,
      maxTokens: 50000,
      maxInteractions: 30,
      timeLimitSeconds: 3600,
    },
    vi.fn(),
  ],
}));

vi.mock('./lib/webcontainer.js', () => ({
  getWebContainer: vi.fn().mockResolvedValue(null),
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

vi.mock('./lib/review-replay.js', () => ({
  getReviewSessionId: () => null,
}));

describe('App prompt display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn());
  });

  test('opens prompt instructions in the IDE when a session starts and the top bar action is used', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));

    expect(screen.getByTestId('ide-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mock-view-prompt'));

    await waitFor(() => {
      expect(mockWriteFile).toHaveBeenCalledWith(
        'instructions.md',
        '# Build a task runner\n\nCreate a CLI utility that queues and runs jobs.\n\n`backend` `cli`',
      );
      expect(mockIdePanel).toHaveBeenLastCalledWith(expect.stringMatching(/^instructions\.md-/));
    });
  });

  test('opens generated plans in the IDE and reads them when approved', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));
    fireEvent.click(screen.getByTestId('mock-plan-generated'));

    await waitFor(() => {
      expect(mockIdePanel).toHaveBeenLastCalledWith(expect.stringMatching(/^plans\/2026-04-04-101500-plan\.md-/));
    });

    fireEvent.click(screen.getByTestId('mock-approve-plan'));

    await waitFor(() => {
      expect(mockReadFile).toHaveBeenCalledWith('plans/2026-04-04-101500-plan.md');
    });
  });

  test('switches the workspace sidebar to the database panel', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));
    fireEvent.click(screen.getByRole('button', { name: 'Database' }));

    expect(screen.getByTestId('database-panel')).toBeInTheDocument();
  });

  test('opens the generated postgres helper in the IDE when setup starts from the database panel', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));
    fireEvent.click(screen.getByRole('button', { name: 'Database' }));
    fireEvent.click(screen.getByTestId('mock-db-setup'));

    await waitFor(() => {
      expect(mockIdePanel).toHaveBeenLastCalledWith(expect.stringMatching(/^src\/lib\/mock-postgres\.js-/));
    });
  });

  test('tracks Build and Plan mode in app state', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));
    expect(screen.getByTestId('mock-chat-mode')).toHaveTextContent('build');

    fireEvent.click(screen.getByTestId('mock-switch-plan'));
    expect(screen.getByTestId('mock-chat-mode')).toHaveTextContent('plan');
  });

  test('passes the configured model label to chat after session start', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));

    expect(screen.getByTestId('mock-chat-model')).toHaveTextContent('gpt-4o');
  });

  test('renders the admin dashboard on the admin route', () => {
    window.history.replaceState({}, '', '/admin/links');

    render(<App />);

    expect(screen.getByTestId('admin-dashboard')).toBeInTheDocument();
  });

  test('shows submitted modal after submit instead of routing to review', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: {
            status: 'completed',
            created_at: 1000,
            closed_at: 61000,
            tokens_used: 1200,
            interactions_used: 7,
            constraint: {
              max_session_tokens: 50000,
              max_interactions: 30,
              time_limit_minutes: 60,
            },
          },
          constraints_remaining: {
            tokens_remaining: 48800,
            interactions_remaining: 23,
            seconds_remaining: 3500,
          },
        }),
      } as unknown as Response);

    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));
    fireEvent.click(screen.getByTestId('mock-submit-task'));
    expect(screen.getByTestId('submit-confirmation-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('submit-confirmation-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('submitted-modal')).toBeInTheDocument();
      expect(screen.queryByTestId('review-dashboard')).not.toBeInTheDocument();
      expect(window.location.pathname).toBe('/');
    });
  });

  test('opens a custom confirmation modal before submit', () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));
    fireEvent.click(screen.getByTestId('mock-submit-task'));

    expect(screen.getByTestId('submit-confirmation-modal')).toBeInTheDocument();
  });

  test('disables submit while the chat is busy', async () => {
    render(<App />);

    fireEvent.click(screen.getByTestId('mock-start-session'));
    expect(screen.getByTestId('mock-submit-task')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('mock-chat-busy'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-submit-task')).toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('mock-chat-idle'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-submit-task')).not.toBeDisabled();
    });
  });

  test('reopens a completed saved session into the submitted modal', async () => {
    localStorage.setItem('lintic_session', JSON.stringify({
      sessionId: 'sess-1',
      sessionToken: 'tok-1',
      prompt: {
        id: 'prompt-1',
        title: 'Build a task runner',
      },
    }));

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        session: {
          status: 'completed',
          created_at: 1000,
          closed_at: 121000,
          tokens_used: 2000,
          interactions_used: 9,
          constraint: {
            max_session_tokens: 50000,
            max_interactions: 30,
            time_limit_minutes: 60,
          },
        },
        constraints_remaining: {
          tokens_remaining: 48000,
          interactions_remaining: 21,
          seconds_remaining: 0,
        },
      }),
    } as unknown as Response);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('submitted-modal')).toBeInTheDocument();
    });
  });
});
