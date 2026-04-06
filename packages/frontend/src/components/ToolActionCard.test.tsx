import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, test, expect } from 'vitest';
import { ToolActionCard } from './ToolActionCard.js';
import type { LocalToolAction } from './ToolActionCard.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<LocalToolAction> = {}): LocalToolAction {
  return {
    tool_calls: [{ id: 'tc-1', name: 'read_file', input: { path: '/app/index.ts' } }],
    tool_results: [{ tool_call_id: 'tc-1', name: 'read_file', output: 'const x = 1;', is_error: false }],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolActionCard', () => {
  test('renders a card with the tool name', () => {
    render(<ToolActionCard action={makeAction()} />);
    expect(screen.getByTestId('tool-action-card')).toBeInTheDocument();
    expect(screen.getByText('Read File:')).toBeInTheDocument();
  });

  test('shows parameter values in the header', () => {
    render(<ToolActionCard action={makeAction()} />);
    expect(screen.getByText(/\/app\/index\.ts/)).toBeInTheDocument();
  });

  test('body is collapsed by default', () => {
    render(<ToolActionCard action={makeAction()} />);
    expect(screen.queryByTestId('tool-action-body')).not.toBeInTheDocument();
  });

  test('expands body on toggle click', () => {
    render(<ToolActionCard action={makeAction()} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    expect(screen.getByTestId('tool-action-body')).toBeInTheDocument();
  });

  test('collapses body on second toggle click', () => {
    render(<ToolActionCard action={makeAction()} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    expect(screen.queryByTestId('tool-action-body')).not.toBeInTheDocument();
  });

  test('shows parameter key-value rows when expanded', () => {
    render(<ToolActionCard action={makeAction()} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    const body = screen.getByTestId('tool-action-body');
    expect(within(body).getByText('path')).toBeInTheDocument();
    expect(within(body).getByText('/app/index.ts')).toBeInTheDocument();
  });

  test('shows result when expanded', () => {
    render(<ToolActionCard action={makeAction()} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    expect(screen.getByTestId('tool-action-result')).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  test('truncates long output to 500 chars', () => {
    const longOutput = 'x'.repeat(1200);
    const action = makeAction({
      tool_results: [{ tool_call_id: 'tc-1', name: 'read_file', output: longOutput, is_error: false }],
    });
    render(<ToolActionCard action={action} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    const result = screen.getByTestId('tool-action-result');
    expect(result.textContent).toContain('x'.repeat(1000));
    expect(result.textContent).toContain('truncated');
    expect(result.textContent?.length).toBeLessThan(1200);
  });

  test('shows error badge when result is_error=true', () => {
    const action = makeAction({
      tool_results: [{ tool_call_id: 'tc-1', name: 'read_file', output: 'File not found', is_error: true }],
    });
    render(<ToolActionCard action={action} />);
    expect(screen.getByTestId('tool-action-error-badge')).toBeInTheDocument();
  });

  test('shows diff preview with + prefix for write_file', () => {
    const action: LocalToolAction = {
      tool_calls: [{ id: 'tc-2', name: 'write_file', input: { path: '/app/out.ts', content: 'line1\nline2' } }],
      tool_results: [{ tool_call_id: 'tc-2', name: 'write_file', output: 'ok', is_error: false }],
    };
    render(<ToolActionCard action={action} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    const diff = screen.getByTestId('tool-action-diff');
    expect(diff).toBeInTheDocument();
    expect(diff.textContent).toContain('+ line1');
    expect(diff.textContent).toContain('+ line2');
  });

  test('keeps wide diff previews scrollable within the tool card', () => {
    const action: LocalToolAction = {
      tool_calls: [{ id: 'tc-2', name: 'write_file', input: { path: '/app/out.ts', content: 'x'.repeat(400) } }],
      tool_results: [{ tool_call_id: 'tc-2', name: 'write_file', output: 'ok', is_error: false }],
    };
    render(<ToolActionCard action={action} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    expect(screen.getByTestId('tool-action-diff')).toHaveClass('overflow-x-auto');
  });

  test('shows run_command output in a pre block', () => {
    const action: LocalToolAction = {
      tool_calls: [{ id: 'tc-3', name: 'run_command', input: { command: 'npm test' } }],
      tool_results: [{ tool_call_id: 'tc-3', name: 'run_command', output: 'PASS 5 tests', is_error: false }],
    };
    render(<ToolActionCard action={action} />);
    fireEvent.click(screen.getByTestId('tool-action-toggle'));
    const result = screen.getByTestId('tool-action-result');
    expect(result.tagName).toBe('PRE');
    expect(result.textContent).toContain('PASS 5 tests');
    expect(result).toHaveClass('overflow-x-auto');
  });

  test('renders one card per tool call in an action', () => {
    const action: LocalToolAction = {
      tool_calls: [
        { id: 'a', name: 'read_file', input: { path: '/a.ts' } },
        { id: 'b', name: 'write_file', input: { path: '/b.ts', content: 'hello' } },
      ],
      tool_results: [
        { tool_call_id: 'a', name: 'read_file', output: 'contents', is_error: false },
        { tool_call_id: 'b', name: 'write_file', output: 'ok', is_error: false },
      ],
    };
    render(<ToolActionCard action={action} />);
    expect(screen.getAllByTestId('tool-action-card')).toHaveLength(2);
  });
});
