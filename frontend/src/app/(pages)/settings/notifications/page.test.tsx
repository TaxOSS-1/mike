import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    getNotificationPreferences: vi.fn(),
    listNotifications: vi.fn(),
    markNotificationsRead: vi.fn(),
    setNotificationPreferences: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getNotificationPreferences: (...args: unknown[]) => api.getNotificationPreferences(...args),
    listNotifications: (...args: unknown[]) => api.listNotifications(...args),
    markNotificationsRead: (...args: unknown[]) => api.markNotificationsRead(...args),
    setNotificationPreferences: (...args: unknown[]) => api.setNotificationPreferences(...args),
}));

vi.mock("@/app/lib/userFacingError", () => ({
    notifyError: vi.fn(),
}));

import NotificationsSettingsPage from "./page";

const rows = [
    {
        id: "n1",
        kind: "task.assigned",
        title: "Task assigned to you: File the return",
        body: "Due 2026-11-30.",
        href: "/projects/p1/tasks",
        project_id: "p1",
        document_id: null,
        read_at: null,
        emailed_at: null,
        created_at: "2026-10-23T10:00:00Z",
    },
    {
        id: "n2",
        kind: "project.shared",
        title: "A project was shared with you as editor",
        body: null,
        href: "/projects/p2",
        project_id: "p2",
        document_id: null,
        read_at: "2026-10-22T10:00:00Z",
        emailed_at: null,
        created_at: "2026-10-22T09:00:00Z",
    },
];

beforeEach(() => {
    vi.clearAllMocks();
    api.getNotificationPreferences.mockResolvedValue({ email_mode: "daily", email_configured: false });
    api.listNotifications.mockResolvedValue({ notifications: rows, unread_count: 1 });
    api.markNotificationsRead.mockResolvedValue({ marked: 1 });
    api.setNotificationPreferences.mockImplementation(async (mode: string) => ({
        email_mode: mode,
        email_configured: false,
    }));
});

describe("notifications settings", () => {
    it("shows the preference, says when email is off, and lists notifications with links", async () => {
        render(<NotificationsSettingsPage />);
        expect(await screen.findByText("Task assigned to you: File the return")).toBeInTheDocument();
        expect(screen.getByText(/no outgoing email configured/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "A project was shared with you as editor" })).toHaveAttribute(
            "href",
            "/projects/p2",
        );
        expect(screen.getByText(/Unread ·/)).toBeInTheDocument();
    });

    it("marks everything read and hides the button", async () => {
        render(<NotificationsSettingsPage />);
        const button = await screen.findByRole("button", { name: "Mark all read" });
        await userEvent.setup().click(button);
        expect(api.markNotificationsRead).toHaveBeenCalledWith({ all: true });
        await waitFor(() =>
            expect(screen.queryByRole("button", { name: "Mark all read" })).not.toBeInTheDocument(),
        );
        expect(screen.queryByText(/Unread ·/)).not.toBeInTheDocument();
    });

    it("saves a changed email mode", async () => {
        render(<NotificationsSettingsPage />);
        await screen.findByText("Task assigned to you: File the return");
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /Email me about new notifications/ }));
        await user.click(await screen.findByText("Never"));
        await waitFor(() => expect(api.setNotificationPreferences).toHaveBeenCalledWith("off"));
    });
});
