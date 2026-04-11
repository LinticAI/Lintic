import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AdminAssessments } from './AdminLinks.js';
import { AdminKeyContext } from './AdminKeyContext.js';
import type { AdminAssessmentLinkSummary, PromptSummary } from '@lintic/core';

const PROMPTS: PromptSummary[] = [
  { id: 'library-api', title: 'Library API', description: 'Build a catalog service.' },
];

const BASE_LINK: AdminAssessmentLinkSummary = {
  id: 'link-1',
  url: 'http://localhost:5173/assessment?token=token-1',
  prompt_id: 'library-api',
  candidate_email: 'alice@example.com',
  created_at: 1000,
  expires_at: Date.now() + 3_600_000,
  status: 'active',
  prompt: PROMPTS[0],
};

function renderWithKey(adminKey = 'admin-key') {
  return render(
    <AdminKeyContext.Provider value={{ adminKey, setAdminKey: () => {} }}>
      <AdminAssessments onNavigate={() => {}} />
    </AdminKeyContext.Provider>,
  );
}

describe('AdminAssessments delete', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  test('deletes a single assessment via the trash button', async () => {
    const links = [{ ...BASE_LINK }];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/prompts') return new Response(JSON.stringify({ prompts: PROMPTS }), { status: 200 });
      if (url === '/api/links' && method === 'GET') return new Response(JSON.stringify({ links }), { status: 200 });
      if (url === '/api/links/link-1' && method === 'DELETE') {
        links.splice(0, 1);
        return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `Unhandled ${method} ${url}` }), { status: 500 });
    }));

    renderWithKey();

    await waitFor(() => expect(screen.getByTestId('admin-link-row-link-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('admin-link-delete-link-1'));

    await waitFor(() => expect(screen.queryByTestId('admin-link-row-link-1')).not.toBeInTheDocument());
  });

  test('selects a row by clicking it and batch deletes via Delete N button', async () => {
    const links = [
      { ...BASE_LINK, id: 'link-1', candidate_email: 'a@a.com' },
      { ...BASE_LINK, id: 'link-2', candidate_email: 'b@b.com' },
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/prompts') return new Response(JSON.stringify({ prompts: PROMPTS }), { status: 200 });
      if (url === '/api/links' && method === 'GET') return new Response(JSON.stringify({ links }), { status: 200 });
      if (url === '/api/links' && method === 'DELETE') {
        const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
        for (const id of ids) { const i = links.findIndex((l) => l.id === id); if (i !== -1) links.splice(i, 1); }
        return new Response(JSON.stringify({ deleted: ids.length }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `Unhandled ${method} ${url}` }), { status: 500 });
    }));

    renderWithKey();

    await waitFor(() => expect(screen.getByTestId('admin-link-row-link-1')).toBeInTheDocument());

    // Click each row to select it
    fireEvent.click(screen.getByTestId('admin-link-row-link-1'));
    fireEvent.click(screen.getByTestId('admin-link-row-link-2'));

    // Delete N button should appear
    await waitFor(() => expect(screen.getByTestId('admin-links-delete-selected')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('admin-links-delete-selected'));

    await waitFor(() => {
      expect(screen.queryByTestId('admin-link-row-link-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('admin-link-row-link-2')).not.toBeInTheDocument();
    });
  });

  test('select-all checkbox selects every row', async () => {
    const links = [
      { ...BASE_LINK, id: 'link-1', candidate_email: 'a@a.com' },
      { ...BASE_LINK, id: 'link-2', candidate_email: 'b@b.com' },
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/prompts') return new Response(JSON.stringify({ prompts: PROMPTS }), { status: 200 });
      if (url === '/api/links' && method === 'GET') return new Response(JSON.stringify({ links }), { status: 200 });
      if (url === '/api/links' && method === 'DELETE') {
        const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
        for (const id of ids) { const i = links.findIndex((l) => l.id === id); if (i !== -1) links.splice(i, 1); }
        return new Response(JSON.stringify({ deleted: ids.length }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `Unhandled ${method} ${url}` }), { status: 500 });
    }));

    renderWithKey();

    await waitFor(() => expect(screen.getByTestId('admin-link-row-link-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('admin-links-select-all'));

    await waitFor(() => expect(screen.getByTestId('admin-links-delete-selected')).toBeInTheDocument());
    expect(screen.getByTestId('admin-links-delete-selected')).toHaveTextContent('Delete 2');
  });
});
