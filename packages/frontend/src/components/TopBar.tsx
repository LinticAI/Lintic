interface TopBarProps {
  secondsRemaining: number;
  tokensRemaining: number;
  interactionsRemaining: number;
  maxTokens: number;
  maxInteractions: number;
}

function formatTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function TopBar({
  secondsRemaining,
  tokensRemaining,
  interactionsRemaining,
  maxTokens,
  maxInteractions,
}: TopBarProps) {
  const tokenPct = maxTokens > 0 ? (tokensRemaining / maxTokens) * 100 : 0;
  const isLowTime = secondsRemaining < 300;
  const isLowTokens = tokenPct < 20;

  return (
    <header className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0 gap-4 flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-blue-400 font-semibold text-sm tracking-wide">Lintic</span>
      </div>

      <div className="flex items-center gap-6 flex-wrap">
        {/* Session timer */}
        <div className="flex items-center gap-1.5" title="Time remaining">
          <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span
            className={`text-sm font-mono tabular-nums ${isLowTime ? 'text-red-400 font-bold' : 'text-gray-200'}`}
            data-testid="timer"
          >
            {formatTime(secondsRemaining)}
          </span>
        </div>

        {/* Token budget */}
        <div className="flex items-center gap-2" title="Token budget remaining">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-400">Tokens</span>
              <span
                className={`text-xs font-mono tabular-nums ${isLowTokens ? 'text-yellow-400' : 'text-gray-200'}`}
                data-testid="tokens-remaining"
              >
                {tokensRemaining.toLocaleString()}
              </span>
            </div>
            <div className="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${isLowTokens ? 'bg-yellow-400' : 'bg-blue-500'}`}
                style={{ width: `${Math.min(100, tokenPct)}%` }}
                data-testid="token-bar"
              />
            </div>
          </div>
        </div>

        {/* Interaction count */}
        <div className="flex items-center gap-1.5" title="Interactions remaining">
          <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span className="text-xs text-gray-400">Interactions</span>
          <span
            className="text-sm font-mono tabular-nums text-gray-200"
            data-testid="interactions-remaining"
          >
            {interactionsRemaining}
            <span className="text-gray-500">/{maxInteractions}</span>
          </span>
        </div>
      </div>
    </header>
  );
}
