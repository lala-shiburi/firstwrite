export interface serializedPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface BrowserPushAdapter {
  isSupported(): boolean;
  getPermissionState(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  subscribe(vapidPublicKey: string): Promise<serializedPushSubscription>;
  getExistingEndpoint(): Promise<string | null>;
  unsubscribe(): Promise<string | null>;
}

/**
 * Converts a URL-safe base64 VAPID public key string into a `Uint8Array<ArrayBuffer>` for `pushManager.subscribe`.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function createDefaultBrowserPushAdapter(): BrowserPushAdapter {
  return {
    isSupported(): boolean {
      return (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        'serviceWorker' in navigator &&
        'PushManager' in window
      );
    },

    getPermissionState(): NotificationPermission {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        return 'default';
      }
      return Notification.permission;
    },

    async requestPermission(): Promise<NotificationPermission> {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        return 'denied';
      }
      return Notification.requestPermission();
    },

    async subscribe(vapidPublicKey: string): Promise<serializedPushSubscription> {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const sub =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));

      const json = sub.toJSON();
      const endpoint = json.endpoint ?? sub.endpoint;
      const p256dh = json.keys?.p256dh ?? '';
      const auth = json.keys?.auth ?? '';

      return {
        endpoint,
        keys: { p256dh, auth },
      };
    },

    async getExistingEndpoint(): Promise<string | null> {
      if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return null;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return null;
      const sub = await registration.pushManager.getSubscription();
      return sub ? sub.endpoint : null;
    },

    async unsubscribe(): Promise<string | null> {
      if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return null;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return null;
      const sub = await registration.pushManager.getSubscription();
      if (!sub) return null;
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      return endpoint;
    },
  };
}
