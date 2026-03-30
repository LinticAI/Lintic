import { useEffect, useState } from 'react';

export interface ToastMessage {
  id: string;
  message: string;
  /** Auto-dismiss after this many ms (default 5000) */
  duration?: number;
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function Toast({ toasts, onDismiss }: ToastProps) {
  return (
    <div
      className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }) {
  const duration = toast.duration ?? 5000;

  useEffect(() => {
    const id = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(id);
  }, [toast.id, duration, onDismiss]);

  return (
    <div
      className="pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded shadow-lg text-xs"
      style={{ background: '#1a2a1a', color: '#90d890', border: '1px solid #1e3a1e', maxWidth: '320px' }}
      role="alert"
      data-testid="toast"
    >
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span className="flex-1">{toast.message}</span>
      <button
        className="shrink-0 opacity-60 hover:opacity-100"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        style={{ pointerEvents: 'auto' }}
      >
        ×
      </button>
    </div>
  );
}
