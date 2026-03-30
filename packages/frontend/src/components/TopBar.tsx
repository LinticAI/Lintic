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
    <header
      className="flex items-center justify-between px-4 shrink-0 gap-4"
      style={{ height: '44px' }}
    >
      {/* Logo + brand */}
      <div className="flex items-center gap-2 min-w-0">
        <img
          src="/logo.png"
          alt="Lintic logo"
          className="h-5 w-auto shrink-0"
          style={{ filter: 'invert(1) brightness(4)', mixBlendMode: 'screen' }}
        />
        <span
          className="text-sm font-semibold tracking-wide"
          style={{ fontFamily: 'Gabarito, sans-serif', color: '#cccccc' }}
        >
          Lintic
        </span>
      </div>

      {/* Constraints */}
      <div className="flex items-center gap-5 flex-wrap">

        {/* Timer */}
        <div className="flex items-center gap-1.5" title="Time remaining">
          <svg
            className="w-3 h-3 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            style={{ color: '#666666' }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span
            className={`text-xs font-mono tabular-nums ${isLowTime ? 'text-red-400 font-bold' : ''}`}
            style={!isLowTime ? { color: '#aaaaaa' } : undefined}
            data-testid="timer"
          >
            {formatTime(secondsRemaining)}
          </span>
        </div>

        {/* Token budget */}
        <div className="flex items-center gap-2" title="Token budget remaining">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: '#666666' }}>
                Tokens
              </span>
              <span
                className={`text-[10px] font-mono tabular-nums ${isLowTokens ? 'text-yellow-400' : ''}`}
                style={!isLowTokens ? { color: '#aaaaaa' } : undefined}
                data-testid="tokens-remaining"
              >
                {tokensRemaining.toLocaleString()}
              </span>
            </div>
            <div className="w-20 h-[2px] rounded-full overflow-hidden" style={{ background: '#1e1e1e' }}>
              <div
                className={`h-full rounded-full transition-all duration-300 ${isLowTokens ? 'bg-yellow-400' : ''}`}
                style={
                  !isLowTokens
                    ? { width: `${Math.min(100, tokenPct)}%`, background: '#2a4a6a' }
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
            style={{ color: '#666666' }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span
            className="text-xs font-mono tabular-nums"
            style={{ color: '#aaaaaa' }}
            data-testid="interactions-remaining"
          >
            {interactionsRemaining}
            <span style={{ color: '#555555' }}>/{maxInteractions}</span>
          </span>
        </div>
      </div>
    </header>
  );
}
