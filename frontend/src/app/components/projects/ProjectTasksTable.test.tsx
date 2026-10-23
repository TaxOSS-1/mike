import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectTask } from "@/app/lib/mikeApi";
import {
    ProjectTasksTable,
    TaskComposerModal,
    assigneeLabel,
    dueLabel,
    inputFromDraft,
} from "./ProjectTasksTable";

const base: ProjectTask = {
    id: "t1",
    project_id: "p1",
    document_id: "d1",
    title: "File the FY2025 CIT return",
    description: "Prepayments reconcile first.",
    status: "open",
    assignee_user_id: "u2",
    assignee_email: "jamie@example.com",
    assignee_display_name: "Jamie Morgan",
    due_on: "2026-11-30",
    created_by: "u1",
    completed_at: null,
    created_at: "2026-10-23T10:00:00Z",
    updated_at: "2026-10-23T10:00:00Z",
};
const done: ProjectTask = {
    ...base,
    id: "t2",
    title: "Send the trial balance",
    description: null,
    document_id: null,
    status: "done",
    assignee_user_id: null,
    assignee_email: null,
    assignee_display_name: null,
    due_on: null,
    completed_at: "2026-10-22T10:00:00Z",
};

function renderTable(overrides: Partial<Parameters<typeof ProjectTasksTable>[0]> = {}) {
    const props = {
        tasks: [base, done],
        loading: false,
        filter: "all" as const,
        canEdit: true,
        documentNames: new Map([["d1", "CIT return FY2025.pdf"]]),
        onFilterChange: vi.fn(),
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onSetStatus: vi.fn(),
        onDelete: vi.fn(),
        renderToolbar: (actions: React.ReactNode) => <div>{actions}</div>,
        ...overrides,
    };
    render(<ProjectTasksTable {...props} />);
    return props;
}

describe("task presentation helpers", () => {
    it("shows the owner by name, then email, then Unassigned", () => {
        expect(assigneeLabel(base)).toBe("Jamie Morgan");
        expect(assigneeLabel({ ...base, assignee_display_name: null })).toBe("jamie@example.com");
        expect(assigneeLabel(done)).toBe("Unassigned");
    });

    it("marks an open task past its date as overdue, never a closed one", () => {
        expect(dueLabel(base, "2026-11-01")).not.toMatch(/Overdue/);
        expect(dueLabel(base, "2026-12-01")).toMatch(/Overdue$/);
        expect(dueLabel({ ...base, status: "done" }, "2026-12-01")).not.toMatch(/Overdue/);
        expect(dueLabel(done)).toBe("—");
    });

    it("turns the composer draft into the request the server accepts", () => {
        expect(
            inputFromDraft({
                title: "  Task ",
                description: " ",
                status: "in_progress",
                due_on: "",
                assignee_email: "__unassigned__",
                document_id: "__none__",
            }),
        ).toEqual({
            title: "Task",
            description: null,
            status: "in_progress",
            due_on: null,
            assignee_email: null,
            document_id: null,
        });
    });
});

describe("ProjectTasksTable", () => {
    it("renders status, owner, due date and the document as plain text", () => {
        renderTable();
        expect(screen.getByText("File the FY2025 CIT return")).toBeInTheDocument();
        expect(screen.getByText(/CIT return FY2025\.pdf · Prepayments reconcile first\./)).toBeInTheDocument();
        // The status column is plain text; "Open" is also the filter button.
        expect(screen.getByText("Open", { selector: "div" })).toBeInTheDocument();
        expect(screen.getByText("Done", { selector: "div" })).toBeInTheDocument();
        expect(screen.getByText("Jamie Morgan")).toBeInTheDocument();
        expect(screen.getByText("Unassigned")).toBeInTheDocument();
    });

    it("offers Mark done on an open task and Reopen on a closed one", async () => {
        const props = renderTable();
        const user = userEvent.setup();
        const menus = screen.getAllByRole("button", { name: "Open row actions" });
        await user.click(menus[0]);
        await user.click(screen.getByText("Mark done"));
        expect(props.onSetStatus).toHaveBeenCalledWith(base, "done");

        await user.click(menus[1]);
        await user.click(screen.getByText("Reopen"));
        expect(props.onSetStatus).toHaveBeenCalledWith(done, "open");
    });

    it("hides every write affordance from a viewer", () => {
        renderTable({ canEdit: false });
        expect(screen.queryByRole("button", { name: "Open row actions" })).not.toBeInTheDocument();
        expect(screen.queryByText("New task")).not.toBeInTheDocument();
    });

    it("shows an empty state with the create action and switches the filter", async () => {
        const props = renderTable({ tasks: [], filter: "open" });
        const user = userEvent.setup();
        expect(screen.getByText(/Nothing is open\./)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "All" }));
        expect(props.onFilterChange).toHaveBeenCalledWith("all");
        await user.click(screen.getAllByRole("button", { name: "New task" })[0]);
        expect(props.onCreate).toHaveBeenCalled();
    });
});

describe("TaskComposerModal", () => {
    it("requires a title and submits the draft as a request body", async () => {
        const onSave = vi.fn();
        render(
            <TaskComposerModal
                open
                task={null}
                people={[{ email: "jamie@example.com", display_name: "Jamie Morgan" }]}
                documents={[{ id: "d1", filename: "CIT return FY2025.pdf" }]}
                saving={false}
                error={null}
                onClose={vi.fn()}
                onSave={onSave}
            />,
        );
        const user = userEvent.setup();
        const create = screen.getByRole("button", { name: "Create" });
        expect(create).toBeDisabled();
        await user.type(screen.getByLabelText("Title"), "File the return");
        await user.type(screen.getByLabelText("Due"), "2026-11-30");
        await user.click(create);
        expect(onSave).toHaveBeenCalledWith({
            title: "File the return",
            description: null,
            status: "open",
            due_on: "2026-11-30",
            assignee_email: null,
            document_id: null,
        });
    });

    it("shows the server's refusal and keeps the draft", () => {
        render(
            <TaskComposerModal
                open
                task={{ ...base }}
                people={[]}
                documents={[]}
                saving={false}
                error="Only people with access to this project can be assigned a task."
                onClose={vi.fn()}
                onSave={vi.fn()}
            />,
        );
        expect(screen.getByLabelText("Title")).toHaveValue("File the FY2025 CIT return");
        expect(
            screen.getByText("Only people with access to this project can be assigned a task."),
        ).toBeInTheDocument();
    });
});
