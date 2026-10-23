import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const mocks = vi.hoisted(() => ({
    enqueueDbJob: vi.fn(),
    sendMail: vi.fn(),
    mailConfigured: vi.fn(() => true),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({
    enqueueDbJob: (...args: unknown[]) => mocks.enqueueDbJob(...args),
}));
vi.mock("../../../lib/mail/mail", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/mail/mail")>()),
    sendMail: (...args: unknown[]) => mocks.sendMail(...args),
    mailConfigured: () => mocks.mailConfigured(),
}));

import {
    handleNotificationEmail,
    listNotifications,
    markNotificationsRead,
    notify,
    runNotificationDigestSweep,
    setNotificationPreferences,
} from "../notifications.service";

type Row = Record<string, unknown>;

/**
 * A small in-memory database: user_profiles and notifications, with the
 * filters the service uses. Inserts get ids and timestamps; updates return
 * the rows they touched, as PostgREST does with `.select()`.
 */
function makeDb(seed: { profiles: Row[]; notifications?: Row[] }) {
    const tables: Record<string, Row[]> = {
        user_profiles: seed.profiles.map((r) => ({ ...r })),
        notifications: (seed.notifications ?? []).map((r) => ({ ...r })),
    };
    let counter = 0;
    const from = (table: string) => {
        const filters: ((row: Row) => boolean)[] = [];
        let op: "select" | "insert" | "update" = "select";
        let payload: Row = {};
        let limitN: number | null = null;
        let head = false;
        const q: Record<string, unknown> = {};
        q.select = (_cols?: string, opts?: { head?: boolean }) => {
            head = !!opts?.head;
            return q;
        };
        q.eq = (col: string, val: unknown) => {
            filters.push((row) => row[col] === val);
            return q;
        };
        q.is = (col: string, val: unknown) => {
            filters.push((row) => (row[col] ?? null) === val);
            return q;
        };
        q.in = (col: string, vals: unknown[]) => {
            filters.push((row) => vals.includes(row[col]));
            return q;
        };
        q.gte = (col: string, val: string) => {
            filters.push((row) => String(row[col]) >= val);
            return q;
        };
        q.order = () => q;
        q.limit = (n: number) => {
            limitN = n;
            return q;
        };
        q.insert = (value: Row) => {
            op = "insert";
            payload = value;
            return q;
        };
        q.update = (value: Row) => {
            op = "update";
            payload = value;
            return q;
        };
        const settle = () => {
            const rows = tables[table] ?? [];
            if (op === "insert") {
                counter += 1;
                const row = {
                    id: `n${counter}`,
                    read_at: null,
                    emailed_at: null,
                    created_at: new Date(2026, 9, 23, 10, 0, counter).toISOString(),
                    ...payload,
                };
                rows.push(row);
                return { data: [row], error: null, count: null };
            }
            const hits = rows.filter((row) => filters.every((f) => f(row)));
            if (op === "update") {
                for (const row of hits) Object.assign(row, payload);
                return { data: hits, error: null, count: null };
            }
            const data = limitN != null ? hits.slice(0, limitN) : hits;
            return { data: head ? null : data, error: null, count: hits.length };
        };
        q.single = async () => {
            const r = settle();
            return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error };
        };
        q.maybeSingle = q.single;
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
        return q;
    };
    return { db: { from } as unknown as Db, tables };
}

const profiles = [
    { user_id: "u1", email: "u1@example.test", notification_email_mode: "immediate" },
    { user_id: "u2", email: "u2@example.test", notification_email_mode: "daily" },
    { user_id: "u3", email: "u3@example.test", notification_email_mode: "off" },
];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.mailConfigured.mockReturnValue(true);
    mocks.enqueueDbJob.mockResolvedValue({ id: "job", deduped: false });
    mocks.sendMail.mockResolvedValue({ ok: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("notify", () => {
    it("stores the row and queues an email for someone who wants them at once", async () => {
        const { db, tables } = makeDb({ profiles });
        const row = await notify(db, {
            userId: "u1",
            kind: "task.assigned",
            title: "Task assigned to you: File the return",
            body: "Due 2026-11-30.",
            href: "/projects/p1/tasks",
            projectId: "p1",
            subjectType: "task",
            subjectId: "t1",
        });
        expect(row).toMatchObject({ id: "n1", user_id: "u1", kind: "task.assigned" });
        expect(tables.notifications).toHaveLength(1);
        expect(mocks.enqueueDbJob).toHaveBeenCalledWith(
            db,
            expect.objectContaining({
                kind: "notification.email",
                payload: { notificationId: "n1" },
                dedupeKey: "notification.email:n1",
            }),
        );
    });

    it("leaves daily and off recipients to the digest, or to the app alone", async () => {
        const { db } = makeDb({ profiles });
        await notify(db, { userId: "u2", kind: "project.shared", title: "Shared" });
        await notify(db, { userId: "u3", kind: "project.shared", title: "Shared" });
        expect(mocks.enqueueDbJob).not.toHaveBeenCalled();
        expect(mocks.sendMail).not.toHaveBeenCalled();
    });

    it("queues nothing when the deployment has no mail, and clips long text", async () => {
        mocks.mailConfigured.mockReturnValue(false);
        const { db, tables } = makeDb({ profiles });
        const row = await notify(db, { userId: "u1", kind: "x", title: "t".repeat(400) });
        expect(row?.title).toHaveLength(300);
        expect(tables.notifications).toHaveLength(1);
        expect(mocks.enqueueDbJob).not.toHaveBeenCalled();
    });

    it("sends inline when the queue is unavailable", async () => {
        mocks.enqueueDbJob.mockRejectedValue(new Error("no queue"));
        const { db, tables } = makeDb({ profiles });
        await notify(db, { userId: "u1", kind: "x", title: "Hello", href: "/projects/p1" });
        expect(mocks.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({ to: "u1@example.test", subject: "Hello" }),
        );
        expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({
            text: expect.stringContaining("http://localhost:3000/projects/p1"),
        });
        expect(tables.notifications[0].emailed_at).toBeTruthy();
    });

    it("holds back a repeat about the same subject within the window", async () => {
        const { db, tables } = makeDb({ profiles });
        const first = await notify(db, {
            userId: "u3",
            kind: "task.due",
            title: "Due soon",
            subjectType: "task",
            subjectId: "t1",
            once: true,
        });
        const repeat = await notify(db, {
            userId: "u3",
            kind: "task.due",
            title: "Due soon",
            subjectType: "task",
            subjectId: "t1",
            once: true,
        });
        expect(first).not.toBeNull();
        expect(repeat).toBeNull();
        expect(tables.notifications).toHaveLength(1);
    });

    it("never throws into the caller", async () => {
        const broken = {
            from: () => {
                throw new Error("database down");
            },
        } as unknown as Db;
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await notify(broken, { userId: "u1", kind: "x", title: "t" })).toBeNull();
    });
});

describe("handleNotificationEmail", () => {
    it("emails one unsent notification and marks it, and skips one already sent", async () => {
        const { db, tables } = makeDb({
            profiles,
            notifications: [
                { id: "n1", user_id: "u1", kind: "x", title: "Hello", body: null, href: null, emailed_at: null },
                { id: "n2", user_id: "u1", kind: "x", title: "Old", emailed_at: "2026-10-01T00:00:00Z" },
            ],
        });
        const job = { payload: { notificationId: "n1" } } as never;
        await handleNotificationEmail(db, job);
        expect(mocks.sendMail).toHaveBeenCalledTimes(1);
        expect(tables.notifications[0].emailed_at).toBeTruthy();
        await handleNotificationEmail(db, { payload: { notificationId: "n2" } } as never);
        expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    });
});

describe("runNotificationDigestSweep", () => {
    it("sends one digest per daily recipient in its hour and nothing outside it", async () => {
        const { db, tables } = makeDb({
            profiles,
            notifications: [
                { id: "n1", user_id: "u2", kind: "x", title: "First", body: "A", href: "/a", emailed_at: null, created_at: "2026-10-23T01:00:00Z" },
                { id: "n2", user_id: "u2", kind: "x", title: "Second", body: null, href: null, emailed_at: null, created_at: "2026-10-23T02:00:00Z" },
                { id: "n3", user_id: "u1", kind: "x", title: "Immediate person", emailed_at: null, created_at: "2026-10-23T02:00:00Z" },
            ],
        });
        const wrongHour = await runNotificationDigestSweep(db, {
            now: new Date("2026-10-23T05:30:00Z"),
            hourUtc: 7,
        });
        expect(wrongHour).toEqual({ users: 0, notifications: 0 });
        expect(mocks.sendMail).not.toHaveBeenCalled();

        const result = await runNotificationDigestSweep(db, {
            now: new Date("2026-10-23T07:10:00Z"),
            hourUtc: 7,
        });
        expect(result).toEqual({ users: 1, notifications: 2 });
        expect(mocks.sendMail).toHaveBeenCalledTimes(1);
        expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({
            to: "u2@example.test",
            subject: "2 updates from your workspace",
        });
        expect(tables.notifications.filter((r) => r.user_id === "u2").every((r) => r.emailed_at)).toBe(true);
        // The immediate recipient's row is the email job's business, not the digest's.
        expect(tables.notifications.find((r) => r.id === "n3")?.emailed_at).toBeNull();

        const again = await runNotificationDigestSweep(db, {
            now: new Date("2026-10-23T07:40:00Z"),
            hourUtc: 7,
        });
        expect(again).toEqual({ users: 0, notifications: 0 });
    });
});

describe("reading and preferences", () => {
    it("lists a person's own notifications newest first with the unread count, and marks them read", async () => {
        const { db } = makeDb({
            profiles,
            notifications: [
                { id: "n1", user_id: "u1", kind: "x", title: "A", read_at: null, created_at: "2026-10-23T01:00:00Z" },
                { id: "n2", user_id: "u1", kind: "x", title: "B", read_at: "2026-10-23T02:00:00Z", created_at: "2026-10-23T02:00:00Z" },
                { id: "n3", user_id: "u2", kind: "x", title: "Other person", read_at: null, created_at: "2026-10-23T03:00:00Z" },
            ],
        });
        const listed = await listNotifications(db, { userId: "u1" });
        expect(listed).toMatchObject({ ok: true, data: { unread_count: 1 } });
        if (listed.ok) expect(listed.data.notifications.map((n) => n.id)).toEqual(["n1", "n2"]);

        const unread = await listNotifications(db, { userId: "u1", unreadOnly: true });
        if (unread.ok) expect(unread.data.notifications.map((n) => n.id)).toEqual(["n1"]);

        expect(await markNotificationsRead(db, { userId: "u1" })).toMatchObject({ ok: false, kind: "validation" });
        // Another person's id is not theirs to mark: the user filter scopes it out.
        expect(await markNotificationsRead(db, { userId: "u1", ids: ["n1", "n3"] })).toEqual({
            ok: true,
            data: { marked: 1 },
        });
        const after = await listNotifications(db, { userId: "u2" });
        if (after.ok) expect(after.data.unread_count).toBe(1);
    });

    it("validates and stores the email mode", async () => {
        const { db, tables } = makeDb({ profiles });
        expect(await setNotificationPreferences(db, { userId: "u1", emailMode: "weekly" })).toMatchObject({
            ok: false,
            kind: "validation",
        });
        expect(await setNotificationPreferences(db, { userId: "u1", emailMode: "daily" })).toEqual({
            ok: true,
            data: { email_mode: "daily", email_configured: true },
        });
        expect(tables.user_profiles[0].notification_email_mode).toBe("daily");
    });
});
