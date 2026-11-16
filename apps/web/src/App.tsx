import {
  countWords,
  getUserLocalDate,
  type EntriesListResponse,
  type EntryDetail,
  type EntrySummary,
  type PushSubscriptionItem,
  type UserSettings,
} from '@firstwrite/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserOfflineQueueStore, type OfflineEntryQueueStore } from './offlineQueue.js';
import { createDefaultBrowserPushAdapter, type BrowserPushAdapter } from './pushClient.js';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'conflict';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface MorningPagesAppProps {
  queryClient?: QueryClient;
  /** User IANA timezone (defaults to browser timezone or UTC) */
  timezone?: string;
  /** Daily word goal (defaults to 750 words per schema.sql) */
  dailyWordGoal?: number;
  /** Optional controllable clock for deterministic testing */
  now?: () => Date;
  /** Debounce delay in ms after typing stops (defaults to 1500ms) */
  autosaveDebounceMs?: number;
  /** Base retry backoff delay in ms when a save fails (defaults to 1500ms) */
  retryBaseDelayMs?: number;
  /** Initial CSRF token if already bootstrapped */
  initialCsrfToken?: string;
  /** Injectable offline queue store (defaults to IndexedDB store) */
  offlineQueueStore?: OfflineEntryQueueStore;
  /** Injectable browser push adapter (defaults to PushManager + Notification adapter) */
  pushAdapter?: BrowserPushAdapter;
  /** Optional VAPID public key override */
  vapidPublicKey?: string;
  /** Optional user-agent override for testing iOS Add-to-Home-Screen guidance */
  userAgent?: string;
  /** Optional standalone display-mode override for testing installed state */
  isStandalone?: boolean;
  /** Optional callback invoked when user clicks Reload on the Service Worker update banner */
  onReloadForUpdate?: () => void;
}

const defaultQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const defaultOfflineQueueStore = createBrowserOfflineQueueStore();
const defaultPushAdapter = createDefaultBrowserPushAdapter();

function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isIosSafariNotStandalone(userAgent: string, isStandalone: boolean): boolean {
  if (isStandalone) return false;
  const isIosDevice = /iPad|iPhone|iPod/i.test(userAgent);
  const isWebKit = /WebKit/i.test(userAgent);
  const isCriOSOrFxiOS = /CriOS|FxiOS|EdgiOS/i.test(userAgent);
  return isIosDevice && isWebKit && !isCriOSOrFxiOS;
}

function detectStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  const mediaMatch =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  const navigatorStandalone =
    'standalone' in window.navigator &&
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(mediaMatch || navigatorStandalone);
}

function getMonthDaysGrid(yearMonth: string): Array<{ date: string; dayNumber: number } | null> {
  const parts = yearMonth.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]); // 1..12
  const firstDayUtc = new Date(Date.UTC(year, month - 1, 1));
  const startWeekday = firstDayUtc.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: Array<{ date: string; dayNumber: number } | null> = [];
  for (let i = 0; i < startWeekday; i++) {
    cells.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ date: dateStr, dayNumber: d });
  }
  return cells;
}

function shiftYearMonth(yearMonth: string, deltaMonths: number): string {
  const parts = yearMonth.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const d = new Date(Date.UTC(year, month - 1 + deltaMonths, 1));
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function MorningPagesShell({
  timezone = detectBrowserTimezone(),
  dailyWordGoal = 750,
  now = () => new Date(),
  autosaveDebounceMs = 1500,
  retryBaseDelayMs = 1500,
  initialCsrfToken = 'dev-csrf-token',
  offlineQueueStore = defaultOfflineQueueStore,
  pushAdapter = defaultPushAdapter,
  vapidPublicKey = (import.meta.env?.VITE_VAPID_PUBLIC_KEY as string | undefined) ??
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  isStandalone = detectStandaloneMode(),
  onReloadForUpdate,
}: Omit<MorningPagesAppProps, 'queryClient'>) {
  const todayLocal = useMemo(() => getUserLocalDate(now(), timezone), [now, timezone]);
  const [selectedDate, setSelectedDate] = useState<string>(todayLocal);
  const [activeView, setActiveView] = useState<'write' | 'list' | 'calendar' | 'settings'>('write');
  const [calendarMonth, setCalendarMonth] = useState<string>(todayLocal.slice(0, 7));

  const [content, setContent] = useState<string>('');
  const [serverUpdatedAt, setServerUpdatedAt] = useState<string | null>(null);
  const [conflictServerEntry, setConflictServerEntry] = useState<EntryDetail | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [isNetworkOffline, setIsNetworkOffline] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false,
  );
  const [entriesSummaryMap, setEntriesSummaryMap] = useState<Record<string, EntrySummary>>({});
  const [csrfToken, setCsrfToken] = useState<string>(initialCsrfToken);

  // Reminder & Push notification settings state (Brief 6)
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(false);
  const [reminderTime, setReminderTime] = useState<string>('07:00');
  const [showPermissionExplainer, setShowPermissionExplainer] = useState<boolean>(false);
  const [pushPermissionState, setPushPermissionState] = useState<NotificationPermission>(() =>
    pushAdapter.getPermissionState(),
  );
  const [subscribedDevices, setSubscribedDevices] = useState<PushSubscriptionItem[]>([]);
  const [settingsSavedNotice, setSettingsSavedNotice] = useState<string | null>(null);

  // Export state (Brief 7)
  const [exportFormat, setExportFormat] = useState<'zip' | 'md'>('zip');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportStatusMessage, setExportStatusMessage] = useState<string | null>(null);
  const [exportErrorMessage, setExportErrorMessage] = useState<string | null>(null);

  // PWA install & update prompt states
  const [deferredInstallPrompt, setDeferredInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installPromptDismissed, setInstallPromptDismissed] = useState<boolean>(false);
  const [iosBannerDismissed, setIosBannerDismissed] = useState<boolean>(false);
  const [swUpdateAvailable, setSwUpdateAvailable] = useState<boolean>(false);

  const showIosInstallBanner =
    !iosBannerDismissed && isIosSafariNotStandalone(userAgent, isStandalone);

  const latestContentRef = useRef<string>(content);
  latestContentRef.current = content;

  const latestDateRef = useRef<string>(selectedDate);
  latestDateRef.current = selectedDate;

  const latestUpdatedAtRef = useRef<string | null>(serverUpdatedAt);
  latestUpdatedAtRef.current = serverUpdatedAt;

  const isDirtyRef = useRef<boolean>(isDirty);
  isDirtyRef.current = isDirty;

  const retryCountRef = useRef<number>(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef<boolean>(false);

  const wordCount = useMemo(() => countWords(content), [content]);
  const goalProgressPct = useMemo(
    () => Math.min(100, Math.round((wordCount / Math.max(1, dailyWordGoal)) * 100)),
    [wordCount, dailyWordGoal],
  );

  const clearTimers = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  // Load entry list metadata
  const fetchEntriesList = useCallback(async () => {
    try {
      const res = await fetch('/api/entries', { credentials: 'include' });
      const csrfHeader = res.headers.get('X-CSRF-Token');
      if (csrfHeader) setCsrfToken(csrfHeader);

      if (res.ok) {
        const data = (await res.json()) as EntriesListResponse;
        const nextMap: Record<string, EntrySummary> = {};
        for (const item of data.entries) {
          nextMap[item.entryDate] = item;
        }
        setEntriesSummaryMap(nextMap);
      }
    } catch {
      // Ignore background list fetch errors when offline
    }
  }, []);

  // Load specific date's entry when selectedDate changes (checking offline IndexedDB queue first!)
  useEffect(() => {
    let cancelled = false;
    clearTimers();

    async function loadEntryForDate(targetDate: string) {
      // 1. Check if there is an unsynced offline draft queued in IndexedDB for this date
      const queuedDraft = await offlineQueueStore.get(targetDate);
      if (cancelled) return;

      if (queuedDraft) {
        setContent(queuedDraft.content);
        latestContentRef.current = queuedDraft.content;
        setServerUpdatedAt(queuedDraft.expectedUpdatedAt);
        latestUpdatedAtRef.current = queuedDraft.expectedUpdatedAt;
        setIsDirty(true);
        isDirtyRef.current = true;
        setSaveStatus('offline');
        return;
      }

      // 2. Otherwise fetch from the API
      try {
        const res = await fetch(`/api/entries/${targetDate}`, {
          credentials: 'include',
        });
        const csrfHeader = res.headers.get('X-CSRF-Token');
        if (csrfHeader) setCsrfToken(csrfHeader);

        if (cancelled) return;

        if (res.ok) {
          const detail = (await res.json()) as Partial<EntryDetail>;
          if (!isDirtyRef.current && typeof detail.content === 'string') {
            setContent(detail.content);
            setServerUpdatedAt(detail.updatedAt ?? null);
            setSaveStatus('saved');
          }
        } else if (res.status === 404) {
          if (!isDirtyRef.current) {
            setContent('');
            setServerUpdatedAt(null);
            setSaveStatus('idle');
          }
        }
      } catch {
        setIsNetworkOffline(true);
      }
    }

    void loadEntryForDate(selectedDate);
    void fetchEntriesList();

    return () => {
      cancelled = true;
    };
  }, [selectedDate, clearTimers, fetchEntriesList, offlineQueueStore]);

  // Core save function with IndexedDB offline queue persistence and exponential backoff retry
  const performSave = useCallback(
    async function saveNow(overrideExpectedUpdatedAt?: string | null): Promise<boolean> {
      if (!isDirtyRef.current && overrideExpectedUpdatedAt === undefined) {
        return true;
      }
      if (isSavingRef.current) {
        return false;
      }

      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      const snapshotText = latestContentRef.current;
      const snapshotDate = latestDateRef.current;
      const expectedUpdatedAt =
        overrideExpectedUpdatedAt !== undefined
          ? overrideExpectedUpdatedAt
          : latestUpdatedAtRef.current;

      isSavingRef.current = true;
      setSaveStatus('saving');

      try {
        const res = await fetch(`/api/entries/${snapshotDate}`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            content: snapshotText,
            ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
          }),
        });

        const csrfHeader = res.headers.get('X-CSRF-Token');
        if (csrfHeader) setCsrfToken(csrfHeader);

        if (res.ok) {
          const saved = (await res.json()) as EntryDetail;
          retryCountRef.current = 0;
          setIsNetworkOffline(false);
          setServerUpdatedAt(saved.updatedAt);
          latestUpdatedAtRef.current = saved.updatedAt;
          setConflictServerEntry(null);

          await offlineQueueStore.remove(snapshotDate);

          setEntriesSummaryMap((prev) => ({
            ...prev,
            [saved.entryDate]: {
              entryDate: saved.entryDate,
              wordCount: saved.wordCount,
              createdAt: saved.createdAt,
              updatedAt: saved.updatedAt,
            },
          }));

          // If the user didn't type additional characters while the request was in flight, clear dirty flag
          if (latestContentRef.current === snapshotText) {
            setIsDirty(false);
            isDirtyRef.current = false;
            setSaveStatus('saved');
          } else {
            isSavingRef.current = false;
            debounceTimerRef.current = setTimeout(() => {
              void saveNow();
            }, autosaveDebounceMs);
            return true;
          }

          isSavingRef.current = false;
          return true;
        }

        if (res.status === 409) {
          const errBody = (await res.json()) as {
            error?: { details?: { serverEntry?: EntryDetail } };
          };
          const serverEntry = errBody.error?.details?.serverEntry ?? null;
          if (serverEntry) {
            setConflictServerEntry(serverEntry);
          }
          setSaveStatus('conflict');
          isSavingRef.current = false;
          return false;
        }

        throw new Error(`Save failed with HTTP ${res.status}`);
      } catch {
        // Network failure: persist entry locally in IndexedDB queue, show "Offline, will retry", and retry with backoff
        isSavingRef.current = false;
        setIsNetworkOffline(true);
        setSaveStatus('offline');

        await offlineQueueStore.put({
          entryDate: snapshotDate,
          content: latestContentRef.current,
          expectedUpdatedAt: expectedUpdatedAt ?? null,
          queuedAt: now().toISOString(),
        });

        retryCountRef.current += 1;
        const backoffMs = retryBaseDelayMs * Math.pow(2, Math.min(4, retryCountRef.current - 1));

        retryTimerRef.current = setTimeout(() => {
          void saveNow();
        }, backoffMs);
        return false;
      }
    },
    [autosaveDebounceMs, csrfToken, now, offlineQueueStore, retryBaseDelayMs],
  );

  // Sync any queued entries stored in IndexedDB when connection returns, using expectedUpdatedAt
  // so an offline draft never overwrites a newer server version.
  const syncOfflineQueuedEntries = useCallback(async () => {
    const queuedItems = await offlineQueueStore.listAll();
    for (const item of queuedItems) {
      if (item.entryDate === latestDateRef.current && isDirtyRef.current) {
        // Active date is handled by performSave()
        continue;
      }
      try {
        const res = await fetch(`/api/entries/${item.entryDate}`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            content: item.content,
            expectedUpdatedAt: item.expectedUpdatedAt,
          }),
        });

        if (res.ok) {
          await offlineQueueStore.remove(item.entryDate);
        } else if (res.status === 409) {
          const errBody = (await res.json()) as {
            error?: { details?: { serverEntry?: EntryDetail } };
          };
          const serverEntry = errBody.error?.details?.serverEntry ?? null;
          if (serverEntry && item.entryDate === latestDateRef.current) {
            setConflictServerEntry(serverEntry);
            setSaveStatus('conflict');
          }
        }
      } catch {
        // Still offline; leave in IndexedDB queue
        return;
      }
    }

    if (isDirtyRef.current) {
      retryCountRef.current = 0;
      await performSave();
    }
  }, [csrfToken, offlineQueueStore, performSave]);

  // Trigger debounced autosave when user types, and immediately queue draft in IndexedDB if offline
  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value;
    setContent(nextValue);
    latestContentRef.current = nextValue;
    setIsDirty(true);
    isDirtyRef.current = true;

    void offlineQueueStore.put({
      entryDate: latestDateRef.current,
      content: nextValue,
      expectedUpdatedAt: latestUpdatedAtRef.current,
      queuedAt: now().toISOString(),
    });

    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      void performSave();
    }, autosaveDebounceMs);
  };

  // Save on blur
  const handleEditorBlur = () => {
    if (isDirtyRef.current) {
      void performSave();
    }
  };

  // Listen for visibilitychange, beforeunload, online/offline, beforeinstallprompt, and sw update events
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && isDirtyRef.current) {
        void performSave();
      }
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isDirtyRef.current) {
        void performSave();
        event.preventDefault();
        event.returnValue = '';
      }
    };

    const onOnline = () => {
      setIsNetworkOffline(false);
      void syncOfflineQueuedEntries();
    };

    const onOffline = () => {
      setIsNetworkOffline(true);
      if (isDirtyRef.current) {
        setSaveStatus('offline');
      }
    };

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const onSwUpdateAvailable = () => {
      setSwUpdateAvailable(true);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('sw-update-available', onSwUpdateAvailable);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('sw-update-available', onSwUpdateAvailable);
    };
  }, [performSave, syncOfflineQueuedEntries]);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  const handleInstallClick = async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    setDeferredInstallPrompt(null);
  };

  const handleReloadForUpdate = () => {
    setSwUpdateAvailable(false);
    if (onReloadForUpdate) {
      onReloadForUpdate();
    } else if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  // Conflict resolution: merge both versions so no user writing is ever lost
  const handleMergeConflict = () => {
    if (!conflictServerEntry) return;
    const merged =
      conflictServerEntry.content.trim() === content.trim()
        ? content
        : `${conflictServerEntry.content}\n\n---\n\n${content}`;
    setContent(merged);
    latestContentRef.current = merged;
    setServerUpdatedAt(conflictServerEntry.updatedAt);
    latestUpdatedAtRef.current = conflictServerEntry.updatedAt;
    setConflictServerEntry(null);
    setIsDirty(true);
    isDirtyRef.current = true;
    void performSave(conflictServerEntry.updatedAt);
  };

  const handleSelectDate = (targetDate: string) => {
    if (targetDate !== selectedDate) {
      if (isDirtyRef.current) {
        void performSave();
      }
      setIsDirty(false);
      isDirtyRef.current = false;
      setSelectedDate(targetDate);
    }
    setActiveView('write');
  };

  // Load settings and subscribed devices when opening the Settings view
  useEffect(() => {
    if (activeView !== 'settings') return;
    let cancelled = false;

    async function loadSettingsAndSubscriptions() {
      setPushPermissionState(pushAdapter.getPermissionState());
      try {
        const [settingsRes, subsRes] = await Promise.all([
          fetch('/api/settings', { credentials: 'include' }),
          fetch('/api/push/subscriptions', { credentials: 'include' }),
        ]);

        if (cancelled) return;

        if (settingsRes.ok) {
          const s = (await settingsRes.json()) as Partial<UserSettings>;
          if (typeof s.reminderEnabled === 'boolean') {
            setReminderEnabled(s.reminderEnabled);
          }
          if (typeof s.reminderTime === 'string' && s.reminderTime.length >= 5) {
            setReminderTime(s.reminderTime.slice(0, 5));
          }
        }

        if (subsRes.ok) {
          const subData = (await subsRes.json()) as { subscriptions: PushSubscriptionItem[] };
          setSubscribedDevices(subData.subscriptions ?? []);
        }
      } catch {
        // Ignore network errors while loading settings offline
      }
    }

    void loadSettingsAndSubscriptions();
    return () => {
      cancelled = true;
    };
  }, [activeView, pushAdapter]);

  const saveReminderSettingsToServer = async (
    nextEnabled: boolean,
    nextTime: string,
  ): Promise<boolean> => {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          reminderEnabled: nextEnabled,
          reminderTime: nextTime,
        }),
      });
      if (res.ok) {
        setSettingsSavedNotice('Reminder settings saved.');
        return true;
      }
    } catch {
      // Ignore network errors
    }
    return false;
  };

  const registerDevicePushSubscription = async (): Promise<boolean> => {
    const serialized = await pushAdapter.subscribe(vapidPublicKey);
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify(serialized),
    });

    if (res.ok) {
      const created = (await res.json()) as { subscription: PushSubscriptionItem };
      setSubscribedDevices((prev) => {
        const filtered = prev.filter((d) => d.endpoint !== created.subscription.endpoint);
        return [...filtered, created.subscription];
      });
      return true;
    }
    return false;
  };

  const handleToggleReminders = async (checked: boolean) => {
    setSettingsSavedNotice(null);
    if (!checked) {
      setReminderEnabled(false);
      setShowPermissionExplainer(false);
      await saveReminderSettingsToServer(false, reminderTime);
      return;
    }

    const currentPerm = pushAdapter.getPermissionState();
    setPushPermissionState(currentPerm);

    if (currentPerm === 'default') {
      // Show pre-prompt explanation flow before calling browser Notification.requestPermission()
      setShowPermissionExplainer(true);
      return;
    }

    if (currentPerm === 'denied') {
      setReminderEnabled(false);
      return;
    }

    // Permission is already 'granted'
    setReminderEnabled(true);
    await registerDevicePushSubscription();
    await saveReminderSettingsToServer(true, reminderTime);
  };

  const handleConfirmEnablePushPermission = async () => {
    setShowPermissionExplainer(false);
    const permission = await pushAdapter.requestPermission();
    setPushPermissionState(permission);

    if (permission !== 'granted') {
      setReminderEnabled(false);
      return;
    }

    setReminderEnabled(true);
    await registerDevicePushSubscription();
    await saveReminderSettingsToServer(true, reminderTime);
  };

  const handleReminderTimeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = e.target.value;
    setReminderTime(nextTime);
    setSettingsSavedNotice(null);
    if (reminderEnabled) {
      await saveReminderSettingsToServer(true, nextTime);
    }
  };

  const handleUnsubscribeEndpoint = async (endpoint: string) => {
    setSettingsSavedNotice(null);
    const currentDeviceEndpoint = await pushAdapter.getExistingEndpoint();
    if (currentDeviceEndpoint === endpoint) {
      await pushAdapter.unsubscribe();
    }

    const res = await fetch('/api/push/subscribe', {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ endpoint }),
    });

    if (res.ok) {
      setSubscribedDevices((prev) => prev.filter((d) => d.endpoint !== endpoint));
      setSettingsSavedNotice('Device unsubscribed from push notifications.');
    }
  };

  const handleDownloadExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    setExportErrorMessage(null);
    setExportStatusMessage('Preparing your archive… Large journals may take a moment.');

    try {
      const res = await fetch(`/api/export?format=${exportFormat}`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) {
        if (res.status === 429) {
          throw new Error(
            'Export limit reached. Please wait a little while before exporting again.',
          );
        }
        throw new Error(`Export failed with status ${res.status}`);
      }

      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filenameMatch = /filename="([^"]+)"/.exec(disposition);
      const fallbackFilename = `morning-pages-export-${todayLocal}.${exportFormat}`;
      const filename = filenameMatch?.[1] ?? fallbackFilename;

      const blob = await res.blob();
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      }

      setExportStatusMessage(`Export complete (${filename}).`);
    } catch (err) {
      setExportStatusMessage(null);
      setExportErrorMessage(
        err instanceof Error ? err.message : 'Unable to download export right now.',
      );
    } finally {
      setIsExporting(false);
    }
  };

  const sortedEntriesList = useMemo(
    () =>
      Object.values(entriesSummaryMap).sort((a, b) =>
        a.entryDate > b.entryDate ? -1 : a.entryDate < b.entryDate ? 1 : 0,
      ),
    [entriesSummaryMap],
  );

  const monthCells = useMemo(() => getMonthDaysGrid(calendarMonth), [calendarMonth]);

  const statusLabel =
    saveStatus === 'saving'
      ? 'Saving…'
      : saveStatus === 'saved'
        ? 'Saved'
        : saveStatus === 'offline' || isNetworkOffline
          ? 'Offline, will retry'
          : saveStatus === 'conflict'
            ? 'Conflict detected'
            : isDirty
              ? 'Unsaved changes'
              : 'Ready';

  return (
    <div className="min-h-screen bg-[#faf8f5] dark:bg-stone-950 text-stone-900 dark:text-stone-100 transition-colors motion-reduce:transition-none flex flex-col">
      {/* Top navigation bar — reachable and usable one-handed on mobile */}
      <header className="w-full max-w-3xl mx-auto px-4 pt-4 pb-2 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200/80 dark:border-stone-800">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-serif tracking-tight text-stone-900 dark:text-stone-100">
            Morning Pages
          </h1>
          <span
            className="text-xs font-mono px-2.5 py-1 rounded-full bg-stone-200/70 dark:bg-stone-800 text-stone-700 dark:text-stone-300"
            aria-label="Active entry date"
          >
            {selectedDate}
            {selectedDate === todayLocal ? ' (Today)' : ''}
          </span>
        </div>

        <nav aria-label="Journal views" className="flex items-center gap-1">
          {deferredInstallPrompt && !installPromptDismissed && !isStandalone && (
            <button
              type="button"
              onClick={() => void handleInstallClick()}
              className="px-3 py-1.5 mr-1 rounded-lg text-xs font-medium border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-200/60 dark:hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-500"
            >
              Install app
            </button>
          )}
          <button
            type="button"
            onClick={() => setActiveView('write')}
            aria-pressed={activeView === 'write'}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-stone-500 ${
              activeView === 'write'
                ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900'
                : 'text-stone-700 dark:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800'
            }`}
          >
            Write
          </button>
          <button
            type="button"
            onClick={() => setActiveView('list')}
            aria-pressed={activeView === 'list'}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-stone-500 ${
              activeView === 'list'
                ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900'
                : 'text-stone-700 dark:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800'
            }`}
          >
            Entries
          </button>
          <button
            type="button"
            onClick={() => setActiveView('calendar')}
            aria-pressed={activeView === 'calendar'}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-stone-500 ${
              activeView === 'calendar'
                ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900'
                : 'text-stone-700 dark:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800'
            }`}
          >
            Calendar
          </button>
          <button
            type="button"
            onClick={() => setActiveView('settings')}
            aria-pressed={activeView === 'settings'}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-stone-500 ${
              activeView === 'settings'
                ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900'
                : 'text-stone-700 dark:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800'
            }`}
          >
            Settings
          </button>
        </nav>
      </header>

      {/* Banners for Service Worker updates, iOS Add to Home Screen, and offline state */}
      <div className="w-full max-w-3xl mx-auto px-4 pt-3 space-y-2 empty:hidden">
        {swUpdateAvailable && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3 shadow-sm"
          >
            <span>A new version of Morning Pages is available.</span>
            <button
              type="button"
              onClick={handleReloadForUpdate}
              className="px-3 py-1 rounded-lg bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 font-medium focus:outline-none focus:ring-2 focus:ring-stone-500"
            >
              Reload to update
            </button>
          </div>
        )}

        {showIosInstallBanner && (
          <div
            role="region"
            aria-label="iOS install instructions"
            className="rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-2.5 text-xs flex items-center justify-between gap-3 shadow-sm"
          >
            <span>
              To install Morning Pages and enable reminders on iOS: tap the Share button in Safari
              and choose <strong>Add to Home Screen</strong>.
            </span>
            <button
              type="button"
              aria-label="Dismiss install instructions"
              onClick={() => setIosBannerDismissed(true)}
              className="text-stone-500 hover:text-stone-800 dark:hover:text-stone-200 px-2 py-1"
            >
              Dismiss
            </button>
          </div>
        )}

        {deferredInstallPrompt && !installPromptDismissed && !isStandalone && (
          <div
            role="region"
            aria-label="Install app prompt"
            className="rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3 shadow-sm"
          >
            <span>Install Morning Pages for quick one-tap access and offline writing.</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleInstallClick()}
                className="px-3 py-1 rounded-lg bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 font-medium"
              >
                Install
              </button>
              <button
                type="button"
                onClick={() => setInstallPromptDismissed(true)}
                className="px-2 py-1 text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
              >
                Not now
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main content area */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6 flex flex-col">
        {conflictServerEntry && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-amber-400 bg-amber-50 dark:bg-amber-950/50 p-4 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-3"
          >
            <span>
              Another device saved a newer version of this entry. Merge both versions so no writing
              is lost.
            </span>
            <button
              type="button"
              onClick={handleMergeConflict}
              className="px-3 py-1.5 rounded-lg bg-amber-800 text-white font-medium hover:bg-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-600"
            >
              Merge & Save Both
            </button>
          </div>
        )}

        {activeView === 'write' && (
          <section aria-label="Journal editor" className="flex-1 flex flex-col">
            <label htmlFor="morning-pages-editor" className="sr-only">
              Journal entry for {selectedDate}
            </label>
            <textarea
              id="morning-pages-editor"
              aria-label={`Journal entry for ${selectedDate}`}
              value={content}
              onChange={handleContentChange}
              onBlur={handleEditorBlur}
              placeholder="Write freely without stopping or editing…"
              className="flex-1 w-full min-h-[55vh] max-w-[68ch] mx-auto bg-transparent resize-none border-0 focus:outline-none focus:ring-0 text-lg leading-relaxed font-serif placeholder:text-stone-400 dark:placeholder:text-stone-600"
            />
          </section>
        )}

        {activeView === 'list' && (
          <section aria-label="Past entries list" className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">All Entries</h2>
              {selectedDate !== todayLocal && (
                <button
                  type="button"
                  onClick={() => handleSelectDate(todayLocal)}
                  className="text-sm underline text-stone-700 dark:text-stone-300"
                >
                  Jump to Today ({todayLocal})
                </button>
              )}
            </div>

            {sortedEntriesList.length === 0 ? (
              <p className="text-sm text-stone-500 py-8 text-center">
                No entries recorded yet. Start writing today&apos;s page.
              </p>
            ) : (
              <ul className="divide-y divide-stone-200 dark:divide-stone-800 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
                {sortedEntriesList.map((item) => (
                  <li key={item.entryDate}>
                    <button
                      type="button"
                      onClick={() => handleSelectDate(item.entryDate)}
                      className="w-full px-4 py-3 text-left flex items-center justify-between hover:bg-stone-100 dark:hover:bg-stone-800/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-stone-500"
                    >
                      <span className="font-mono text-sm font-medium">{item.entryDate}</span>
                      <span className="text-xs text-stone-600 dark:text-stone-400">
                        {item.wordCount} {item.wordCount === 1 ? 'word' : 'words'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {activeView === 'calendar' && (
          <section aria-label="Entries calendar" className="space-y-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setCalendarMonth((m) => shiftYearMonth(m, -1))}
                aria-label="Previous month"
                className="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-sm"
              >
                Previous
              </button>
              <h2 className="text-base font-medium font-mono">{calendarMonth}</h2>
              <button
                type="button"
                onClick={() => setCalendarMonth((m) => shiftYearMonth(m, 1))}
                aria-label="Next month"
                className="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-sm"
              >
                Next
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-stone-500">
              <span>Sun</span>
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
            </div>

            <div className="grid grid-cols-7 gap-1">
              {monthCells.map((cell, idx) => {
                if (!cell) {
                  return <div key={`empty-${idx}`} className="h-11" />;
                }
                const summary = entriesSummaryMap[cell.date];
                const hasEntry = Boolean(summary && summary.wordCount > 0);
                const isSelected = cell.date === selectedDate;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    onClick={() => handleSelectDate(cell.date)}
                    aria-label={`Open entry for ${cell.date}${hasEntry ? `, ${summary!.wordCount} words` : ''}`}
                    className={`h-11 rounded-lg flex flex-col items-center justify-center text-sm border focus:outline-none focus:ring-2 focus:ring-stone-500 ${
                      isSelected
                        ? 'border-stone-900 dark:border-stone-100 font-semibold bg-stone-200/70 dark:bg-stone-800'
                        : hasEntry
                          ? 'border-emerald-600/40 bg-emerald-50/70 dark:bg-emerald-950/40 text-stone-900 dark:text-stone-100'
                          : 'border-transparent hover:bg-stone-200/50 dark:hover:bg-stone-800/50'
                    }`}
                  >
                    <span>{cell.dayNumber}</span>
                    {hasEntry && (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400 mt-0.5"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {activeView === 'settings' && (
          <section aria-label="Reminder and notification settings" className="space-y-6">
            <div>
              <h2 className="text-lg font-medium">Daily Reminders &amp; Notifications</h2>
              <p className="text-sm text-stone-600 dark:text-stone-400 mt-1">
                Receive a gentle, private reminder at your chosen local time ({timezone}) only when
                you haven&apos;t written yet today. Notifications never include journal text.
              </p>
            </div>

            <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label
                    htmlFor="reminder-toggle"
                    className="text-sm font-medium text-stone-900 dark:text-stone-100"
                  >
                    Enable daily writing reminder
                  </label>
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Fires once per day in your local timezone ({timezone}) if today&apos;s page is
                    still blank.
                  </p>
                </div>
                <input
                  id="reminder-toggle"
                  type="checkbox"
                  role="switch"
                  aria-checked={reminderEnabled}
                  checked={reminderEnabled}
                  onChange={(e) => void handleToggleReminders(e.target.checked)}
                  className="h-5 w-5 rounded border-stone-300 text-stone-900 focus:ring-stone-500"
                />
              </div>

              <div className="flex items-center justify-between gap-4 pt-2 border-t border-stone-100 dark:border-stone-800">
                <label
                  htmlFor="reminder-time-input"
                  className="text-sm font-medium text-stone-900 dark:text-stone-100"
                >
                  Reminder time (local time)
                </label>
                <input
                  id="reminder-time-input"
                  type="time"
                  aria-label="Reminder time (local time)"
                  value={reminderTime}
                  onChange={(e) => void handleReminderTimeChange(e)}
                  className="rounded-lg border border-stone-300 dark:border-stone-700 bg-transparent px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-stone-500"
                />
              </div>

              {/* Pre-prompt explanation before calling browser Notification.requestPermission() */}
              {showPermissionExplainer && (
                <div
                  role="dialog"
                  aria-label="Notification permission explanation"
                  className="rounded-xl border border-stone-300 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/80 p-4 space-y-3 text-sm"
                >
                  <p className="font-medium text-stone-900 dark:text-stone-100">
                    Why Morning Pages asks for notification permission
                  </p>
                  <p className="text-xs text-stone-600 dark:text-stone-300">
                    Your browser will ask to allow notifications so we can send a quiet daily nudge
                    at {reminderTime} ({timezone}) when you haven&apos;t written yet. Because lock
                    screens are public, notifications are always generic and never contain your
                    journal content.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleConfirmEnablePushPermission()}
                      className="px-3 py-1.5 rounded-lg bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 text-xs font-medium"
                    >
                      Continue to browser prompt
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowPermissionExplainer(false)}
                      className="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Graceful handling of denied browser permission */}
              {pushPermissionState === 'denied' && (
                <div
                  role="alert"
                  className="rounded-xl border border-amber-400 bg-amber-50 dark:bg-amber-950/40 p-4 text-xs text-amber-900 dark:text-amber-200"
                >
                  Browser notification permission is currently blocked for this site. To receive
                  daily reminders, please allow notifications for Morning Pages in your browser or
                  device settings and try again.
                </div>
              )}

              {settingsSavedNotice && (
                <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
                  {settingsSavedNotice}
                </p>
              )}
            </div>

            {/* Subscribed devices list with per-device Unsubscribe support */}
            <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-3">
              <h3 className="text-sm font-medium">Subscribed Devices</h3>
              {subscribedDevices.length === 0 ? (
                <p className="text-xs text-stone-500">
                  No devices are currently subscribed to push reminders.
                </p>
              ) : (
                <ul className="divide-y divide-stone-200 dark:divide-stone-800">
                  {subscribedDevices.map((sub) => (
                    <li
                      key={sub.id}
                      className="py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="truncate">
                        <p className="font-medium text-stone-800 dark:text-stone-200 truncate">
                          {sub.userAgent || 'Browser device'}
                        </p>
                        <p className="text-stone-500 font-mono truncate">{sub.endpoint}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleUnsubscribeEndpoint(sub.endpoint)}
                        className="px-2.5 py-1 rounded-lg border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 shrink-0"
                      >
                        Unsubscribe
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Account Data Export (Brief 7) */}
            <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 space-y-4">
              <div>
                <h3 className="text-sm font-medium">Export Your Journal</h3>
                <p className="text-xs text-stone-500 dark:text-stone-400 mt-1">
                  Download everything you have written as standard Markdown files compatible with
                  Obsidian, iA Writer, and any text editor.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs">
                  <label htmlFor="export-format-select" className="font-medium">
                    Format:
                  </label>
                  <select
                    id="export-format-select"
                    aria-label="Export format"
                    value={exportFormat}
                    disabled={isExporting}
                    onChange={(e) => setExportFormat(e.target.value as 'zip' | 'md')}
                    className="rounded-lg border border-stone-300 dark:border-stone-700 bg-transparent px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-stone-500"
                  >
                    <option value="zip">ZIP archive (one .md file per day + weekly/)</option>
                    <option value="md">Single combined Markdown file (.md)</option>
                  </select>
                </div>

                <button
                  type="button"
                  disabled={isExporting}
                  onClick={() => void handleDownloadExport()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-900 text-xs font-medium disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-stone-500"
                >
                  {isExporting && (
                    <span
                      aria-hidden="true"
                      className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
                    />
                  )}
                  <span>{isExporting ? 'Downloading entries…' : 'Download all my entries'}</span>
                </button>
              </div>

              {exportStatusMessage && (
                <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
                  {exportStatusMessage}
                </p>
              )}

              {exportErrorMessage && (
                <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
                  {exportErrorMessage}
                </p>
              )}
            </div>
          </section>
        )}
      </main>

      {/* Unobtrusive bottom status & daily word goal progress bar */}
      <footer className="w-full max-w-3xl mx-auto px-4 py-3 border-t border-stone-200/80 dark:border-stone-800 flex flex-wrap items-center justify-between gap-4 text-xs text-stone-600 dark:text-stone-400">
        <div className="flex items-center gap-3 flex-1 min-w-[200px]">
          <span aria-live="polite" className="font-mono">
            {wordCount} / {dailyWordGoal} words
          </span>
          <div
            role="progressbar"
            aria-label="Daily word goal progress"
            aria-valuenow={wordCount}
            aria-valuemin={0}
            aria-valuemax={dailyWordGoal}
            className="w-32 h-2 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden"
          >
            <div
              className="h-full bg-emerald-600 dark:bg-emerald-500 transition-all motion-reduce:transition-none"
              style={{ width: `${goalProgressPct}%` }}
            />
          </div>
        </div>

        <div
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 rounded-full border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-3 py-1 shadow-sm"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              saveStatus === 'saved' && !isNetworkOffline
                ? 'bg-emerald-500'
                : saveStatus === 'saving'
                  ? 'bg-sky-500'
                  : saveStatus === 'offline' || saveStatus === 'conflict' || isNetworkOffline
                    ? 'bg-amber-500'
                    : 'bg-stone-400'
            }`}
          />
          <span>{statusLabel}</span>
        </div>
      </footer>
    </div>
  );
}

export function App({ queryClient = defaultQueryClient, ...rest }: MorningPagesAppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <MorningPagesShell {...rest} />
    </QueryClientProvider>
  );
}

export default App;
