// HTTP layer for a person's notifications, mounted at /user/notifications.

import { Router } from "express";
import { sendServiceFailure } from "../../lib/serviceResult";
import { createServerSupabase } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute } from "../../middleware/asyncRoute";
import {
    getNotificationPreferences,
    listNotifications,
    markNotificationsRead,
    setNotificationPreferences,
} from "./notifications.service";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);
notificationsRouter.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
});

// GET /user/notifications?unread=1&limit=50
notificationsRouter.get(
    "/",
    asyncRoute(async (req, res) => {
        const result = await listNotifications(createServerSupabase(), {
            userId: res.locals.userId as string,
            unreadOnly: req.query.unread === "1" || req.query.unread === "true",
            limit: req.query.limit,
        });
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

// POST /user/notifications/read  { ids: [...] } or { all: true }
notificationsRouter.post(
    "/read",
    asyncRoute(async (req, res) => {
        const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
        const result = await markNotificationsRead(createServerSupabase(), {
            userId: res.locals.userId as string,
            ids: body.ids,
            all: body.all,
        });
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

// GET /user/notifications/preferences
notificationsRouter.get(
    "/preferences",
    asyncRoute(async (_req, res) => {
        const result = await getNotificationPreferences(
            createServerSupabase(),
            res.locals.userId as string,
        );
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

// PUT /user/notifications/preferences  { email_mode: "immediate" | "daily" | "off" }
notificationsRouter.put(
    "/preferences",
    asyncRoute(async (req, res) => {
        const body = (req.body ?? {}) as { email_mode?: unknown };
        const result = await setNotificationPreferences(createServerSupabase(), {
            userId: res.locals.userId as string,
            emailMode: body.email_mode,
        });
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);
