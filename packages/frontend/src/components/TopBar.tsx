interface TopBarProps {
  secondsRemaining: number;
  tokensRemaining: number;
  interactionsRemaining: number;
  maxTokens: number;
  maxInteractions: number;
  isDark: boolean;
  onToggleTheme: () => void;
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
  isDark,
  onToggleTheme,
}: TopBarProps) {
  const tokenPct = maxTokens > 0 ? (tokensRemaining / maxTokens) * 100 : 0;
  const isLowTime = secondsRemaining < 300;
  const isCriticalTokens = tokenPct <= 10;
  const isLowTokens = tokenPct <= 20;

  return (
    <header
      className="flex items-center justify-between px-4 shrink-0 gap-4"
      style={{ height: '44px', borderBottom: '1px solid var(--color-border-main)' }}
    >
      {/* Logo + brand */}
      <div className="flex items-center gap-2 min-w-0">
        <img
          src={isDark ? "/logo-dark.png" : "/logo-light.png"}
          alt="Lintic logo"
          className="h-5 w-auto shrink-0"
        />
        <span
          className="text-sm font-semibold tracking-wide"
          style={{ fontFamily: 'Gabarito, sans-serif', color: 'var(--color-text-bold)' }}
        >
          Lintic
        </span>
      </div>

      {/* Constraints */}
      <div className="flex items-center gap-5 flex-wrap">
        
        {/* Theme Toggle */}
        <button
          onClick={onToggleTheme}
          className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {isDark ? (
            <svg className="w-4 h-4 text-orange-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-slate-500" fill="currentColor" viewBox="0 0 20 20">
              <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
            </svg>
          )}
        </button>

        {/* Timer */}
        <div className="flex items-center gap-1.5" title="Time remaining">
          <svg
            className="w-3 h-3 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span
            className={`text-xs font-mono tabular-nums ${isLowTime ? 'text-red-400 font-bold' : ''}`}
            style={!isLowTime ? { color: 'var(--color-text-main)' } : undefined}
            data-testid="timer"
          >
            {formatTime(secondsRemaining)}
          </span>
        </div>

        {/* Token budget */}
        <div className="flex items-center gap-2" title="Token budget remaining">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
                Tokens
              </span>
              <span
                className={`text-[10px] font-mono tabular-nums ${isCriticalTokens ? 'text-red-400' : isLowTokens ? 'text-yellow-400' : ''}`}
                style={!isLowTokens ? { color: 'var(--color-text-main)' } : undefined}
                data-testid="tokens-remaining"
              >
                {tokensRemaining.toLocaleString()}
              </span>
            </div>
            <div className="w-20 h-[2px] rounded-full overflow-hidden" style={{ background: 'var(--color-bg-bar-empty)' }}>
              <div
                className={`h-full rounded-full transition-all duration-300 ${isCriticalTokens ? 'bg-red-400' : isLowTokens ? 'bg-yellow-400' : ''}`}
                style={
                  !isLowTokens
                    ? { width: `${Math.min(100, tokenPct)}%`, background: 'var(--color-status-success)' }
                    : { width: `${Math.min(100, tokenPct)}%` }
                }
                data-testid="token-bar"
              />
            </div>
          </div>
        </div>

        {/* Interactions */}
        <div className="flex items-center gap-1.5" title="Interactions remaining">
          <svg
            className="w-3 h-3 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span
            className="text-xs font-mono tabular-nums"
            style={{ color: 'var(--color-text-main)' }}
            data-testid="interactions-remaining"
          >
            {interactionsRemaining}
            <span style={{ color: 'var(--color-text-muted)' }}>/{maxInteractions}</span>
          </span>
        </div>
      </div>
    </header>
  );
}
