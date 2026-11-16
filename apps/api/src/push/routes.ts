import {
  pushSubscribeRequestSchema,
  pushUnsubscribeRequestSchema,
  type PushSubscriptionItem,
} from '@firstwrite/shared';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { AppError } from '../app.js';
import type { AppConfig } from '../config.js';
import type { PushRepository } from './repository.js';

export interface PushRouterOptions {
  config: AppConfig;
  repo: PushRepository;
  requireAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  requireCsrf: (req: Request, res: Response, next: NextFunction) => void;
  now?: () => Date;
}

export function createPushRouter({
  config,
  repo,
  requireAuth,
  requireCsrf,
  now = () => new Date(),
}: PushRouterOptions): Router {
  const router = express.Router();

  // ───────────── GET /api/push/vapid-public-key ─────────────
  router.get('/api/push/vapid-public-key', (_req: Request, res: Response) => {
    res.status(200).json({ publicKey: config.VAPID_PUBLIC_KEY });
  });

  // ───────────── GET /api/push/subscriptions (List user's subscribed devices) ─────────────
  router.get('/api/push/subscriptions', requireAuth, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const subs = await repo.listSubscriptionsForUser(user.id);
    const items: PushSubscriptionItem[] = subs.map((s) => ({
      id: s.id.toString(),
      endpoint: s.endpoint,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
    }));

    res.status(200).json({ subscriptions: items });
  });

  // ───────────── POST /api/push/subscribe (Register or update a device push subscription) ─────────────
  router.post(
    '/api/push/subscribe',
    requireAuth,
    requireCsrf,
    async (req: Request, res: Response) => {
      const { user } = req.auth!;
      const body = pushSubscribeRequestSchema.parse(req.body);
      const userAgent =
        typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;

      const record = await repo.upsertSubscription({
        userId: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
        now: now(),
      });

      const item: PushSubscriptionItem = {
        id: record.id.toString(),
        endpoint: record.endpoint,
        userAgent: record.userAgent,
        createdAt: record.createdAt.toISOString(),
      };

      res.status(201).json({ subscription: item });
    },
  );

  // ───────────── DELETE /api/push/subscribe (Unsubscribe a device endpoint) ─────────────
  router.delete(
    '/api/push/subscribe',
    requireAuth,
    requireCsrf,
    async (req: Request, res: Response) => {
      const { user } = req.auth!;
      const body = pushUnsubscribeRequestSchema.parse(req.body);

      const deleted = await repo.deleteSubscriptionByEndpoint(user.id, body.endpoint);
      if (!deleted) {
        throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'Push subscription not found');
      }

      res.status(200).json({ status: 'ok' });
    },
  );

  return router;
}
