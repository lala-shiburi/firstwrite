import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: [
        'push-sw.js',
        'icons/icon.svg',
        'icons/apple-touch-icon-180.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable-512.png',
      ],
      manifest: {
        id: '/',
        name: 'Morning Pages',
        short_name: 'Morning Pages',
        description:
          'Write one free-form morning pages journal entry per day. Private, encrypted, distraction-free.',
        theme_color: '#faf8f5',
        background_color: '#faf8f5',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        categories: ['lifestyle', 'productivity'],
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        // Import push & notificationclick handlers so clicking a reminder focuses an existing window or opens '/'
        importScripts: ['/push-sw.js'],
        // Precache only static app shell assets (HTML, JS, CSS, icons, manifest)
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // SPA navigation fallback to index.html, but NEVER intercept /api/* routes
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Strictly enforce NetworkOnly for all /api/* routes so authenticated API responses
        // and decrypted journal content are NEVER stored in the Service Worker HTTP CacheStorage.
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
