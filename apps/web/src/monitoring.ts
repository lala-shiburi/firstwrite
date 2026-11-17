import * as Sentry from '@sentry/react';

export function initializeMonitoring(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.contexts;
      delete event.extra;
      delete event.breadcrumbs;
      delete event.fingerprint;
      event.transaction = 'browser';
      if (event.message) event.message = 'Browser error';
      if (event.logentry) event.logentry = { message: 'Browser error' };
      if (event.exception?.values) {
        event.exception.values = event.exception.values.map((exception) => ({
          ...exception,
          value: 'Browser error',
        }));
      }
      return event;
    },
  });
}
