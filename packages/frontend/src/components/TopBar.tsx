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
  isDark,
  taskName = 'Library Backend Service',
  deliverables = 'PRD + Implementation',
}: TopBarProps) {
  return (
    <header
      className="flex items-center justify-between px-2 shrink-0"
      style={{ height: '88px' }}
    >
      <div className="flex items-center gap-6">
        {/* Logo and Branding */}
        <div className="flex items-center gap-3 pl-2 pr-6">
          <img 
            src={isDark ? "/logo-dark.png" : "/logo-light.png"} 
            alt="Lintic" 
            className="w-8 h-8 object-contain"
          />
          <span className="text-white font-bold text-xl tracking-tight">Lintic</span>
        </div>

        <div className="flex items-center rounded-[var(--assessment-radius-shell)] bg-[#111111] border border-white/5 shadow-2xl pl-8 pr-2 py-2">
          <div className="flex items-center gap-12 mr-10">
            <div className="flex items-center gap-4">
              <span className="text-[13px] text-[#555555] font-medium">Task:</span>
              <span className="text-[13px] text-white font-bold whitespace-nowrap">{taskName}</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-[13px] text-[#555555] font-medium">Deliverables:</span>
              <span className="text-[13px] text-white font-bold whitespace-nowrap">{deliverables}</span>
            </div>
          </div>

          {onViewPrompt ? (
            <button
              type="button"
              data-1p-ignore
              data-testid="view-prompt"
              onClick={onViewPrompt}
              className="flex items-center gap-2 px-5 py-2.5 rounded-[var(--assessment-radius-control)] bg-[#1A1A1A] text-[#3887ce] text-[13px] font-bold tracking-tight hover:brightness-125 transition-all border border-white/5 shadow-lg"
            >
              View full prompt
            </button>
          ) : null}

          {onOpenReviewDebug ? (
            <button
              type="button"
              data-testid="open-review-debug"
              onClick={onOpenReviewDebug}
              className="flex items-center gap-2 px-5 py-2.5 rounded-[var(--assessment-radius-control)] bg-[#1A1A1A] text-[#90b8d8] text-[13px] font-bold tracking-tight hover:brightness-125 transition-all border border-white/5 shadow-lg"
            >
              Open review
            </button>
          ) : null}
        </div>
      </div>

      {/* Time & Submit */}
      <div className="flex items-center gap-10 pr-4">
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-[#555555] font-medium tracking-tight">Time remaining:</span>
          <span data-testid="timer" className="text-[15px] text-white font-bold tabular-nums">
            {formatTime(secondsRemaining)}
          </span>
        </div>
        <button
          type="button"
          data-testid="submit-task"
          onClick={onSubmitTask}
          disabled={submitDisabled || !onSubmitTask}
          className="flex items-center gap-2 px-7 py-2.5 rounded-[var(--assessment-radius-control)] bg-[#064E3B] text-[#10B981] text-[13px] font-bold tracking-tight hover:brightness-110 transition-all border border-[#10B981]/10 shadow-lg"
          style={{
            opacity: submitDisabled || !onSubmitTask ? 0.5 : 1,
            cursor: submitDisabled || !onSubmitTask ? 'not-allowed' : 'pointer',
          }}
        >
          {submittingTask ? 'Submitting...' : 'Submit task'}
        </button>
      </div>
    </header>
  );
}
