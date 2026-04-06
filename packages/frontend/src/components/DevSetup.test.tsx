import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { DevSetup } from './DevSetup.js';
import type { DevSession } from './DevSetup.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSessionResponse(sessionId = 'sess-1', token = 'tok-abc'): Response {
  return {
    ok: true,
    json: async () => ({
      session_id: sessionId,
      token,
      prompt: {
        id: 'dev',
        title: 'Dev Prompt',
        description: 'Build the feature.',
        tags: ['frontend'],
      },
    }),
  } as unknown as Response;
}

describe('DevSetup', () => {
  test('renders the setup form', () => {
    render(<DevSetup onSessionReady={vi.fn()} />);
    expect(screen.getByTestId('dev-setup')).toBeInTheDocument();
    expect(screen.getByTestId('dev-provider')).toBeInTheDocument();
    expect(screen.getByTestId('dev-api-key')).toBeInTheDocument();
    expect(screen.getByTestId('dev-model')).toBeInTheDocument();
    expect(screen.getByTestId('dev-base-url')).toBeInTheDocument();
    expect(screen.getByTestId('dev-start')).toBeInTheDocument();
    expect(screen.getByTestId('dev-open-review')).toBeInTheDocument();
  });

  test('Start button is disabled when api key is empty', () => {
    render(<DevSetup onSessionReady={vi.fn()} />);
    expect(screen.getByTestId('dev-start')).toBeDisabled();
  });

  test('Start button is enabled when api key and model are filled', () => {
    render(<DevSetup onSessionReady={vi.fn()} />);
    fireEvent.change(screen.getByTestId('dev-api-key'), { target: { value: 'sk-test' } });
    expect(screen.getByTestId('dev-start')).not.toBeDisabled();
  });

  test('calls onSessionReady with session details on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeSessionResponse()));
    const onReady = vi.fn();
    render(<DevSetup onSessionReady={onReady} />);

    fireEvent.change(screen.getByTestId('dev-api-key'), { target: { value: 'sk-mykey' } });
    fireEvent.click(screen.getByTestId('dev-start'));

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          sessionToken: 'tok-abc',
          agentConfig: expect.objectContaining({ api_key: 'sk-mykey' }),
          prompt: expect.objectContaining({ id: 'dev', title: 'Dev Prompt' }),
        }),
      );
    });
  });

  test('shows error message when session creation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'prompt not found' }),
    }));
    render(<DevSetup onSessionReady={vi.fn()} />);

    fireEvent.change(screen.getByTestId('dev-api-key'), { target: { value: 'sk-key' } });
    fireEvent.click(screen.getByTestId('dev-start'));

    await waitFor(() => expect(screen.getByTestId('dev-error')).toBeInTheDocument());
    expect(screen.getByText('prompt not found')).toBeInTheDocument();
  });

  test('changing provider updates the default model', () => {
    render(<DevSetup onSessionReady={vi.fn()} />);
    fireEvent.change(screen.getByTestId('dev-provider'), { target: { value: 'anthropic-native' } });
    const modelInput = screen.getByTestId('dev-model') as HTMLInputElement;
    expect(modelInput.value).toContain('claude');
  });

  test('changing provider to cerebras updates the default model and base url', () => {
    render(<DevSetup onSessionReady={vi.fn()} />);
    fireEvent.change(screen.getByTestId('dev-provider'), { target: { value: 'cerebras' } });
    const modelInput = screen.getByTestId('dev-model') as HTMLInputElement;
    const baseUrlInput = screen.getByTestId('dev-base-url') as HTMLInputElement;
    expect(modelInput.value).toBe('llama3.1-8b');
    expect(baseUrlInput.value).toBe('https://api.cerebras.ai');
  });

  test('local server preset points dev sessions at localhost', () => {
    render(<DevSetup onSessionReady={vi.fn()} />);

    fireEvent.click(screen.getByTestId('dev-use-local-server'));

    const providerInput = screen.getByTestId('dev-provider') as HTMLSelectElement;
    const baseUrlInput = screen.getByTestId('dev-base-url') as HTMLInputElement;
    const apiKeyInput = screen.getByTestId('dev-api-key') as HTMLInputElement;

    expect(providerInput.value).toBe('local-openai');
    expect(baseUrlInput.value).toBe('http://localhost:8080/v1');
    expect(apiKeyInput.value).toBe('local-dev');
    expect(screen.getByTestId('dev-local-server-hint')).toBeInTheDocument();
  });

  test('includes base_url in agentConfig when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeSessionResponse()));
    const onReady = vi.fn();
    render(<DevSetup onSessionReady={onReady} />);

    fireEvent.change(screen.getByTestId('dev-api-key'), { target: { value: 'sk-key' } });
    fireEvent.change(screen.getByTestId('dev-base-url'), { target: { value: 'https://my-proxy.example.com' } });
    fireEvent.click(screen.getByTestId('dev-start'));

    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const session = (onReady.mock.calls[0] as [DevSession])[0];
    expect(session.agentConfig.base_url).toBe('https://my-proxy.example.com');
  });

  test('omits base_url from agentConfig when empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeSessionResponse()));
    const onReady = vi.fn();
    render(<DevSetup onSessionReady={onReady} />);

    fireEvent.change(screen.getByTestId('dev-api-key'), { target: { value: 'sk-key' } });
    // base_url left empty
    fireEvent.click(screen.getByTestId('dev-start'));

    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const session = (onReady.mock.calls[0] as [DevSession])[0];
    expect(session.agentConfig.base_url).toBeUndefined();
  });

  test('allows starting a local dev session with the localhost preset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeSessionResponse()));
    const onReady = vi.fn();
    render(<DevSetup onSessionReady={onReady} />);

    fireEvent.click(screen.getByTestId('dev-use-local-server'));
    fireEvent.change(screen.getByTestId('dev-api-key'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('dev-model'), { target: { value: 'qwen2.5-coder' } });
    fireEvent.click(screen.getByTestId('dev-start'));

    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const session = (onReady.mock.calls[0] as [DevSession])[0];
    expect(session.agentConfig.provider).toBe('local-openai');
    expect(session.agentConfig.base_url).toBe('http://localhost:8080/v1');
    expect(session.agentConfig.api_key).toBe('local-dev');
    expect(session.agentConfig.model).toBe('qwen2.5-coder');
  });

  test('POSTs to /api/sessions with correct body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeSessionResponse());
    vi.stubGlobal('fetch', fetchMock);
    render(<DevSetup onSessionReady={vi.fn()} />);

    fireEvent.change(screen.getByTestId('dev-api-key'), { target: { value: 'sk-key' } });
    fireEvent.click(screen.getByTestId('dev-start'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/sessions');
    const body = JSON.parse(init.body as string) as { prompt_id: string; candidate_email: string };
    expect(body.prompt_id).toBe('dev');
    expect(body.candidate_email).toBe('dev@lintic.local');
  });

  test('opens the review dashboard for a newly created dev session', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeSessionResponse('sess-review', 'tok-review'));
    vi.stubGlobal('fetch', fetchMock);
    const assignMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { assign: assignMock },
      writable: true,
    });

    render(<DevSetup onSessionReady={vi.fn()} />);
    fireEvent.click(screen.getByTestId('dev-open-review'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(assignMock).toHaveBeenCalledWith('/review/sess-review');
  });
});
