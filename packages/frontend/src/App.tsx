import { useCallback, useEffect, useRef, useState } from 'react';
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
import { getWebContainer } from './lib/webcontainer.js';
import type { WebContainer } from '@webcontainer/api';
import type { LocalToolCall, LocalToolResult } from './components/ToolActionCard.js';
import type { TerminalHandle } from './components/Terminal.js';

type AppState = 'setup' | 'active';

function generateToastId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function App() {
  const [appState, setAppState] = useState<AppState>('setup');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | undefined>(undefined);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | undefined>(undefined);
  const wcRef = useRef<WebContainer | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

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

  // Boot WebContainer early so it's ready when the user starts chatting.
  useEffect(() => {
    getWebContainer()
      .then((wc) => { wcRef.current = wc; })
      .catch(() => { /* WebContainer may not be available in all environments */ });
  }, []);

  const handleSessionReady = useCallback((session: DevSession) => {
    setSessionId(session.sessionId);
    setSessionToken(session.sessionToken);
    setAgentConfig(session.agentConfig);
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
      const executor = new ToolExecutor(wc, (chunk) => terminalRef.current?.write(chunk));
      // ToolExecutor.executeAll accepts ToolCall from @lintic/core; LocalToolCall is shape-compatible.
      return executor.executeAll(calls as Parameters<typeof executor.executeAll>[0]) as Promise<LocalToolResult[]>;
    },
    [],
  );

  if (appState === 'setup') {
    return (
      <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--color-bg-app)' }}>
        <DevSetup onSessionReady={handleSessionReady} />
        <Toast toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--color-bg-app)' }}>
      <TopBar
        secondsRemaining={constraints.secondsRemaining}
        tokensRemaining={constraints.tokensRemaining}
        interactionsRemaining={constraints.interactionsRemaining}
        maxTokens={constraints.maxTokens}
        maxInteractions={constraints.maxInteractions}
        isDark={isDark}
        onToggleTheme={() => setIsDark(!isDark)}
      />
      <div className="flex-1 overflow-hidden">
        <SplitPane
          left={<IdePanel terminalRef={terminalRef} />}
          right={
            <ChatPanel
              sessionId={sessionId}
              sessionToken={sessionToken}
              agentConfig={agentConfig}
              onExecuteTools={handleExecuteTools}
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
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
