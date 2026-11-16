// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

describe('Brief 4: Morning Pages writing experience & autosave resilience', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens on today local date, updates live word count toward the 750-word goal, and allows switching between Write, Entries list, and Calendar views', async () => {
    // 2026-11-15T23:30:00Z is 2026-11-16 in Africa/Johannesburg (UTC+2)
    const fixedNow = () => new Date('2026-11-15T23:30:00.000Z');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/entries') {
        return new Response(
          JSON.stringify({
            entries: [
              {
                entryDate: '2026-11-14',
                wordCount: 420,
                createdAt: '2026-11-14T07:00:00.000Z',
                updatedAt: '2026-11-14T07:10:00.000Z',
              },
            ],
            meta: { totalEntries: 1, totalWords: 420 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/entries/2026-11-14') {
        return new Response(
          JSON.stringify({
            entryDate: '2026-11-14',
            content: 'Loaded entry from November fourteenth.',
            wordCount: 5,
            createdAt: '2026-11-14T07:00:00.000Z',
            updatedAt: '2026-11-14T07:10:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <App
        queryClient={queryClient}
        timezone="Africa/Johannesburg"
        now={fixedNow}
        autosaveDebounceMs={50}
      />,
    );

    // Opens on user's local date (2026-11-16 in Johannesburg)
    expect(screen.getByLabelText('Active entry date').textContent).toContain('2026-11-16 (Today)');

    const editor = screen.getByRole('textbox', {
      name: /Journal entry for 2026-11-16/i,
    }) as HTMLTextAreaElement;

    fireEvent.change(editor, {
      target: { value: 'One two three four five six' },
    });

    expect(screen.getByText('6 / 750 words')).toBeDefined();

    // Switch to Calendar view and tap 2026-11-14
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    const day14Button = await screen.findByRole('button', {
      name: /Open entry for 2026-11-14/i,
    });
    fireEvent.click(day14Button);

    await waitFor(() => {
      expect(screen.getByLabelText('Active entry date').textContent).toBe('2026-11-14');
      expect(
        (
          screen.getByRole('textbox', {
            name: /Journal entry for 2026-11-14/i,
          }) as HTMLTextAreaElement
        ).value,
      ).toBe('Loaded entry from November fourteenth.');
    });
  });

  it('simulates a network failure mid-typing, preserves all text in memory, warns on unload, and saves automatically after reconnection', async () => {
    const fixedNow = () => new Date('2026-11-15T08:00:00.000Z');
    let shouldFailSave = true;
    const savedBodies: Array<{ content: string }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? 'GET';

      if (method === 'GET' && url === '/api/entries') {
        return new Response(
          JSON.stringify({ entries: [], meta: { totalEntries: 0, totalWords: 0 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url.startsWith('/api/entries/')) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'None' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'PUT' && url === '/api/entries/2026-11-15') {
        if (shouldFailSave) {
          throw new TypeError('NetworkError: Failed to fetch');
        }
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { content: string };
        savedBodies.push(parsed);
        return new Response(
          JSON.stringify({
            entryDate: '2026-11-15',
            content: parsed.content,
            wordCount: 9,
            createdAt: '2026-11-15T08:00:00.000Z',
            updatedAt: '2026-11-15T08:00:05.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <App
        queryClient={queryClient}
        timezone="UTC"
        now={fixedNow}
        autosaveDebounceMs={25}
        retryBaseDelayMs={80}
      />,
    );

    const editor = screen.getByRole('textbox', {
      name: /Journal entry for 2026-11-15/i,
    }) as HTMLTextAreaElement;

    // 1. User starts typing while network fails
    fireEvent.change(editor, {
      target: { value: 'First sentence typed before network drops.' },
    });

    // Wait for first debounced save attempt to fail -> status becomes "Offline, will retry"
    await waitFor(() => {
      expect(screen.getByText('Offline, will retry')).toBeDefined();
    });

    // 2. User continues typing mid-failure -> no text is lost
    const fullPreciousText =
      'First sentence typed before network drops. Second sentence typed while offline!';
    fireEvent.change(editor, {
      target: { value: fullPreciousText },
    });
    expect(editor.value).toBe(fullPreciousText);

    // Verify beforeunload warns when unsaved changes exist
    const unloadEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadEvent);
    expect(unloadEvent.defaultPrevented).toBe(true);

    // 3. Network reconnects -> retry/online handler saves the complete text and updates status to "Saved"
    shouldFailSave = false;
    window.dispatchEvent(new Event('online'));

    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeDefined();
    });

    expect(editor.value).toBe(fullPreciousText);
    expect(savedBodies.length).toBeGreaterThanOrEqual(1);
    expect(savedBodies[savedBodies.length - 1]?.content).toBe(fullPreciousText);
  });
});
