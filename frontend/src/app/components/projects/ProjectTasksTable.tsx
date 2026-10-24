"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, ClipboardList, Plus, RotateCcw } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { RowActions } from "@/app/components/shared/RowActions";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
    TableScrollArea,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
    FORM_CONTROL_GLASS_CLASS,
    FieldLabel,
    FormTextInput,
} from "@/app/components/ui/form-field";
import { DropdownItem } from "@/shared/ui/dropdown";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import type {
    ProjectTask,
    ProjectTaskInput,
    ProjectTaskStatus,
} from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";

export type TaskListFilter = "open" | "all";

export type TaskPerson = {
    email: string;
    display_name: string | null;
};

export type TaskDocumentOption = {
    id: string;
    filename: string;
};

export const TASK_STATUS_LABELS: Record<ProjectTaskStatus, string> = {
    open: "Open",
    in_progress: "In progress",
    done: "Done",
    cancelled: "Cancelled",
};

const STATUS_OPTIONS = (
    Object.keys(TASK_STATUS_LABELS) as ProjectTaskStatus[]
).map((value) => ({ value, label: TASK_STATUS_LABELS[value] }));

const UNASSIGNED = "__unassigned__";
const NO_DOCUMENT = "__none__";

/** Today as YYYY-MM-DD in the viewer's calendar, the same way `due_on` is kept. */
function todayIso(now = new Date()): string {
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
}

/** The due date as the viewer reads it, with "Overdue" while the task is open past it. */
export function dueLabel(task: ProjectTask, today = todayIso()): string {
    if (!task.due_on) return "—";
    const [year, month, day] = task.due_on.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const text = Number.isNaN(date.getTime())
        ? task.due_on
        : date.toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
          });
    const open = task.status === "open" || task.status === "in_progress";
    return open && task.due_on < today ? `${text} · Overdue` : text;
}

export function assigneeLabel(task: ProjectTask): string {
    return task.assignee_display_name || task.assignee_email || "Unassigned";
}

export type TaskDraft = {
    title: string;
    description: string;
    status: ProjectTaskStatus;
    due_on: string;
    assignee_email: string;
    document_id: string;
};

function draftFrom(task: ProjectTask | null): TaskDraft {
    return {
        title: task?.title ?? "",
        description: task?.description ?? "",
        status: task?.status ?? "open",
        due_on: task?.due_on ?? "",
        assignee_email: task?.assignee_email ?? UNASSIGNED,
        document_id: task?.document_id ?? NO_DOCUMENT,
    };
}

/** The request body for a draft: everything the server accepts, nulls for "none". */
export function inputFromDraft(draft: TaskDraft): ProjectTaskInput {
    return {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        status: draft.status,
        due_on: draft.due_on || null,
        assignee_email:
            draft.assignee_email === UNASSIGNED ? null : draft.assignee_email,
        document_id: draft.document_id === NO_DOCUMENT ? null : draft.document_id,
    };
}

export function TaskComposerModal({
    open,
    task,
    people,
    documents,
    saving,
    error,
    onClose,
    onSave,
}: {
    open: boolean;
    /** The task being edited, or null for a new one. */
    task: ProjectTask | null;
    people: TaskPerson[];
    documents: TaskDocumentOption[];
    saving: boolean;
    error: string | null;
    onClose: () => void;
    onSave: (input: ProjectTaskInput) => Promise<void> | void;
}) {
    const [draft, setDraft] = useState<TaskDraft>(() => draftFrom(task));
    const taskId = task?.id ?? null;

    useEffect(() => {
        if (open) setDraft(draftFrom(task));
        // Reset when the modal opens for a different task; the task object
        // itself may be re-created on every list refresh.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, taskId]);

    const assigneeOptions = useMemo(
        () => [
            { value: UNASSIGNED, label: "Unassigned" },
            ...people.map((person) => ({
                value: person.email,
                label: person.display_name?.trim() || person.email,
                suffix: person.display_name?.trim() ? person.email : undefined,
            })),
        ],
        [people],
    );
    const documentOptions = useMemo(
        () => [
            { value: NO_DOCUMENT, label: "No document" },
            ...documents.map((doc) => ({ value: doc.id, label: doc.filename })),
        ],
        [documents],
    );
    const canSave = draft.title.trim().length > 0 && !saving;

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="md"
            breadcrumbs={[task ? "Edit task" : "New task"]}
            footerStatus={
                error ? <span className="text-sm text-red-600">{error}</span> : null
            }
            primaryAction={{
                label: task ? "Save" : "Create",
                disabled: !canSave,
                onClick: () => void onSave(inputFromDraft(draft)),
            }}
        >
            <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (canSave) void onSave(inputFromDraft(draft));
                }}
            >
                <div>
                    <FieldLabel htmlFor="task-title">Title</FieldLabel>
                    <FormTextInput
                        id="task-title"
                        value={draft.title}
                        maxLength={300}
                        autoFocus
                        onChange={(event) =>
                            setDraft((d) => ({ ...d, title: event.target.value }))
                        }
                        placeholder="What needs to be done"
                    />
                </div>
                <div>
                    <FieldLabel htmlFor="task-description">Notes</FieldLabel>
                    <ModalTextarea
                        id="task-description"
                        value={draft.description}
                        maxLength={4000}
                        onChange={(event) =>
                            setDraft((d) => ({ ...d, description: event.target.value }))
                        }
                    />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <FieldLabel htmlFor="task-assignee">Owner</FieldLabel>
                        <ModalSelect
                            id="task-assignee"
                            value={draft.assignee_email}
                            options={assigneeOptions}
                            onChange={(value) =>
                                setDraft((d) => ({ ...d, assignee_email: value }))
                            }
                        />
                    </div>
                    <div>
                        <FieldLabel htmlFor="task-due">Due</FieldLabel>
                        <input
                            id="task-due"
                            type="date"
                            value={draft.due_on}
                            onChange={(event) =>
                                setDraft((d) => ({ ...d, due_on: event.target.value }))
                            }
                            className={cn(FORM_CONTROL_GLASS_CLASS, "h-10")}
                        />
                    </div>
                    <div>
                        <FieldLabel htmlFor="task-status">Status</FieldLabel>
                        <ModalSelect
                            id="task-status"
                            value={draft.status}
                            options={STATUS_OPTIONS}
                            onChange={(value) =>
                                setDraft((d) => ({
                                    ...d,
                                    status: value as ProjectTaskStatus,
                                }))
                            }
                        />
                    </div>
                    <div>
                        <FieldLabel htmlFor="task-document">Document</FieldLabel>
                        <ModalSelect
                            id="task-document"
                            value={draft.document_id}
                            options={documentOptions}
                            onChange={(value) =>
                                setDraft((d) => ({ ...d, document_id: value }))
                            }
                        />
                    </div>
                </div>
                {/* Enter submits; the footer's primary button is the visible control. */}
                <button
                    type="submit"
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                    disabled={!canSave}
                >
                    Submit
                </button>
            </form>
        </Modal>
    );
}

function TasksLoadingRows() {
    return (
        <TableBody>
            {Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={`task-skeleton-${index}`} className="pr-8 md:pr-8">
                    <TableStickyCell>
                        <SkeletonLine className="h-3 w-48" />
                    </TableStickyCell>
                    <TableCell className="ml-auto w-28">
                        <SkeletonLine className="h-3 w-14" />
                    </TableCell>
                    <TableCell className="w-40">
                        <SkeletonLine className="h-3 w-24" />
                    </TableCell>
                    <TableCell className="w-36">
                        <SkeletonLine className="h-3 w-20" />
                    </TableCell>
                    <TableCell className="w-8" />
                </TableRow>
            ))}
        </TableBody>
    );
}

export function ProjectTasksTable({
    tasks,
    loading,
    filter,
    canEdit,
    documentNames,
    onFilterChange,
    onCreate,
    onEdit,
    onSetStatus,
    onDelete,
    renderToolbar,
}: {
    tasks: ProjectTask[];
    loading: boolean;
    filter: TaskListFilter;
    canEdit: boolean;
    /** Filenames by document id, for the row's document column. */
    documentNames: Map<string, string>;
    onFilterChange: (filter: TaskListFilter) => void;
    onCreate: () => void;
    onEdit: (task: ProjectTask) => void;
    onSetStatus: (task: ProjectTask, status: ProjectTaskStatus) => Promise<void> | void;
    onDelete: (task: ProjectTask) => Promise<void> | void;
    renderToolbar?: (actions: ReactNode) => ReactNode;
}) {
    const toolbarActions = (
        <div className="flex items-center gap-1.5">
            <TabPillButtonUI
                active={filter === "open"}
                onClick={() => onFilterChange("open")}
            >
                Open
            </TabPillButtonUI>
            <TabPillButtonUI
                active={filter === "all"}
                onClick={() => onFilterChange("all")}
            >
                All
            </TabPillButtonUI>
            {canEdit && (
                <PillButtonUI tone="black" size="sm" onClick={onCreate} className="ml-2">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    New task
                </PillButtonUI>
            )}
        </div>
    );

    return (
        <>
            {renderToolbar?.(toolbarActions)}
            <TableScrollArea
                header={
                    <TableHeaderRow className="pr-8 md:pr-8">
                        <TableStickyCell header>
                            <span>Task</span>
                        </TableStickyCell>
                        <TableHeaderCell className="ml-auto w-28">Status</TableHeaderCell>
                        <TableHeaderCell className="w-40">Owner</TableHeaderCell>
                        <TableHeaderCell className="w-36">Due</TableHeaderCell>
                        <TableHeaderCell className="w-8" />
                    </TableHeaderRow>
                }
            >
                {loading ? (
                    <TasksLoadingRows />
                ) : tasks.length === 0 ? (
                    <TableEmptyState>
                        <EmptyState
                            icon={<ClipboardList />}
                            title="Tasks"
                            description={
                                filter === "open"
                                    ? "Deadlines and to-dos for this project, with an owner and a due date. Nothing is open."
                                    : "Deadlines and to-dos for this project, with an owner and a due date."
                            }
                            action={
                                canEdit ? (
                                    <PillButtonUI tone="black" size="sm" onClick={onCreate}>
                                        New task
                                    </PillButtonUI>
                                ) : undefined
                            }
                        />
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {tasks.map((task) => {
                            const closed = task.status === "done" || task.status === "cancelled";
                            const documentName = task.document_id
                                ? documentNames.get(task.document_id) ?? null
                                : null;
                            return (
                                <TableRow
                                    key={task.id}
                                    className="pr-8 md:pr-8"
                                    onClick={canEdit ? () => onEdit(task) : undefined}
                                >
                                    <TableStickyCell>
                                        <div className="min-w-0">
                                            <div
                                                className={cn(
                                                    "truncate text-sm",
                                                    closed ? "text-gray-400" : "text-gray-800",
                                                )}
                                            >
                                                {task.title}
                                            </div>
                                            {(task.description || documentName) && (
                                                <div className="truncate text-xs text-gray-500">
                                                    {[documentName, task.description]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </div>
                                            )}
                                        </div>
                                    </TableStickyCell>
                                    <TableCell className="ml-auto w-28 text-xs text-gray-500">
                                        {TASK_STATUS_LABELS[task.status]}
                                    </TableCell>
                                    <TableCell className="w-40 truncate text-xs text-gray-500">
                                        {assigneeLabel(task)}
                                    </TableCell>
                                    <TableCell className="w-36 truncate text-xs text-gray-500">
                                        {dueLabel(task)}
                                    </TableCell>
                                    <TableCell
                                        className="w-8 flex justify-end"
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        {canEdit && (
                                            <RowActions
                                                onRename={() => onEdit(task)}
                                                renameLabel="Edit task"
                                                onDelete={() => onDelete(task)}
                                                deleteLabel="Delete task"
                                                renderItems={(onActionChosen) =>
                                                    closed ? (
                                                        <DropdownItem
                                                            onSelect={() => {
                                                                onActionChosen();
                                                                void onSetStatus(task, "open");
                                                            }}
                                                        >
                                                            <RotateCcw className="h-3.5 w-3.5" />
                                                            Reopen
                                                        </DropdownItem>
                                                    ) : (
                                                        <DropdownItem
                                                            onSelect={() => {
                                                                onActionChosen();
                                                                void onSetStatus(task, "done");
                                                            }}
                                                        >
                                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                                            Mark done
                                                        </DropdownItem>
                                                    )
                                                }
                                            />
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                )}
            </TableScrollArea>
        </>
    );
}
