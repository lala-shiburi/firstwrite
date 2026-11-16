// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { BrowserPushAdapter } from './pushClient.js';

describe('Brief 6: Frontend Settings UI, Permission Explanation & Push Subscription Flow', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the pre-prompt explanation before requesting browser permission, subscribes with the VAPID public key, and allows unsubscribing devices', async () => {
    let permissionState: NotificationPermission = 'default';
    const requestPermissionSpy = vi.fn(async () => {
      permissionState = 'granted';
      return permissionState;
    });
    const subscribeSpy = vi.fn(async () => ({
      endpoint: 'https://push.example.com/browser-sub-1',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    }));
    const unsubscribeSpy = vi.fn(async () => 'https://push.example.com/browser-sub-1');

    const mockPushAdapter: BrowserPushAdapter = {
      isSupported: () => true,
      getPermissionState: () => permissionState,
      requestPermission: requestPermissionSpy,
      subscribe: subscribeSpy,
      getExistingEndpoint: async () => 'https://push.example.com/browser-sub-1',
      unsubscribe: unsubscribeSpy,
    };

    const apiCalls: Array<{ method: string; url: string; body?: unknown }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      apiCalls.push({ method, url, body });

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

      if (method === 'GET' && url === '/api/settings') {
        return new Response(
          JSON.stringify({
            timezone: 'Africa/Johannesburg',
            reminderEnabled: false,
            reminderTime: '07:00',
            weeklySummaryEnabled: false,
            summaryDeliveryTime: '18:00',
            dailyWordGoal: 750,
            aiConsentAt: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url === '/api/push/subscriptions') {
        return new Response(JSON.stringify({ subscriptions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'POST' && url === '/api/push/subscribe') {
        return new Response(
          JSON.stringify({
            subscription: {
              id: '1',
              endpoint: 'https://push.example.com/browser-sub-1',
              userAgent: 'Desktop Chrome',
              createdAt: '2026-11-15T07:00:00.000Z',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'PUT' && url === '/api/settings') {
        return new Response(
          JSON.stringify({
            timezone: 'Africa/Johannesburg',
            reminderEnabled: true,
            reminderTime: '08:15',
            weeklySummaryEnabled: false,
            summaryDeliveryTime: '18:00',
            dailyWordGoal: 750,
            aiConsentAt: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'DELETE' && url === '/api/push/subscribe') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <App
        queryClient={queryClient}
        timezone="Africa/Johannesburg"
        pushAdapter={mockPushAdapter}
        vapidPublicKey="TEST_VAPID_PUBLIC_KEY"
      />,
    );

    // Open Settings tab
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const toggle = await screen.findByRole('switch', {
      name: /Enable daily writing reminder/i,
    });

    // 1. Clicking toggle when permission is 'default' shows explanation dialog BEFORE browser prompt
    fireEvent.click(toggle);
    expect(requestPermissionSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: /Notification permission explanation/i }),
    ).toBeDefined();

    // 2. Clicking "Continue to browser prompt" requests permission, subscribes with VAPID key, and saves settings
    fireEvent.click(screen.getByRole('button', { name: /Continue to browser prompt/i }));

    await waitFor(() => {
      expect(requestPermissionSpy).toHaveBeenCalledTimes(1);
      expect(subscribeSpy).toHaveBeenCalledWith('TEST_VAPID_PUBLIC_KEY');
      expect(screen.getByText('https://push.example.com/browser-sub-1')).toBeDefined();
    });

    // 3. Changing reminder time updates settings on the server
    const timeInput = screen.getByLabelText(/Reminder time \(local time\)/i);
    fireEvent.change(timeInput, { target: { value: '08:15' } });

    await waitFor(() => {
      expect(
        apiCalls.some(
          (c) =>
            c.method === 'PUT' &&
            c.url === '/api/settings' &&
            (c.body as { reminderTime?: string })?.reminderTime === '08:15',
        ),
      ).toBe(true);
    });

    // 4. Unsubscribing device removes it from UI and calls DELETE /api/push/subscribe
    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));

    await waitFor(() => {
      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
      expect(apiCalls.some((c) => c.method === 'DELETE' && c.url === '/api/push/subscribe')).toBe(
        true,
      );
    });
  });

  it('handles denied browser notification permission gracefully with an informative alert', async () => {
    const deniedPushAdapter: BrowserPushAdapter = {
      isSupported: () => true,
      getPermissionState: () => 'denied',
      requestPermission: async () => 'denied',
      subscribe: vi.fn(),
      getExistingEndpoint: async () => null,
      unsubscribe: async () => null,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ subscriptions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<App queryClient={queryClient} timezone="UTC" pushAdapter={deniedPushAdapter} />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const alertBox = await screen.findByRole('alert');
    expect(alertBox.textContent).toContain('Browser notification permission is currently blocked');
  });

  it('provides a "Download all my entries" button in Settings with a progress/spinner state for long downloads', async () => {
    let resolveExportResponse!: (res: Response) => void;
    const exportPromise = new Promise<Response>((resolve) => {
      resolveExportResponse = resolve;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/export')) {
        return exportPromise;
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

    const downloadBtn = await screen.findByRole('button', { name: /Download all my entries/i });
    fireEvent.click(downloadBtn);

    // While download is in progress, button shows progress state and is disabled to prevent duplicate clicks
    expect(
      screen.getByRole('button', { name: /Downloading entries…/i }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText(/Preparing your archive/i)).toBeDefined();

    // Complete download
    resolveExportResponse(
      new Response('---\ndate: 2026-11-15\nwords: 3\n---\n\nHello morning pages\n', {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="morning-pages-export-2026-11-15.zip"',
        },
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Export complete \(morning-pages-export-2026-11-15\.zip\)/i),
      ).toBeDefined();
    });
  });
});
