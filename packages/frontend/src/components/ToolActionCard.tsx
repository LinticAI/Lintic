import { useState } from 'react';

// ─── Local types (mirror @lintic/core shapes used in AgentLoopResult) ─────────

export interface LocalToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LocalToolResult {
  tool_call_id: string;
  name: string;
  output: string;
  is_error: boolean;
}

export interface LocalToolAction {
  tool_calls: LocalToolCall[];
  tool_results: LocalToolResult[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_MAX_CHARS = 500;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, OUTPUT_MAX_CHARS), truncated: true };
}

function formatParams(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}

// ─── Sub-renderers ────────────────────────────────────────────────────────────

function DiffPreview({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div data-testid="tool-action-diff" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
      {lines.map((line, i) => (
        <div key={i} style={{ color: 'var(--color-status-diff-add)', whiteSpace: 'pre' }}>
          {'+ '}{line}
        </div>
      ))}
    </div>
  );
}

function CommandOutput({ output }: { output: string }) {
  const { text, truncated } = truncate(output);
  return (
    <pre
      data-testid="tool-action-result"
      style={{
        fontFamily: 'monospace',
        fontSize: '11px',
        color: 'var(--color-text-tool-output)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: 0,
      }}
    >
      {text}
      {truncated && <span style={{ color: 'var(--color-text-dim)' }}>{'\n'}…(truncated)</span>}
    </pre>
  );
}

function DefaultOutput({ output, isError }: { output: string; isError: boolean }) {
  const { text, truncated } = truncate(output);
  return (
    <div
      data-testid="tool-action-result"
      style={{
        fontFamily: 'monospace',
        fontSize: '11px',
        color: isError ? 'var(--color-status-error-text)' : 'var(--color-text-muted)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      {text}
      {truncated && <span style={{ color: 'var(--color-text-dim)' }}> …(truncated)</span>}
    </div>
  );
}

// ─── Single tool call card ────────────────────────────────────────────────────

function SingleToolCard({ call, result }: { call: LocalToolCall; result: LocalToolResult | undefined }) {
  const [open, setOpen] = useState(false);
  const paramStr = formatParams(call.input);
  const isError = result?.is_error ?? false;

  return (
    <div
      data-testid="tool-action-card"
      style={{
        border: `1px solid ${isError ? 'var(--color-border-tool-error)' : 'var(--color-border-tool)'}`,
        borderRadius: '4px',
        overflow: 'hidden',
        marginBottom: '4px',
      }}
    >
      {/* Header — toggle */}
      <button
        data-testid="tool-action-toggle"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '4px 8px',
          background: isError ? 'var(--color-bg-tool-error)' : 'var(--color-bg-tool-header)',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontFamily: 'monospace',
          fontSize: '11px',
          color: isError ? 'var(--color-status-error-text)' : 'var(--color-text-tool-name)',
        }}
        aria-expanded={open}
      >
        <span style={{ color: 'var(--color-text-dimmest)', width: '8px', flexShrink: 0 }}>{open ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 600 }}>{call.name}</span>
        {paramStr && (
          <span style={{ color: 'var(--color-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {paramStr}
          </span>
        )}
        {isError && (
          <span
            data-testid="tool-action-error-badge"
            style={{ marginLeft: 'auto', color: 'var(--color-status-error-text)', fontSize: '10px', flexShrink: 0 }}
          >
            Error
          </span>
        )}
      </button>

      {/* Body — expandable */}
      {open && (
        <div
          data-testid="tool-action-body"
          style={{ padding: '6px 8px', background: 'var(--color-bg-tool-body)', borderTop: '1px solid var(--color-border-tool)' }}
        >
          {/* Parameters table */}
          {Object.keys(call.input).length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '6px' }}>
              <tbody>
                {Object.entries(call.input).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ fontFamily: 'monospace', fontSize: '10px', color: 'var(--color-text-dimmer)', paddingRight: '8px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {k}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '10px', color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
                      {typeof v === 'string' ? v : JSON.stringify(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Result */}
          {result !== undefined && (
            <div style={{ borderTop: '1px solid var(--color-border-tool)', paddingTop: '6px' }}>
              {call.name === 'write_file' && !isError ? (
                <DiffPreview content={result.output === 'ok' ? (call.input['content'] as string | undefined) ?? '' : result.output} />
              ) : call.name === 'run_command' || call.name === 'search_files' ? (
                <CommandOutput output={result.output} />
              ) : (
                <DefaultOutput output={result.output} isError={isError} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export function ToolActionCard({ action }: { action: LocalToolAction }) {
  return (
    <div>
      {action.tool_calls.map((call) => {
        const result = action.tool_results.find((r) => r.tool_call_id === call.id);
        return <SingleToolCard key={call.id} call={call} result={result} />;
      })}
    </div>
  );
}
