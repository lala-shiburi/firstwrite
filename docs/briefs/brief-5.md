Brief 5: PWA and responsive polish
Goal: Make the web app installable and feel native on phones and desktops.
Requirements:
Web app manifest (name, icons in all required sizes including maskable, theme
colours, display: standalone , start URL pointing to the writing screen).
Service worker via vite-plugin-pwa : precache the app shell, a sensible update
strategy that prompts the user to reload when a new version is available, and never
cache authenticated API responses or journal content in shared caches.
Offline behaviour: the app shell loads offline and shows a clear offline state. Writing
while offline should queue the entry locally (IndexedDB) and sync when back online,
without ever overwriting a newer server version (use the conflict mechanism from
Brief 4). If this is too large for the first release, implement graceful degradation and
document the gap.
Install prompts: a custom "Install app" affordance on supported browsers, and on iOS
a short instruction explaining Add to Home Screen (needed for push on iOS 16.4+).
Lighthouse PWA and accessibility checks pass.
Acceptance criteria: installable on Chrome desktop, Android Chrome, and iOS Safari (via
Add to Home Screen); passes Lighthouse PWA audit; journal content is demonstrably
absent from the service worker's HTTP caches.
