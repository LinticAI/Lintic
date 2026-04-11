interface TopBarProps {
  secondsRemaining: number;
  tokensRemaining: number;
  interactionsRemaining: number;
  maxTokens: number;
  maxInteractions: number;
  isDark: boolean;
  onToggleTheme: () => void;
  onViewPrompt?: () => void;
  onOpenReviewDebug?: () => void;
  onSubmitTask?: () => void;
  submitDisabled?: boolean;
  submittingTask?: boolean;
  showAutoSubmitWarning?: boolean;
  taskName?: string;
  deliverables?: string;
}

function formatTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')} min`;
}

export function TopBar({
  secondsRemaining,
  onViewPrompt,
  onOpenReviewDebug,
  onSubmitTask,
  submitDisabled = false,
  submittingTask = false,
  showAutoSubmitWarning = false,
  isDark,
  taskName = 'Library Backend Service',
  deliverables = 'PRD + Implementation',
}: TopBarProps) {
  return (
    <header className="shrink-0 px-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 py-3 min-[1200px]:flex-nowrap">
        {/* Logo and Branding */}
        <div className="flex shrink-0 items-center gap-3 pl-2 pr-2 min-[1200px]:pr-6">
          <img 
            src={isDark ? "/logo-dark.png" : "/logo-light.png"} 
            alt="Lintic" 
            className="w-8 h-8 object-contain"
          />
          <span className="text-white font-bold text-xl tracking-tight">Lintic</span>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 rounded-[var(--assessment-radius-shell)] border border-white/5 bg-[#111111] px-4 py-2 shadow-2xl min-[1200px]:flex-nowrap min-[1200px]:pl-8 min-[1200px]:pr-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2 min-[1200px]:mr-10 min-[1200px]:gap-12">
            <div className="flex min-w-0 items-center gap-3 min-[1200px]:gap-4">
              <span className="text-[13px] text-[#555555] font-medium">Task:</span>
              <span className="min-w-0 truncate text-[13px] font-bold text-white">{taskName}</span>
            </div>
            <div className="flex min-w-0 items-center gap-3 min-[1200px]:gap-4">
              <span className="text-[13px] text-[#555555] font-medium">Deliverables:</span>
              <span className="min-w-0 truncate text-[13px] font-bold text-white">{deliverables}</span>
            </div>
          </div>

          {onViewPrompt ? (
            <button
              type="button"
              data-1p-ignore
              data-testid="view-prompt"
              onClick={onViewPrompt}
              className="flex shrink-0 items-center gap-2 rounded-[var(--assessment-radius-control)] border border-white/5 bg-[#1A1A1A] px-4 py-2.5 text-[13px] font-bold tracking-tight text-[#3887ce] shadow-lg transition-all hover:brightness-125 min-[1200px]:px-5"
            >
              View full prompt
            </button>
          ) : null}

          {onOpenReviewDebug ? (
            <button
              type="button"
              data-testid="open-review-debug"
              onClick={onOpenReviewDebug}
              className="flex shrink-0 items-center gap-2 rounded-[var(--assessment-radius-control)] border border-white/5 bg-[#1A1A1A] px-4 py-2.5 text-[13px] font-bold tracking-tight text-[#90b8d8] shadow-lg transition-all hover:brightness-125 min-[1200px]:px-5"
            >
              Open review
            </button>
          ) : null}
        </div>

        {/* Time & Submit */}
        <div className="flex shrink-0 items-center gap-4 pr-2 min-[1200px]:gap-10 min-[1200px]:pr-4">
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-[#555555] font-medium tracking-tight">Time remaining:</span>
            <span data-testid="timer" className="text-[15px] text-white font-bold tabular-nums">
              {formatTime(secondsRemaining)}
            </span>
            {showAutoSubmitWarning ? (
              <span
                data-testid="auto-submit-warning"
                className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold tracking-tight text-amber-200"
              >
                Auto-submit at 0:00
              </span>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="submit-task"
            onClick={onSubmitTask}
            disabled={submitDisabled || !onSubmitTask}
            className="flex items-center gap-2 rounded-[var(--assessment-radius-control)] border border-[#10B981]/10 bg-[#064E3B] px-5 py-2.5 text-[13px] font-bold tracking-tight text-[#10B981] shadow-lg transition-all hover:brightness-110 min-[1200px]:px-7"
            style={{
              opacity: submitDisabled || !onSubmitTask ? 0.5 : 1,
              cursor: submitDisabled || !onSubmitTask ? 'not-allowed' : 'pointer',
            }}
          >
            {submittingTask ? 'Submitting...' : 'Submit task'}
          </button>
        </div>
      </div>
    </header>
  );
}
