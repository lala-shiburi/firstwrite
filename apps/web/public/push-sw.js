/* Morning Pages Push Notification Handler (AGENTS.md Rule 6: Generic text only, focuses existing window on click) */

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Morning Pages',
    body: 'A quiet page is waiting whenever you are ready to write.',
    url: '/',
    tag: 'morning-pages-reminder',
  };

  if (event && event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = {
          title: typeof parsed.title === 'string' ? parsed.title : payload.title,
          body: typeof parsed.body === 'string' ? parsed.body : payload.body,
          url: typeof parsed.url === 'string' ? parsed.url : payload.url,
          tag: typeof parsed.tag === 'string' ? parsed.tag : payload.tag,
        };
      }
    } catch {
      // Fallback to default generic payload
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification && event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus().then((focusedClient) => {
            if (focusedClient && 'navigate' in focusedClient && targetUrl) {
              return focusedClient.navigate(targetUrl);
            }
            return focusedClient;
          });
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
