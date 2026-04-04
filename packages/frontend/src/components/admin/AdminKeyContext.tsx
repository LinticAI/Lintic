import { createContext, useContext, useState, type ReactNode } from 'react';

interface AdminKeyContextValue {
  adminKey: string;
  setAdminKey: (key: string) => void;
}

const AdminKeyContext = createContext<AdminKeyContextValue>({
  adminKey: '',
  setAdminKey: () => {},
});

export function AdminKeyProvider({ children }: { children: ReactNode }) {
  const [adminKey, setAdminKeyState] = useState<string>(() => {
    try {
      return localStorage.getItem('lintic_admin_key') ?? '';
    } catch {
      return '';
    }
  });

  function setAdminKey(key: string) {
    setAdminKeyState(key);
    try {
      if (key) {
        localStorage.setItem('lintic_admin_key', key);
      } else {
        localStorage.removeItem('lintic_admin_key');
      }
    } catch {
      // ignore
    }
  }

  return (
    <AdminKeyContext.Provider value={{ adminKey, setAdminKey }}>
      {children}
    </AdminKeyContext.Provider>
  );
}

export function useAdminKey() {
  return useContext(AdminKeyContext);
}

export async function fetchAdminJson<T>(
  url: string,
  adminKey: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('X-Lintic-Api-Key', adminKey);

  const response = await fetch(url, { ...init, headers });
  const raw = await response.text();

  let body: T & { error?: string };
  try {
    body = JSON.parse(raw) as T & { error?: string };
  } catch {
    throw new Error(`Unexpected non-JSON response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  return body;
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.cssText = 'position:absolute;opacity:0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
