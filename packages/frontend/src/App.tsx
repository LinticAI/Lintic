import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { SplitPane } from './components/SplitPane.js';
import { IdePanel } from './components/IdePanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import type { AgentConfig } from './components/ChatPanel.js';
import { DevSetup } from './components/DevSetup.js';
import type { DevSession } from './components/DevSetup.js';
import { Toast } from './components/Toast.js';
import type { ToastMessage } from './components/Toast.js';
import { useConstraintTimer } from './lib/useConstraintTimer.js';
import { ToolExecutor } from './lib/tool-executor.js';
import { getWebContainer, writeFile } from './lib/webcontainer.js';
import type { WebContainer } from '@webcontainer/api';
import type { LocalToolCall, LocalToolResult } from './components/ToolActionCard.js';
import type { TerminalHandle } from './components/Terminal.js';
import { ReviewDashboard } from './components/ReviewDashboard.js';
import { getReviewSessionId } from './lib/review-replay.js';
import { AssessmentLinkLoader } from './components/AssessmentLinkLoader.js';
import { AdminDashboard } from './components/admin/AdminDashboard.js';
import type { PromptSummary } from '@lintic/core';

type AppState = 'setup' | 'active';
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
  const [activePrompt, setActivePrompt] = useState<PromptSummary | null>(null);
  const [fileToOpen, setFileToOpen] = useState<string | null>(null);
  const wcRef = useRef<WebContainer | null>(null);
  const executorRef = useRef<ToolExecutor | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isDark, setIsDark] = useState(true);

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

  const handleSessionReady = useCallback((session: DevSession) => {
    setSessionId(session.sessionId);
    setSessionToken(session.sessionToken);
    setAgentConfig(session.agentConfig);
    setActivePrompt(session.prompt);
    setAppState('active');
  }, []);

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
          }: { sessionId: string; sessionToken: string; prompt: PromptSummary },
        ) => {
          setSessionId(nextSessionId);
          setSessionToken(nextSessionToken);
          setAgentConfig(undefined);
          setActivePrompt(prompt);
          setAssessmentToken(null);
          setAppState('active');
          window.history.replaceState({}, '', '/');
        }}
      />
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
      />

      <div className="flex-1 flex min-h-0 gap-[5px]">
        <Sidebar />
        
        <div className="flex-1 min-h-0">
          <SplitPane
            left={<IdePanel terminalRef={terminalRef} requestOpenFile={fileToOpen} />}
            right={
              <ChatPanel
                sessionId={sessionId}
                sessionToken={sessionToken}
                agentConfig={agentConfig}
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
              />
            }
          />
        </div>
      </div>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
