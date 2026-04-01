import { useState } from 'react';
import type { AgentConfig } from './ChatPanel.js';

export interface DevSession {
  sessionId: string;
  sessionToken: string;
  agentConfig: AgentConfig;
}

interface DevSetupProps {
  apiBase?: string;
  onSessionReady: (session: DevSession) => void;
}

const PROVIDERS: { value: AgentConfig['provider']; label: string; defaultModel: string; defaultBaseUrl?: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI / OpenAI-compatible', defaultModel: 'gpt-4o' },
  { value: 'anthropic-native', label: 'Anthropic', defaultModel: 'claude-opus-4-5' },
  { value: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile', defaultBaseUrl: 'https://api.groq.com/openai' },
];

export function DevSetup({ apiBase = '', onSessionReady }: DevSetupProps) {
  const [provider, setProvider] = useState<AgentConfig['provider']>('openai-compatible');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o');
  const [baseUrl, setBaseUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleProviderChange(newProvider: AgentConfig['provider']) {
    setProvider(newProvider);
    const p = PROVIDERS.find((p) => p.value === newProvider);
    if (p) {
      setModel(p.defaultModel);
      setBaseUrl(p.defaultBaseUrl ?? '');
    }
  }

  async function handleStart() {
    if (!apiKey.trim() || !model.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${apiBase}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: 'dev', candidate_email: 'dev@lintic.local' }),
      });

      let body: { session_id?: string; token?: string; error?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new Error(`Backend unreachable (HTTP ${res.status}). Is the backend server running?`);
      }
      if (!res.ok || !body.session_id || !body.token) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const agentConfig: AgentConfig = {
        provider,
        api_key: apiKey.trim(),
        model: model.trim(),
        ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
      };

      onSessionReady({ sessionId: body.session_id, sessionToken: body.token, agentConfig });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: '#141414',
    color: '#cccccc',
    border: '1px solid #222222',
    borderRadius: '4px',
    padding: '6px 10px',
    fontSize: '12px',
    outline: 'none',
    width: '100%',
    fontFamily: 'inherit',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '10px',
    color: '#555555',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '4px',
    display: 'block',
  };

  return (
    <div
      className="flex flex-col h-full items-center justify-center px-6"
      style={{ background: '#0c0c0c' }}
      data-testid="dev-setup"
    >
      <div style={{ width: '100%', maxWidth: '360px' }}>
        <h2
          className="text-sm font-semibold mb-6 text-center uppercase tracking-widest"
          style={{ color: '#555555' }}
        >
          Dev Testing Session
        </h2>

        <div className="flex flex-col gap-4">
          {/* Provider */}
          <div>
            <label style={labelStyle}>Provider</label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as AgentConfig['provider'])}
              style={{ ...inputStyle, cursor: 'pointer' }}
              data-testid="dev-provider"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div>
            <label style={labelStyle}>API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              style={inputStyle}
              data-testid="dev-api-key"
            />
          </div>

          {/* Model */}
          <div>
            <label style={labelStyle}>Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o"
              style={inputStyle}
              data-testid="dev-model"
            />
          </div>

          {/* Base URL (optional) */}
          <div>
            <label style={labelStyle}>Base URL <span style={{ color: '#333333' }}>(optional)</span></label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com"
              style={inputStyle}
              data-testid="dev-base-url"
            />
          </div>

          {error && (
            <div
              className="text-xs px-3 py-2 rounded"
              style={{ background: '#2a1a1a', color: '#f87171' }}
              data-testid="dev-error"
            >
              {error}
            </div>
          )}

          <button
            onClick={() => void handleStart()}
            disabled={loading || !apiKey.trim() || !model.trim()}
            style={{
              background: loading || !apiKey.trim() || !model.trim() ? '#1a1a1a' : '#1e3a5a',
              color: loading || !apiKey.trim() || !model.trim() ? '#444444' : '#90b8d8',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 16px',
              fontSize: '12px',
              cursor: loading || !apiKey.trim() || !model.trim() ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              width: '100%',
            }}
            data-testid="dev-start"
          >
            {loading ? 'Creating session…' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  );
}
