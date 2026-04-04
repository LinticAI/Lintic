import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AdminLinksDashboard } from './AdminLinksDashboard.js';
import type { AdminAssessmentLinkDetail, AdminAssessmentLinkSummary, PromptSummary } from '@lintic/core';

describe('AdminLinksDashboard', () => {
  const prompts: PromptSummary[] = [
    { id: 'library-api', title: 'Library API', description: 'Build a catalog service.' },
  ];

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  test('does not fetch admin data until the admin key is submitted', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/prompts') {
        return new Response(JSON.stringify({ prompts }), { status: 200 });
      }
      if (url === '/api/links') {
        return new Response(JSON.stringify({ links: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Unhandled request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminLinksDashboard isDark={false} onToggleTheme={() => undefined} />);

    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('admin-key-input'), { target: { value: 'admin-key' } });
    fireEvent.click(screen.getByTestId('admin-key-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/prompts', expect.any(Object));
      const firstCallHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers;
      expect(firstCallHeaders).toBeInstanceOf(Headers);
      expect((firstCallHeaders as Headers).get('X-Lintic-Api-Key')).toBe('admin-key');
    });
  });

  test('loads prompts, creates a link, copies it, and inspects detail', async () => {
    const links: AdminAssessmentLinkSummary[] = [];
    const details = new Map<string, AdminAssessmentLinkDetail>();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/prompts') {
        return new Response(JSON.stringify({ prompts }), { status: 200 });
      }

      if (url === '/api/links' && method === 'GET') {
        return new Response(JSON.stringify({ links }), { status: 200 });
      }

      if (url === '/api/links' && method === 'POST') {
        const payload = JSON.parse(String(init?.body)) as { email: string; prompt_id: string };
        const detail: AdminAssessmentLinkDetail = {
          id: 'link-1',
          url: 'http://localhost:5173/assessment?token=token-1',
          token: 'token-1',
          prompt_id: payload.prompt_id,
          candidate_email: payload.email,
          created_at: 1000,
          expires_at: 2000,
          status: 'active',
          prompt: prompts[0],
          constraint: {
            max_session_tokens: 50000,
            max_message_tokens: 2000,
            max_interactions: 30,
            context_window: 8000,
            time_limit_minutes: 60,
          },
        };
        links.unshift({
          id: detail.id,
          url: detail.url,
          prompt_id: detail.prompt_id,
          candidate_email: detail.candidate_email,
          created_at: detail.created_at,
          expires_at: detail.expires_at,
          status: detail.status,
          prompt: detail.prompt,
        });
        details.set(detail.id, detail);
        return new Response(JSON.stringify(detail), { status: 201 });
      }

      if (url === '/api/links/link-1') {
        return new Response(JSON.stringify({ link: details.get('link-1') }), { status: 200 });
      }

      return new Response(JSON.stringify({ error: `Unhandled ${method} ${url}` }), { status: 500 });
    }));

    render(<AdminLinksDashboard isDark={false} onToggleTheme={() => undefined} />);

    fireEvent.change(screen.getByTestId('admin-key-input'), { target: { value: 'admin-key' } });
    fireEvent.click(screen.getByTestId('admin-key-submit'));

    await waitFor(() => {
      expect(screen.getByText('Generate link')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('candidate@example.com'), {
      target: { value: 'candidate@example.com' },
    });
    fireEvent.click(screen.getByTestId('admin-link-create'));

    await waitFor(() => {
      expect(screen.getByTestId('admin-link-row-link-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('admin-link-copy-link-1'));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'http://localhost:5173/assessment?token=token-1',
      );
    });

    fireEvent.click(screen.getByText('Inspect'));

    await waitFor(() => {
      expect(screen.getByTestId('admin-link-detail')).toHaveTextContent('token-1');
      expect(screen.getByTestId('admin-link-detail')).toHaveTextContent('"max_session_tokens": 50000');
    });
  });

  test('shows backend errors clearly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'Missing or invalid X-Lintic-Api-Key header' }), {
        status: 401,
      }),
    ));

    render(<AdminLinksDashboard isDark={false} onToggleTheme={() => undefined} />);

    fireEvent.change(screen.getByTestId('admin-key-input'), { target: { value: 'wrong-key' } });
    fireEvent.click(screen.getByTestId('admin-key-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('admin-link-error')).toHaveTextContent(
        'Missing or invalid X-Lintic-Api-Key header',
      );
    });
  });
});
