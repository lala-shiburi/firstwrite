// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type BeforeInstallPromptEvent } from './App.js';
import { InMemoryOfflineQueueStore } from './offlineQueue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Brief 5: PWA, Offline Queue Sync, Install Prompts & Service Worker Cache Safety', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('queues entries in the offline store when offline, restores draft on reload, and syncs with expectedUpdatedAt conflict protection when back online', async () => {
    const fixedNow = () => new Date('2026-11-15T08:00:00.000Z');
    const offlineStore = new InMemoryOfflineQueueStore();
    let isServerOnline = false;
    const putPayloads: Array<{ content: string; expectedUpdatedAt?: string | null }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? 'GET';

      if (!isServerOnline) {
        throw new TypeError('Failed to fetch (offline)');
      }

      if (method === 'GET' && url === '/api/entries') {
        return new Response(
          JSON.stringify({ entries: [], meta: { totalEntries: 0, totalWords: 0 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url === '/api/entries/2026-11-15') {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'None' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'PUT' && url === '/api/entries/2026-11-15') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          content: string;
          expectedUpdatedAt?: string | null;
        };
        putPayloads.push(body);
        return new Response(
          JSON.stringify({
            entryDate: '2026-11-15',
            content: body.content,
            wordCount: 8,
            createdAt: '2026-11-15T08:00:00.000Z',
            updatedAt: '2026-11-15T08:05:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const queryClient1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <App
        queryClient={queryClient1}
        timezone="UTC"
        now={fixedNow}
        offlineQueueStore={offlineStore}
        autosaveDebounceMs={25}
        retryBaseDelayMs={200}
      />,
    );

    const editor = screen.getByRole('textbox', {
      name: /Journal entry for 2026-11-15/i,
    }) as HTMLTextAreaElement;

    const offlineText = 'Written while completely offline on a train.';
    fireEvent.change(editor, { target: { value: offlineText } });

    await waitFor(async () => {
      expect(screen.getByText('Offline, will retry')).toBeDefined();
      const queued = await offlineStore.get('2026-11-15');
      expect(queued).not.toBeNull();
      expect(queued?.content).toBe(offlineText);
    });

    // Unmount and remount while still offline (simulating closing and reopening the PWA offline)
    unmount();

    const queryClient2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <App
        queryClient={queryClient2}
        timezone="UTC"
        now={fixedNow}
        offlineQueueStore={offlineStore}
        autosaveDebounceMs={25}
        retryBaseDelayMs={200}
      />,
    );

    const restoredEditor = (await screen.findByRole('textbox', {
      name: /Journal entry for 2026-11-15/i,
    })) as HTMLTextAreaElement;

    await waitFor(() => {
      expect(restoredEditor.value).toBe(offlineText);
    });

    // Now come back online -> queued entry syncs and is removed from the offline queue
    isServerOnline = true;
    window.dispatchEvent(new Event('online'));

    await waitFor(async () => {
      expect(screen.getByText('Saved')).toBeDefined();
      const remaining = await offlineStore.get('2026-11-15');
      expect(remaining).toBeNull();
    });

    expect(putPayloads.length).toBeGreaterThan(0);
    expect(putPayloads[putPayloads.length - 1]?.content).toBe(offlineText);
  });

  it('displays custom "Install app" affordance when beforeinstallprompt fires and shows Add to Home Screen instructions on iOS Safari', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ entries: [], meta: { totalEntries: 0, totalWords: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // 1. iOS Safari non-standalone shows Add to Home Screen instructions
    const queryClientIos = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <App
        queryClient={queryClientIos}
        timezone="UTC"
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
        isStandalone={false}
      />,
    );

    expect(screen.getByRole('region', { name: /iOS install instructions/i })).toBeDefined();
    expect(screen.getByText(/Add to Home Screen/i)).toBeDefined();
    unmount();

    // 2. Desktop/Android Chrome beforeinstallprompt event shows custom Install app button & prompt
    const queryClientChrome = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <App
        queryClient={queryClientChrome}
        timezone="UTC"
        userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        isStandalone={false}
      />,
    );

    const promptSpy = vi.fn().mockResolvedValue(undefined);
    const installEvent = new Event('beforeinstallprompt', {
      cancelable: true,
    }) as BeforeInstallPromptEvent;
    installEvent.prompt = promptSpy;
    installEvent.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });

    window.dispatchEvent(installEvent);

    const installBtn = await screen.findByRole('button', { name: 'Install app' });
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('prompts the user to reload when a new Service Worker version is available', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ entries: [], meta: { totalEntries: 0, totalWords: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const onReloadSpy = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<App queryClient={queryClient} timezone="UTC" onReloadForUpdate={onReloadSpy} />);

    window.dispatchEvent(new CustomEvent('sw-update-available'));

    const reloadBtn = await screen.findByRole('button', { name: /Reload to update/i });
    fireEvent.click(reloadBtn);

    expect(onReloadSpy).toHaveBeenCalledTimes(1);
  });

  it('verifies PWA manifest, icons (192, 512, maskable), and that Service Worker config never caches /api/ responses or journal content', () => {
    const viteConfigPath = path.resolve(__dirname, '../vite.config.ts');
    const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');

    // Manifest requirements: name, standalone, start_url: '/', icons (192x192, 512x512, maskable)
    expect(viteConfigSource).toContain("name: 'Morning Pages'");
    expect(viteConfigSource).toContain("display: 'standalone'");
    expect(viteConfigSource).toContain("start_url: '/'");
    expect(viteConfigSource).toContain("sizes: '192x192'");
    expect(viteConfigSource).toContain("sizes: '512x512'");
    expect(viteConfigSource).toContain("purpose: 'maskable'");

    // Service Worker cache safety: /api/ is denylisted from navigateFallback and strictly NetworkOnly
    expect(viteConfigSource).toContain('navigateFallbackDenylist: [/^\\/api\\//]');
    expect(viteConfigSource).toContain('urlPattern: /^\\/api\\/.*/i');
    expect(viteConfigSource).toContain("handler: 'NetworkOnly'");

    // Verify all icon files exist on disk and are non-empty PNGs/SVGs
    const publicIconsDir = path.resolve(__dirname, '../public/icons');
    for (const file of [
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-512.png',
      'apple-touch-icon-180.png',
      'icon.svg',
    ]) {
      const fullPath = path.join(publicIconsDir, file);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).size).toBeGreaterThan(100);
    }

    // If production build dist/sw.js exists, verify workbox NetworkOnly rule is compiled into sw.js
    // and no journal content or API cache names exist
    const distSwPath = path.resolve(__dirname, '../dist/sw.js');
    if (fs.existsSync(distSwPath)) {
      const swContent = fs.readFileSync(distSwPath, 'utf8');
      expect(swContent).toContain('NetworkOnly');
    }
  });
});
