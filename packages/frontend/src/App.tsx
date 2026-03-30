import { useCallback, useState } from 'react';
import { TopBar } from './components/TopBar.js';
import { SplitPane } from './components/SplitPane.js';
import { IdePanel } from './components/IdePanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { Toast } from './components/Toast.js';
import type { ToastMessage } from './components/Toast.js';
import { useConstraintTimer } from './lib/useConstraintTimer.js';

function generateToastId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function App() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

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

  // Placeholder session ID — will be replaced when session creation (US-017) is wired in.
  const sessionId: string | null = null;

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: '#080808' }}>
      <TopBar
        secondsRemaining={constraints.secondsRemaining}
        tokensRemaining={constraints.tokensRemaining}
        interactionsRemaining={constraints.interactionsRemaining}
        maxTokens={constraints.maxTokens}
        maxInteractions={constraints.maxInteractions}
      />
      <div className="flex-1 overflow-hidden">
        <SplitPane
          left={<IdePanel />}
          right={
            <ChatPanel
              sessionId={sessionId}
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
