"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
    SettingsDescription,
    SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
    getNotificationPreferences,
    listNotifications,
    markNotificationsRead,
    setNotificationPreferences,
    type AppNotification,
    type NotificationEmailMode,
    type NotificationPreferences,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";

const EMAIL_MODE_OPTIONS: { value: NotificationEmailMode; label: string }[] = [
    { value: "immediate", label: "As they happen" },
    { value: "daily", label: "Once a day" },
    { value: "off", label: "Never" },
];

export function notificationTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });
}

export default function NotificationsSettingsPage() {
    const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
    const [saving, setSaving] = useState(false);
    const [notifications, setNotifications] = useState<AppNotification[] | null>(null);
    const [unreadCount, setUnreadCount] = useState(0);

    const load = useCallback(async () => {
        try {
            const [prefs, listed] = await Promise.all([
                getNotificationPreferences(),
                listNotifications({ limit: 50 }),
            ]);
            setPreferences(prefs);
            setNotifications(listed.notifications);
            setUnreadCount(listed.unread_count);
        } catch (error) {
            setNotifications([]);
            notifyError(error, {
                action: "load your notifications",
                onRetry: () => void load(),
            });
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    async function changeEmailMode(value: string) {
        const mode = EMAIL_MODE_OPTIONS.find((option) => option.value === value)?.value;
        if (!mode || !preferences || mode === preferences.email_mode) return;
        setSaving(true);
        try {
            setPreferences(await setNotificationPreferences(mode));
        } catch (error) {
            notifyError(error, {
                action: "save your notification preference",
                onRetry: () => void changeEmailMode(mode),
            });
        } finally {
            setSaving(false);
        }
    }

    async function markAllRead() {
        try {
            await markNotificationsRead({ all: true });
            const now = new Date().toISOString();
            setNotifications((prev) =>
                (prev ?? []).map((row) => (row.read_at ? row : { ...row, read_at: now })),
            );
            setUnreadCount(0);
        } catch (error) {
            notifyError(error, {
                action: "mark your notifications read",
                onRetry: () => void markAllRead(),
            });
        }
    }

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <SettingsHeading>Email</SettingsHeading>
                <GlassCardUI>
                    <SettingsRow>
                        <div className="min-w-0 space-y-1">
                            <SettingsLabel>Email me about new notifications</SettingsLabel>
                            <SettingsDescription>
                                A task assigned to you, a project shared with you, a version
                                sent for review or approved, and reminders of tasks due.
                                {preferences && !preferences.email_configured
                                    ? " This deployment has no outgoing email configured, so nothing is sent; your choice is kept."
                                    : ""}
                            </SettingsDescription>
                        </div>
                        <div className="w-44 shrink-0">
                            <ModalSelect
                                id="notification-email-mode"
                                aria-label="Email me about new notifications"
                                value={preferences?.email_mode ?? "immediate"}
                                options={EMAIL_MODE_OPTIONS}
                                disabled={!preferences || saving}
                                onChange={(value) => void changeEmailMode(value)}
                            />
                        </div>
                    </SettingsRow>
                </GlassCardUI>
            </section>

            <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <SettingsHeading>Recent</SettingsHeading>
                    {unreadCount > 0 && (
                        <PillButtonUI tone="white" size="sm" onClick={() => void markAllRead()}>
                            Mark all read
                        </PillButtonUI>
                    )}
                </div>
                <GlassCardUI>
                    {notifications === null ? (
                        <div className="space-y-3 p-4" aria-busy="true">
                            {Array.from({ length: 3 }).map((_, index) => (
                                <div
                                    key={`notification-skeleton-${index}`}
                                    className="h-3 w-2/3 rounded bg-gray-200 animate-pulse"
                                />
                            ))}
                        </div>
                    ) : notifications.length === 0 ? (
                        <SettingsRow>
                            <SettingsDescription>
                                Nothing yet. Notifications appear here when something happens to
                                you in a project or an organization.
                            </SettingsDescription>
                        </SettingsRow>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {notifications.map((row) => (
                                <li key={row.id} className="flex items-start gap-3 px-4 py-3">
                                    <div className="min-w-0 flex-1 space-y-0.5">
                                        <div
                                            className={
                                                row.read_at
                                                    ? "text-sm text-gray-600"
                                                    : "text-sm font-medium text-gray-900"
                                            }
                                        >
                                            {row.href ? (
                                                <Link href={row.href} className="hover:underline">
                                                    {row.title}
                                                </Link>
                                            ) : (
                                                row.title
                                            )}
                                        </div>
                                        {row.body && (
                                            <div className="text-xs text-gray-500">{row.body}</div>
                                        )}
                                    </div>
                                    <div className="shrink-0 text-xs text-gray-400">
                                        {row.read_at ? "" : "Unread · "}
                                        {notificationTime(row.created_at)}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </GlassCardUI>
            </section>
        </div>
    );
}
