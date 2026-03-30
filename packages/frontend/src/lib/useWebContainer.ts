import { useEffect, useState } from 'react';
import type { WebContainer } from '@webcontainer/api';
import { getWebContainer } from './webcontainer.js';

export type WebContainerStatus = 'idle' | 'booting' | 'ready' | 'error';

export interface UseWebContainerResult {
  container: WebContainer | null;
  status: WebContainerStatus;
  error: string | null;
}

/**
 * React hook that boots (or reuses) the WebContainer singleton and returns
 * the instance together with the current boot status.
 */
export function useWebContainer(): UseWebContainerResult {
  const [container, setContainer] = useState<WebContainer | null>(null);
  const [status, setStatus] = useState<WebContainerStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('booting');

    getWebContainer()
      .then((wc) => {
        if (!cancelled) {
          setContainer(wc);
          setStatus('ready');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { container, status, error };
}
