// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

describe('Brief 8: Weekly Reviews View & AI Consent Flow', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('displays the non-therapy disclaimer, lists weekly summaries, expands summary detail, and deletes a summary', async () => {
    const apiCalls: Array<{ method: string; url: string }> = [];

    let summaries = [
      {
        weekStart: '2026-11-09',
        weekEnd: '2026-11-15',
        status: 'completed' as const,
        skipReason: null,
        summaryMd: 'You wrote consistently about morning walks and project clarity.',
        themes: ['morning walks', 'clarity', 'focus'],
        model: 'claude-haiku-5-5',
        createdAt: '2026-11-15T18:05:00.000Z',
        completedAt: '2026-11-15T18:05:10.000Z',
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? 'GET';
      apiCalls.push({ method, url });

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

      if (method === 'GET' && url === '/api/summaries') {
        return new Response(JSON.stringify({ summaries }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'DELETE' && url === '/api/summaries/2026-11-09') {
        summaries = [];
        return new Response(null, { status: 204 });
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<App queryClient={queryClient} timezone="UTC" />);

    fireEvent.click(screen.getByRole('button', { name: 'Weekly reviews' }));

    // 1. Shows visible note that this is a reflective tool and not therapy or professional advice
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('not therapy');
    expect(note.textContent).toContain('professional advice');

    // 2. Renders the summary item in the list and expands its detail on click
    const summaryRow = await screen.findByText(/Week of 2026-11-09 to 2026-11-15/i);
    fireEvent.click(summaryRow);

    expect(
      await screen.findByText(/You wrote consistently about morning walks and project clarity\./i),
    ).toBeDefined();

    // 3. Deleting the summary calls DELETE /api/summaries/:weekStart and updates the list
    const deleteBtn = screen.getByRole('button', {
      name: /Delete summary for 2026-11-09/i,
    });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(
        apiCalls.some((c) => c.method === 'DELETE' && c.url === '/api/summaries/2026-11-09'),
      ).toBe(true);
      expect(screen.getByText(/No weekly reviews yet/i)).toBeDefined();
    });
  });

  it('allows explicit AI consent opt-in and immediate consent withdrawal in Settings', async () => {
    const apiBodies: Array<Record<string, unknown>> = [];
    let currentSettings = {
      timezone: 'UTC',
      reminderEnabled: false,
      reminderTime: '07:00',
      weeklySummaryEnabled: false,
      summaryDeliveryTime: '18:00',
      dailyWordGoal: 750,
      aiConsentAt: null as string | null,
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? 'GET';

      if (method === 'GET' && url === '/api/settings') {
        return new Response(JSON.stringify(currentSettings), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'PUT' && url === '/api/settings') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        apiBodies.push(body);
        if (body.aiConsent === true) {
          currentSettings = {
            ...currentSettings,
            weeklySummaryEnabled: true,
            aiConsentAt: '2026-11-15T18:00:00.000Z',
          };
        } else if (body.aiConsent === false) {
          currentSettings = {
            ...currentSettings,
            weeklySummaryEnabled: false,
            aiConsentAt: null,
          };
        }
        return new Response(JSON.stringify(currentSettings), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          entries: [],
          subscriptions: [],
          meta: { totalEntries: 0, totalWords: 0 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<App queryClient={queryClient} timezone="UTC" />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    // Verifies plain-language explanation naming the LLM provider (Anthropic Claude)
    expect(await screen.findByText(/Anthropic Claude/i)).toBeDefined();

    // 1. Explicit opt-in button
    const optInBtn = screen.getByRole('button', {
      name: /I consent — enable weekly AI summaries/i,
    });
    fireEvent.click(optInBtn);

    await waitFor(() => {
      expect(apiBodies.some((b) => b.aiConsent === true && b.weeklySummaryEnabled === true)).toBe(
        true,
      );
      expect(screen.getByRole('button', { name: /Withdraw AI consent & disable/i })).toBeDefined();
    });

    // 2. Withdraw consent button immediately revokes aiConsent and disables weeklySummaryEnabled
    fireEvent.click(screen.getByRole('button', { name: /Withdraw AI consent & disable/i }));

    await waitFor(() => {
      expect(apiBodies.some((b) => b.aiConsent === false && b.weeklySummaryEnabled === false)).toBe(
        true,
      );
    });
  });
});
