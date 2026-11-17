import * as Sentry from '@sentry/node';

let enabled = false;

export function initializeMonitoring(dsn: string | undefined): void {
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
      event.transaction = 'server';
      if (event.message) event.message = 'Server error';
      if (event.logentry) event.logentry = { message: 'Server error' };
      if (event.exception?.values) {
        event.exception.values = event.exception.values.map((exception) => ({
          ...exception,
          value: 'Server error',
        }));
      }
      return event;
    },
  });
  enabled = true;
}

export function captureServerError(error: unknown): void {
  if (enabled) Sentry.captureException(error);
}
