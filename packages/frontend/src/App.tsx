import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar.js';
import type { WorkspaceSection } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { SplitPane } from './components/SplitPane.js';
import { IdePanel } from './components/IdePanel.js';
import { DatabasePanel } from './components/DatabasePanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import type { AgentConfig, AgentMode } from './components/ChatPanel.js';
import { DevSetup } from './components/DevSetup.js';
import type { DevSession } from './components/DevSetup.js';
import { Toast } from './components/Toast.js';
import type { ToastMessage } from './components/Toast.js';
import { useConstraintTimer } from './lib/useConstraintTimer.js';
import { ToolExecutor } from './lib/tool-executor.js';
import {
  captureWorkspaceSnapshot,
  getWebContainer,
  readFile,
  readMockPgExportState,
  watchFiles,
  writeFile,
} from './lib/webcontainer.js';
import type { WebContainer } from '@webcontainer/api';
import type { LocalToolCall, LocalToolResult } from './components/ToolActionCard.js';
import type { TerminalHandle } from './components/Terminal.js';
import { ReviewDashboard } from './components/ReviewDashboard.js';
import { getReviewSessionId } from './lib/review-replay.js';
import { AssessmentLinkLoader } from './components/AssessmentLinkLoader.js';
import { AdminDashboard } from './components/admin/AdminDashboard.js';
import {
  saveSession,
  loadSession,
  clearSession,
  validateSession,
  restoreFiles,
  type AgentSummary,
  type PersistedBranchSummary,
  type RestoredWorkspaceState,
  type SessionSummaryStats,
} from './lib/session-persist.js';
import type { PromptSummary } from '@lintic/core';
import { AssessmentSubmittedModal } from './components/AssessmentSubmittedModal.js';

type AppState = 'setup' | 'active' | 'submitted';
const ENABLE_DEV_REVIEW_SHORTCUT = import.meta.env.DEV;

function getAssessmentLinkToken(location: Location): string | null {
  if (location.pathname !== '/assessment') {
    return null;
  }
  return new URLSearchParams(location.search).get('token');
}

function isAdminRoute(location: Location): boolean {
  return location.pathname === '/admin' || location.pathname.startsWith('/admin/');
}

function generateToastId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function App() {
  const [assessmentToken, setAssessmentToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : getAssessmentLinkToken(window.location),
  );
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : getReviewSessionId(window.location.pathname),
  );
  const [adminRoute, setAdminRoute] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : isAdminRoute(window.location),
  );
  const [appState, setAppState] = useState<AppState>('setup');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | undefined>(undefined);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | undefined>(undefined);
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>('build');
  const [activePrompt, setActivePrompt] = useState<PromptSummary | null>(null);
  const [branches, setBranches] = useState<PersistedBranchSummary[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [fileToOpen, setFileToOpen] = useState<string | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [latestPlanPath, setLatestPlanPath] = useState<string | null>(null);
  const [activeWorkspaceSection, setActiveWorkspaceSection] = useState<WorkspaceSection>('code');
  const wcRef = useRef<WebContainer | null>(null);
  const executorRef = useRef<ToolExecutor | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isDark, setIsDark] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [submittingTask, setSubmittingTask] = useState(false);
  const [submittedStats, setSubmittedStats] = useState<SessionSummaryStats | null>(null);
  const [submitConfirmationOpen, setSubmitConfirmationOpen] = useState(false);
  const [bootstrappingSession, setBootstrappingSession] = useState(false);
  const snapshotTimerRef = useRef<number | null>(null);
  const hasAttemptedSavedSessionRestoreRef = useRef(false);
  const latestConsumedAssessmentSessionRef = useRef<string | null>(null);
  const restoringBranchIdRef = useRef<string | null>(null);

  const applyRestoredWorkspaceState = useCallback((restored: RestoredWorkspaceState | null) => {
    if (!restored) {
      return;
    }
    if (restored.workspaceSection) {
      setActiveWorkspaceSection(restored.workspaceSection);
    }
    if (restored.activePath) {
      setFileToOpen(`${restored.activePath}-${Date.now()}`);
    }
  }, []);

  const snapshotWorkspace = useCallback(async (
    kind: 'draft' | 'turn',
    options: { turnSequence?: number } = {},
  ) => {
    if (!sessionId || !sessionToken || !activeBranchId || appState !== 'active') {
      return;
    }

    const [filesystem, mockPg] = await Promise.all([
      captureWorkspaceSnapshot('/'),
      readMockPgExportState(),
    ]);

    await fetch(`/api/sessions/${sessionId}/workspace`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        branch_id: activeBranchId,
        kind,
        ...(options.turnSequence !== undefined ? { turn_sequence: options.turnSequence } : {}),
        ...(activeFilePath ? { active_path: activeFilePath } : {}),
        workspace_section: activeWorkspaceSection,
        filesystem,
        mock_pg: mockPg,
      }),
    });
  }, [activeBranchId, activeFilePath, activeWorkspaceSection, appState, sessionId, sessionToken]);

  useEffect(() => {
    const root = window.document.documentElement;
    if (isDark) {
      root.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  useEffect(() => {
    const handlePopState = () => {
      setAssessmentToken(getAssessmentLinkToken(window.location));
      setReviewSessionId(getReviewSessionId(window.location.pathname));
      setAdminRoute(isAdminRoute(window.location));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const addToast = useCallback((message: string) => {
    setToasts((prev) => [...prev, { id: generateToastId(), message }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const [constraints, patchConstraints] = useConstraintTimer(
    {
      secondsRemaining: 3600,
      tokensRemaining: 50000,
      interactionsRemaining: 30,
      maxTokens: 50000,
      maxInteractions: 30,
      timeLimitSeconds: 3600,
    },
    addToast,
  );

  useEffect(() => {
    if (reviewSessionId || assessmentToken || adminRoute) {
      return;
    }
    getWebContainer()
      .then((wc) => {
        wcRef.current = wc;
        executorRef.current = new ToolExecutor(wc, (chunk) => terminalRef.current?.write(chunk));
      })
      .catch(() => { });
  }, [reviewSessionId, assessmentToken, adminRoute]);

  // Restore persisted session on page load (assessment sessions only).
  useEffect(() => {
    if (assessmentToken || reviewSessionId || adminRoute) return;
    if (hasAttemptedSavedSessionRestoreRef.current) return;
    hasAttemptedSavedSessionRestoreRef.current = true;

    const saved = loadSession();
    if (!saved) return;

    setBootstrappingSession(true);
    void validateSession(saved.sessionId, saved.sessionToken).then((validation) => {
      if (!validation) {
        clearSession();
        setBootstrappingSession(false);
        setAppState('setup');
        return;
      }
      setSessionId(saved.sessionId);
      setSessionToken(saved.sessionToken);
      setActivePrompt(saved.prompt);
      setAgentConfig(undefined);
      setAgentSummary(validation.agent ?? null);
      setBranches(validation.branches ?? (validation.branch ? [validation.branch] : []));
      setActiveBranchId(saved.branchId ?? validation.branch?.id ?? validation.branches?.[0]?.id ?? null);
      setAgentMode('build');
      setLatestPlanPath(null);
      setSubmitConfirmationOpen(false);
      if (validation.status === 'submitted') {
        setSubmittedStats(validation.stats);
        setBootstrappingSession(false);
        setAppState('submitted');
        return;
      }
      patchConstraints(validation.constraints);
      setSubmittedStats(null);
      setAppState('active');
      void restoreFiles(
        saved.sessionId,
        saved.sessionToken,
        saved.branchId ?? validation.branch?.id ?? validation.branches?.[0]?.id,
      )
        .then(applyRestoredWorkspaceState)
        .finally(() => {
          setBootstrappingSession(false);
        });
    });
  }, [applyRestoredWorkspaceState, patchConstraints]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSessionReady = useCallback((session: DevSession) => {
    const optimisticBranch: PersistedBranchSummary = {
      id: 'main',
      name: 'main',
      created_at: Date.now(),
    };
    setSessionId(session.sessionId);
    setSessionToken(session.sessionToken);
    setAgentConfig(session.agentConfig);
    setAgentSummary({ provider: session.agentConfig.provider, model: session.agentConfig.model });
    setAgentMode('build');
    setActivePrompt(session.prompt);
    setBranches([optimisticBranch]);
    setActiveBranchId(optimisticBranch.id);
    setLatestPlanPath(null);
    setActiveWorkspaceSection('code');
    setSubmittedStats(null);
    setSubmitConfirmationOpen(false);
    setAppState('active');
    void validateSession(session.sessionId, session.sessionToken).then((validation) => {
      if (!validation) {
        clearSession();
        setSessionId(null);
        setSessionToken(undefined);
        setActivePrompt(null);
        setAgentSummary(null);
        setAppState('setup');
        return;
      }
      setAgentSummary(validation.agent ?? null);
      setBranches(validation.branches ?? (validation.branch ? [validation.branch] : []));
      const nextBranchId = validation.branch?.id ?? validation.branches?.[0]?.id ?? optimisticBranch.id;
      setActiveBranchId(nextBranchId);
      if (validation.status === 'submitted') {
        setSubmittedStats(validation.stats);
        setAppState('submitted');
        return;
      }
      patchConstraints(validation.constraints);
      setSubmittedStats(null);
      void restoreFiles(session.sessionId, session.sessionToken, nextBranchId ?? undefined).then(applyRestoredWorkspaceState);
    });
  }, [applyRestoredWorkspaceState, patchConstraints]);

  useEffect(() => {
    if (!sessionId || !sessionToken || !activePrompt) {
      return;
    }
    saveSession({
      sessionId,
      sessionToken,
      prompt: activePrompt,
      ...(activeBranchId ? { branchId: activeBranchId } : {}),
    });
  }, [activeBranchId, activePrompt, sessionId, sessionToken]);

  useEffect(() => {
    if (!sessionId || !sessionToken || !activeBranchId || appState !== 'active') {
      return;
    }

    const scheduleSnapshot = () => {
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current);
      }
      snapshotTimerRef.current = window.setTimeout(() => {
        void snapshotWorkspace('draft');
      }, 1000);
    };

    let stopWatch: (() => void) | undefined;
    void watchFiles('/', (_event, filename) => {
      const changedPath = typeof filename === 'string' ? filename : '';
      if (!changedPath) {
        return;
      }
      scheduleSnapshot();
    }).then((stop) => {
      stopWatch = stop;
    });

    const handleBeforeUnload = () => {
      void snapshotWorkspace('draft');
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      stopWatch?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [activeBranchId, appState, sessionId, sessionToken, snapshotWorkspace]);

  const handleBranchChange = useCallback((branchId: string) => {
    if (
      !sessionId ||
      !sessionToken ||
      branchId === activeBranchId ||
      restoringBranchIdRef.current === branchId
    ) {
      return;
    }

    restoringBranchIdRef.current = branchId;
    setActiveBranchId(branchId);
    void restoreFiles(sessionId, sessionToken, branchId)
      .then((restored) => {
        applyRestoredWorkspaceState(restored);
      })
      .finally(() => {
        restoringBranchIdRef.current = null;
      });
  }, [activeBranchId, applyRestoredWorkspaceState, sessionId, sessionToken]);

  const handleSaveCheckpoint = useCallback(async (label: string) => {
    if (!sessionId || !sessionToken || !activeBranchId) {
      return;
    }
    await snapshotWorkspace('draft');
    await fetch(`/api/sessions/${sessionId}/checkpoints`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        branch_id: activeBranchId,
        label,
      }),
    });
  }, [activeBranchId, sessionId, sessionToken, snapshotWorkspace]);

  const handleRewind = useCallback(async (turnSequence: number, mode: 'code' | 'both') => {
    if (!sessionId || !sessionToken || !activeBranchId) return;

    if (mode === 'both') {
      const res = await fetch(`/api/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ branch_id: activeBranchId, turn_sequence: turnSequence }),
      });
      if (!res.ok) {
        throw new Error(`Rewind failed: ${res.status}`);
      }
    }

    const restored = await restoreFiles(sessionId, sessionToken, activeBranchId, '', turnSequence);
    applyRestoredWorkspaceState(restored);
  }, [activeBranchId, applyRestoredWorkspaceState, sessionId, sessionToken]);

  const handleCreateBranch = useCallback(async (name: string, turnSequence: number, conversationId?: string) => {
    if (!sessionId || !sessionToken || !activeBranchId) {
      return;
    }
    const response = await fetch(`/api/sessions/${sessionId}/branches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        branch_id: activeBranchId,
        name,
        forked_from_sequence: turnSequence,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error('Failed to create branch');
    }
    const data = await response.json() as {
      branch: PersistedBranchSummary;
      branches: PersistedBranchSummary[];
    };
    setBranches(data.branches);
    handleBranchChange(data.branch.id);
  }, [activeBranchId, handleBranchChange, sessionId, sessionToken]);

  const handleExecuteTools = useCallback(
    async (calls: LocalToolCall[]): Promise<LocalToolResult[]> => {
      const wc = wcRef.current;
      if (!wc) {
        return calls.map((c) => ({
          tool_call_id: c.id,
          name: c.name,
          output: 'WebContainer not ready',
          is_error: true,
        }));
      }
      if (!executorRef.current) {
        executorRef.current = new ToolExecutor(wc, (chunk) => terminalRef.current?.write(chunk));
      }
      return executorRef.current.executeAll(calls as any) as Promise<LocalToolResult[]>;
    },
    [],
  );

  const handleStopTools = useCallback(() => {
    const running = executorRef.current?.getRunningProcessIds() ?? [];
    executorRef.current?.stopProcesses(running);
  }, []);

  const handleOpenReviewDebug = useCallback(() => {
    if (!sessionId) {
      return;
    }
    window.open(`/review/${sessionId}`, '_blank', 'noopener,noreferrer');
  }, [sessionId]);

  const handleViewPrompt = useCallback(async () => {
    if (!activePrompt) return;
    
    const content = `# ${activePrompt.title}\n\n${activePrompt.description || 'No description provided.'}\n\n${activePrompt.tags?.map(t => `\`${t}\``).join(' ') || ''}`;
    
    try {
      await writeFile('instructions.md', content);
      setFileToOpen(`instructions.md-${Date.now()}`);
    } catch (err) {
      addToast('Failed to open instructions');
    }
  }, [activePrompt, addToast]);

  const handlePlanGenerated = useCallback((path: string) => {
    setLatestPlanPath(path);
    setFileToOpen(`${path}-${Date.now()}`);
  }, []);

  const handleOpenWorkspaceFile = useCallback((path: string) => {
    setActiveWorkspaceSection('code');
    setFileToOpen(`${path}-${Date.now()}`);
  }, []);

  const handleApprovePlan = useCallback(async (path: string) => {
    const plan = await readFile(path);
    return [
      `Implement the approved plan from \`${path}\`.`,
      '',
      'Follow the plan closely, but adapt if the repository requires a small correction.',
      '',
      plan,
    ].join('\n');
  }, []);

  const handleOpenSubmitConfirmation = useCallback(() => {
    if (!sessionId || chatLoading || submittingTask || appState !== 'active') {
      return;
    }
    setSubmitConfirmationOpen(true);
  }, [appState, chatLoading, sessionId, submittingTask]);

  const handleSubmitTask = useCallback(async () => {
    if (!sessionId || !sessionToken || chatLoading || submittingTask) {
      return;
    }

    setSubmittingTask(true);

    try {
      const response = await fetch(`/api/sessions/${sessionId}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = await response.json() as { error?: string };
          message = body.error ?? message;
        } catch {
          // Ignore non-JSON responses.
        }
        throw new Error(message);
      }

      const validation = await validateSession(sessionId, sessionToken);
      if (!validation || validation.status !== 'submitted') {
        throw new Error('Submitted state could not be loaded');
      }

      setSubmitConfirmationOpen(false);
      setSubmittedStats(validation.stats);
      setAppState('submitted');
    } catch (error) {
      addToast(
        error instanceof Error ? `Failed to submit task: ${error.message}` : 'Failed to submit task',
      );
    } finally {
      setSubmittingTask(false);
    }
  }, [addToast, chatLoading, sessionId, sessionToken, submittingTask]);

  if (reviewSessionId) {
    return (
      <ReviewDashboard
        sessionId={reviewSessionId}
        isDark={isDark}
        onToggleTheme={() => setIsDark(!isDark)}
      />
    );
  }

  if (assessmentToken) {
    return (
      <AssessmentLinkLoader
        token={assessmentToken}
        onConsumed={(
          {
            sessionId: nextSessionId,
            sessionToken: nextSessionToken,
            prompt,
            agent,
          }: { sessionId: string; sessionToken: string; prompt: PromptSummary; agent?: AgentSummary },
        ) => {
          const consumedKey = `${nextSessionId}:${nextSessionToken}`;
          if (latestConsumedAssessmentSessionRef.current === consumedKey) {
            return;
          }
          latestConsumedAssessmentSessionRef.current = consumedKey;

          saveSession({ sessionId: nextSessionId, sessionToken: nextSessionToken, prompt });
          setSessionId(nextSessionId);
          setSessionToken(nextSessionToken);
          setAgentConfig(undefined);
          setAgentSummary(agent ?? null);
          setAgentMode('build');
          setActivePrompt(prompt);
          setBranches([]);
          setActiveBranchId(null);
          setLatestPlanPath(null);
          setAssessmentToken(null);
          window.history.replaceState({}, '', '/');
          setBootstrappingSession(true);
          void validateSession(nextSessionId, nextSessionToken).then((validation) => {
            if (!validation) {
              clearSession();
              setSessionId(null);
              setSessionToken(undefined);
              setActivePrompt(null);
              setAgentSummary(null);
              setBootstrappingSession(false);
              setAppState('setup');
              return;
            }
            if (validation.status === 'submitted') {
              setAgentSummary(validation.agent ?? null);
              setBranches(validation.branches ?? (validation.branch ? [validation.branch] : []));
              setActiveBranchId(validation.branch?.id ?? validation.branches?.[0]?.id ?? null);
              setSubmittedStats(validation.stats);
              setBootstrappingSession(false);
              setAppState('submitted');
              return;
            }
            setAgentSummary(validation.agent ?? null);
            setBranches(validation.branches ?? (validation.branch ? [validation.branch] : []));
            setActiveBranchId(validation.branch?.id ?? validation.branches?.[0]?.id ?? null);
            patchConstraints(validation.constraints);
            setSubmittedStats(null);
            setAppState('active');
            void restoreFiles(
              nextSessionId,
              nextSessionToken,
              validation.branch?.id ?? validation.branches?.[0]?.id,
            )
              .then(applyRestoredWorkspaceState)
              .finally(() => {
                setBootstrappingSession(false);
              });
          });
        }}
      />
    );
  }

  if (bootstrappingSession) {
    return (
      <div
        className="h-screen flex items-center justify-center px-6"
        style={{ background: 'var(--color-bg-app)' }}
      >
        <div
          className="max-w-md rounded-2xl px-5 py-4 text-sm"
          style={{ background: 'var(--color-bg-panel)', color: 'var(--color-text-main)' }}
        >
          Resuming your session…
        </div>
      </div>
    );
  }

  if (adminRoute) {
    return (
      <AdminDashboard
        isDark={isDark}
        onToggleTheme={() => setIsDark(!isDark)}
      />
    );
  }

  if (appState === 'setup') {
    return (
      <div className="flex h-screen overflow-hidden bg-[var(--color-bg-app)]">
        <DevSetup onSessionReady={handleSessionReady} />
        <Toast toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--color-bg-app)] p-[5px] gap-[5px]">
      <TopBar
        secondsRemaining={constraints.secondsRemaining}
        tokensRemaining={constraints.tokensRemaining}
        interactionsRemaining={constraints.interactionsRemaining}
        maxTokens={constraints.maxTokens}
        maxInteractions={constraints.maxInteractions}
        isDark={isDark}
        onToggleTheme={() => setIsDark(!isDark)}
        onViewPrompt={activePrompt ? handleViewPrompt : undefined}
        onOpenReviewDebug={ENABLE_DEV_REVIEW_SHORTCUT && sessionId ? handleOpenReviewDebug : undefined}
        onSubmitTask={sessionId ? handleOpenSubmitConfirmation : undefined}
        submitDisabled={!sessionId || chatLoading || submittingTask}
        submittingTask={submittingTask}
      />

      <div className="flex min-h-0 min-w-0 flex-1 gap-[5px]">
        <Sidebar activeSection={activeWorkspaceSection} onSelect={setActiveWorkspaceSection} />
        
        <div className="min-h-0 min-w-0 flex-1">
          <SplitPane
            left={
              <div className="h-full">
                <div className={activeWorkspaceSection === 'code' ? 'h-full' : 'hidden'}>
                  <IdePanel
                    terminalRef={terminalRef}
                    requestOpenFile={fileToOpen}
                    onActiveFileChange={setActiveFilePath}
                  />
                </div>
                <div className={activeWorkspaceSection === 'database' ? 'h-full' : 'hidden'}>
                  <DatabasePanel onOpenSetupFile={handleOpenWorkspaceFile} />
                </div>
                <div
                  className={activeWorkspaceSection === 'git' ? 'h-full' : 'hidden'}
                  style={{ background: 'var(--color-bg-code)', color: 'var(--color-text-dim)' }}
                >
                  <div className="flex h-full items-center justify-center px-6 text-sm">
                    Git tools are not available yet.
                  </div>
                </div>
              </div>
            }
            right={
              <ChatPanel
                sessionId={sessionId}
                sessionToken={sessionToken}
                agentConfig={agentConfig}
                modelLabel={agentSummary?.model}
                mode={agentMode}
                onModeChange={setAgentMode}
                latestPlanPath={latestPlanPath}
                onPlanGenerated={handlePlanGenerated}
                onApprovePlan={handleApprovePlan}
                branches={branches}
                activeBranchId={activeBranchId}
                onBranchChange={handleBranchChange}
                onSaveCheckpoint={handleSaveCheckpoint}
                onCreateBranch={handleCreateBranch}
                onRewind={handleRewind}
                activeFilePath={activeFilePath}
                onTurnComplete={(turnSequence) => {
                  void snapshotWorkspace('turn', { turnSequence });
                }}
                onExecuteTools={handleExecuteTools}
                onStopTools={handleStopTools}
                constraints={{
                  tokensRemaining: constraints.tokensRemaining,
                  maxTokens: constraints.maxTokens,
                  interactionsRemaining: constraints.interactionsRemaining,
                  maxInteractions: constraints.maxInteractions,
                }}
                onConstraintsUpdate={(updated) => {
                  const patch: Partial<typeof constraints> = {};
                  if (updated.tokensRemaining !== undefined) {
                    patch.tokensRemaining = updated.tokensRemaining;
                  }
                  if (updated.interactionsRemaining !== undefined) {
                    patch.interactionsRemaining = updated.interactionsRemaining;
                  }
                  patchConstraints(patch);
                }}
                onLoadingChange={setChatLoading}
              />
            }
          />
        </div>
      </div>

      <Toast toasts={toasts} onDismiss={dismissToast} />
      {submitConfirmationOpen ? (
        <AssessmentSubmittedModal
          mode="confirm"
          promptTitle={activePrompt?.title ?? null}
          submitting={submittingTask}
          onCancel={() => {
            if (!submittingTask) {
              setSubmitConfirmationOpen(false);
            }
          }}
          onConfirm={() => void handleSubmitTask()}
        />
      ) : null}
      {appState === 'submitted' && submittedStats ? (
        <AssessmentSubmittedModal
          mode="submitted"
          promptTitle={activePrompt?.title ?? null}
          stats={submittedStats}
          onDone={() => {
            clearSession();
            setSessionId(null);
            setSessionToken(undefined);
            setAgentConfig(undefined);
            setActivePrompt(null);
            setSubmittedStats(null);
            setSubmitConfirmationOpen(false);
            setAppState('setup');
          }}
        />
      ) : null}
    </div>
  );
}
