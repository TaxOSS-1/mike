import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    listNotifications: vi.fn(),
    markNotificationsRead: vi.fn(),
    getNotificationPreferences: vi.fn(),
    setNotificationPreferences: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
}));

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: () => ({ marker: "db" }),
}));

vi.mock("../../modules/notifications/notifications.service", () => ({
    listNotifications: (...args: unknown[]) => mocks.listNotifications(...args),
    markNotificationsRead: (...args: unknown[]) => mocks.markNotificationsRead(...args),
    getNotificationPreferences: (...args: unknown[]) => mocks.getNotificationPreferences(...args),
    setNotificationPreferences: (...args: unknown[]) => mocks.setNotificationPreferences(...args),
}));

import { notificationsRouter } from "../../modules/notifications/notifications.routes";

const app = express();
app.use(express.json());
app.use("/user/notifications", notificationsRouter);

beforeEach(() => {
    vi.clearAllMocks();
});

describe("notifications routes", () => {
    it("lists the caller's notifications with the unread filter and limit", async () => {
        mocks.listNotifications.mockResolvedValue({
            ok: true,
            data: { notifications: [{ id: "n1" }], unread_count: 1 },
        });
        const res = await request(app).get("/user/notifications?unread=1&limit=10");
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("private, no-store");
        expect(res.body).toEqual({ notifications: [{ id: "n1" }], unread_count: 1 });
        expect(mocks.listNotifications).toHaveBeenCalledWith(
            { marker: "db" },
            { userId: "u1", unreadOnly: true, limit: "10" },
        );
    });

    it("marks notifications read by ids or all", async () => {
        mocks.markNotificationsRead.mockResolvedValue({ ok: true, data: { marked: 2 } });
        const res = await request(app).post("/user/notifications/read").send({ ids: ["n1", "n2"] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ marked: 2 });
        expect(mocks.markNotificationsRead).toHaveBeenCalledWith(
            { marker: "db" },
            { userId: "u1", ids: ["n1", "n2"], all: undefined },
        );

        mocks.markNotificationsRead.mockResolvedValue({ ok: false, kind: "validation", detail: "Pass ids or all: true" });
        expect((await request(app).post("/user/notifications/read").send({})).status).toBe(400);
    });

    it("reads and writes the email preference", async () => {
        mocks.getNotificationPreferences.mockResolvedValue({
            ok: true,
            data: { email_mode: "immediate", email_configured: false },
        });
        const got = await request(app).get("/user/notifications/preferences");
        expect(got.status).toBe(200);
        expect(got.body).toEqual({ email_mode: "immediate", email_configured: false });

        mocks.setNotificationPreferences.mockResolvedValue({
            ok: true,
            data: { email_mode: "daily", email_configured: true },
        });
        const put = await request(app).put("/user/notifications/preferences").send({ email_mode: "daily" });
        expect(put.status).toBe(200);
        expect(mocks.setNotificationPreferences).toHaveBeenCalledWith(
            { marker: "db" },
            { userId: "u1", emailMode: "daily" },
        );

        mocks.setNotificationPreferences.mockResolvedValue({
            ok: false,
            kind: "validation",
            detail: "email_mode must be immediate, daily or off",
        });
        const bad = await request(app).put("/user/notifications/preferences").send({ email_mode: "weekly" });
        expect(bad.status).toBe(400);
        expect(bad.body.detail).toBe("email_mode must be immediate, daily or off");
    });
});
