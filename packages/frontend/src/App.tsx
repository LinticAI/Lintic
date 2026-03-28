import { TopBar } from './components/TopBar.js';
import { SplitPane } from './components/SplitPane.js';

export function App() {
  // Placeholder constraint values — will be wired to session state in later stories
  const constraintState = {
    secondsRemaining: 3600,
    tokensRemaining: 50000,
    interactionsRemaining: 30,
    maxTokens: 50000,
    maxInteractions: 30,
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <TopBar
        secondsRemaining={constraintState.secondsRemaining}
        tokensRemaining={constraintState.tokensRemaining}
        interactionsRemaining={constraintState.interactionsRemaining}
        maxTokens={constraintState.maxTokens}
        maxInteractions={constraintState.maxInteractions}
      />
      <div className="flex-1 overflow-hidden">
        <SplitPane
          left={
            <div className="h-full flex items-center justify-center bg-gray-900 text-gray-500 text-sm">
              IDE panel — Monaco Editor (US-011)
            </div>
          }
          right={
            <div className="h-full flex items-center justify-center bg-gray-900 text-gray-500 text-sm">
              Agent chat panel (US-013)
            </div>
          }
        />
      </div>
    </div>
  );
}
