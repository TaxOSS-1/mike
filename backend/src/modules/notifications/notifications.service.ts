// Notifications: one row per person per thing that happened to them, shown
// in the app and, by their preference, emailed at once, in a daily digest,
// or never.
//
// This file is the module's facade and its implementation. Other modules
// call `notify` when something happens to a person (a task assigned, a
// project shared, a version sent for review); the routes read the list and
// the preference; the job runner and the hourly sweep deliver the email.

import { enqueueDbJob } from "../../lib/dbq/enqueue";
import type { DbJob } from "../../lib/dbq/types";
import { logError } from "../../lib/log";
import { mailConfigured, mailLink, sendMail } from "../../lib/mail/mail";
import { safeError } from "../../lib/safeError";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";

export const NOTIFICATION_EMAIL_MODES = ["immediate", "daily", "off"] as const;
export type NotificationEmailMode = (typeof NOTIFICATION_EMAIL_MODES)[number];

export const NOTIFICATION_EMAIL_JOB = "notification.email";

export const MAX_NOTIFICATION_TITLE_CHARS = 300;
export const MAX_NOTIFICATION_BODY_CHARS = 2000;
export const MAX_NOTIFICATIONS_PAGE = 100;

/** How long a reminder about the same subject is held back. */
export const SUBJECT_REPEAT_WINDOW_MS = 20 * 60 * 60 * 1000;

export type Notification = {
    id: string;
    user_id: string;
    org_id: string | null;
    kind: string;
    title: string;
    body: string | null;
    href: string | null;
    project_id: string | null;
    document_id: string | null;
    subject_type: string | null;
    subject_id: string | null;
    read_at: string | null;
    emailed_at: string | null;
    created_at: string;
};

const COLUMNS =
    "id, user_id, org_id, kind, title, body, href, project_id, document_id, subject_type, subject_id, read_at, emailed_at, created_at";

export type NotifyInput = {
    userId: string;
    orgId?: string | null;
    kind: string;
    title: string;
    body?: string | null;
    /** A path in the web app, starting with a slash. */
    href?: string | null;
    projectId?: string | null;
    documentId?: string | null;
    subjectType?: string | null;
    subjectId?: string | null;
    /**
     * With a subject, skip when the same kind about the same subject was
     * already sent to this person within the repeat window (reminders).
     */
    once?: boolean;
};

function clip(value: string | null | undefined, max: number): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

async function emailPreference(
    db: Db,
    userId: string,
): Promise<{ mode: NotificationEmailMode; email: string | null }> {
    const { data } = await db
        .from("user_profiles")
        .select("email, notification_email_mode")
        .eq("user_id", userId)
        .maybeSingle();
    const row = data as { email?: string | null; notification_email_mode?: string | null } | null;
    const mode = row?.notification_email_mode;
    return {
        mode: isEmailMode(mode) ? mode : "immediate",
        email: row?.email?.trim() || null,
    };
}

export function isEmailMode(value: unknown): value is NotificationEmailMode {
    return (
        typeof value === "string" &&
        (NOTIFICATION_EMAIL_MODES as readonly string[]).includes(value)
    );
}

/**
 * Record that something happened to a person. Never throws: a notification
 * that cannot be written must not fail the action it reports on, so the
 * failure is logged and the caller carries on.
 */
export async function notify(db: Db, input: NotifyInput): Promise<Notification | null> {
    try {
        const title = clip(input.title, MAX_NOTIFICATION_TITLE_CHARS);
        if (!title) return null;
        if (input.once && input.subjectId) {
            const since = new Date(Date.now() - SUBJECT_REPEAT_WINDOW_MS).toISOString();
            const { data: recent } = await db
                .from("notifications")
                .select("id")
                .eq("user_id", input.userId)
                .eq("kind", input.kind)
                .eq("subject_id", input.subjectId)
                .gte("created_at", since)
                .limit(1);
            if ((recent ?? []).length > 0) return null;
        }
        const { data, error } = await db
            .from("notifications")
            .insert({
                user_id: input.userId,
                org_id: input.orgId ?? null,
                kind: input.kind,
                title,
                body: clip(input.body, MAX_NOTIFICATION_BODY_CHARS),
                href: clip(input.href, 500),
                project_id: input.projectId ?? null,
                document_id: input.documentId ?? null,
                subject_type: input.subjectType ?? null,
                subject_id: input.subjectId ?? null,
            })
            .select(COLUMNS)
            .single();
        if (error || !data) throw error ?? new Error("notification insert returned no row");
        const row = data as unknown as Notification;

        if (mailConfigured()) {
            const { mode } = await emailPreference(db, input.userId);
            if (mode === "immediate") await scheduleEmail(db, row);
        }
        return row;
    } catch (error) {
        logError("notifications", safeError(error), { kind: input.kind });
        return null;
    }
}

async function scheduleEmail(db: Db, notification: Notification): Promise<void> {
    try {
        await enqueueDbJob(db, {
            kind: NOTIFICATION_EMAIL_JOB,
            payload: { notificationId: notification.id },
            dedupeKey: `${NOTIFICATION_EMAIL_JOB}:${notification.id}`,
            maxAttempts: 3,
        });
    } catch {
        // No queue: deliver inline rather than lose the message.
        await emailNotifications(db, notification.user_id, [notification]);
    }
}

function formatNotificationText(rows: Notification[]): string {
    return rows
        .map((row) => {
            const lines = [row.title];
            if (row.body) lines.push(row.body);
            if (row.href) lines.push(mailLink(row.href));
            return lines.join("\n");
        })
        .join("\n\n");
}

/**
 * Email the given notifications to one person and mark them emailed. Rows
 * are marked first so a crash mid-send never doubles a message; a send that
 * fails leaves them marked and logged, which is the lesser harm.
 */
async function emailNotifications(db: Db, userId: string, rows: Notification[]): Promise<boolean> {
    const pending = rows.filter((row) => !row.emailed_at);
    if (pending.length === 0) return false;
    const { email } = await emailPreference(db, userId);
    if (!email) return false;
    const ids = pending.map((row) => row.id);
    const { data: claimed, error } = await db
        .from("notifications")
        .update({ emailed_at: new Date().toISOString() })
        .in("id", ids)
        .is("emailed_at", null)
        .select("id");
    if (error) throw error;
    const claimedIds = new Set(((claimed ?? []) as { id: string }[]).map((row) => row.id));
    const toSend = pending.filter((row) => claimedIds.has(row.id));
    if (toSend.length === 0) return false;
    const subject =
        toSend.length === 1 ? toSend[0].title : `${toSend.length} updates from your workspace`;
    const result = await sendMail({ to: email, subject, text: formatNotificationText(toSend) });
    return result.ok;
}

/** Job handler for `notification.email`: deliver one notification now. */
export async function handleNotificationEmail(db: Db, job: DbJob): Promise<void> {
    const notificationId = job.payload.notificationId;
    if (typeof notificationId !== "string") return;
    const { data, error } = await db
        .from("notifications")
        .select(COLUMNS)
        .eq("id", notificationId)
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return;
    const row = data as unknown as Notification;
    if (row.emailed_at) return;
    await emailNotifications(db, row.user_id, [row]);
}

/**
 * Daily digests: one message per person who chose them, with everything
 * not yet emailed. Runs from the hourly sweep; emailed_at makes it
 * idempotent, so a second run in the same hour sends nothing twice.
 */
export async function runNotificationDigestSweep(
    db: Db,
    options: { now?: Date; hourUtc?: number } = {},
): Promise<{ users: number; notifications: number }> {
    if (!mailConfigured()) return { users: 0, notifications: 0 };
    const now = options.now ?? new Date();
    const hour = options.hourUtc ?? digestHourUtc();
    if (now.getUTCHours() !== hour) return { users: 0, notifications: 0 };

    const { data: profiles, error } = await db
        .from("user_profiles")
        .select("user_id, email")
        .eq("notification_email_mode", "daily");
    if (error) throw new Error(error.message);
    let users = 0;
    let notifications = 0;
    for (const profile of (profiles ?? []) as { user_id: string; email: string | null }[]) {
        if (!profile.email) continue;
        const { data: rows, error: rowsError } = await db
            .from("notifications")
            .select(COLUMNS)
            .eq("user_id", profile.user_id)
            .is("emailed_at", null)
            .order("created_at", { ascending: true })
            .limit(MAX_NOTIFICATIONS_PAGE);
        if (rowsError) throw new Error(rowsError.message);
        const pending = (rows ?? []) as unknown as Notification[];
        if (pending.length === 0) continue;
        if (await emailNotifications(db, profile.user_id, pending)) {
            users += 1;
            notifications += pending.length;
        }
    }
    return { users, notifications };
}

/** The UTC hour digests go out; NOTIFICATIONS_DIGEST_HOUR_UTC, default 7. */
export function digestHourUtc(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number.parseInt(env.NOTIFICATIONS_DIGEST_HOUR_UTC ?? "", 10);
    return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 7;
}

export async function listNotifications(
    db: Db,
    args: { userId: string; unreadOnly?: boolean; limit?: unknown },
): Promise<ServiceResult<{ notifications: Notification[]; unread_count: number }>> {
    const parsed = Number.parseInt(String(args.limit ?? ""), 10);
    const limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_NOTIFICATIONS_PAGE) : 50;
    try {
        let query = db.from("notifications").select(COLUMNS).eq("user_id", args.userId);
        if (args.unreadOnly) query = query.is("read_at", null);
        const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
        if (error) return internalFailure(error);
        const { count, error: countError } = await db
            .from("notifications")
            .select("id", { count: "exact", head: true })
            .eq("user_id", args.userId)
            .is("read_at", null);
        if (countError) return internalFailure(countError);
        return ok({ notifications: (data ?? []) as unknown as Notification[], unread_count: count ?? 0 });
    } catch (error) {
        return internalFailure(error);
    }
}

export async function markNotificationsRead(
    db: Db,
    args: { userId: string; ids?: unknown; all?: unknown },
): Promise<ServiceResult<{ marked: number }>> {
    const all = args.all === true;
    const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string") : [];
    if (!all && ids.length === 0) return failure("validation", "Pass ids or all: true");
    try {
        let query = db
            .from("notifications")
            .update({ read_at: new Date().toISOString() })
            .eq("user_id", args.userId)
            .is("read_at", null);
        if (!all) query = query.in("id", ids);
        const { data, error } = await query.select("id");
        if (error) return internalFailure(error);
        return ok({ marked: (data ?? []).length });
    } catch (error) {
        return internalFailure(error);
    }
}

export async function getNotificationPreferences(
    db: Db,
    userId: string,
): Promise<ServiceResult<{ email_mode: NotificationEmailMode; email_configured: boolean }>> {
    try {
        const { mode } = await emailPreference(db, userId);
        return ok({ email_mode: mode, email_configured: mailConfigured() });
    } catch (error) {
        return internalFailure(error);
    }
}

export async function setNotificationPreferences(
    db: Db,
    args: { userId: string; emailMode: unknown },
): Promise<ServiceResult<{ email_mode: NotificationEmailMode; email_configured: boolean }>> {
    if (!isEmailMode(args.emailMode))
        return failure("validation", "email_mode must be immediate, daily or off");
    try {
        const { error } = await db
            .from("user_profiles")
            .update({ notification_email_mode: args.emailMode })
            .eq("user_id", args.userId);
        if (error) return internalFailure(error);
        return ok({ email_mode: args.emailMode, email_configured: mailConfigured() });
    } catch (error) {
        return internalFailure(error);
    }
}
