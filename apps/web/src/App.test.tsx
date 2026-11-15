// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

describe('Morning Pages web app shell', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the app heading and displays connected API status when /api/health succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'ok', timestamp: '2026-11-15T07:00:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(<App queryClient={queryClient} />);

    expect(screen.getByRole('heading', { name: /Morning Pages/i })).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText(/API connected/i)).toBeDefined();
    });
  });
});
