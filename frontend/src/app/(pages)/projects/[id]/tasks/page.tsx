"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import {
    createProjectTask,
    deleteProjectTask,
    getProjectPeople,
    listProjectTasks,
    updateProjectTask,
    type ProjectTask,
    type ProjectTaskInput,
    type ProjectTaskStatus,
} from "@/app/lib/mikeApi";
import {
    ProjectTasksTable,
    TaskComposerModal,
    type TaskListFilter,
    type TaskPerson,
} from "@/app/components/projects/ProjectTasksTable";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import { notifyError, userFacingApiError } from "@/app/lib/userFacingError";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectTasksPage({ params }: Props) {
    use(params);
    const workspace = useProjectWorkspace();
    const { project, projectId, search, setOwnerOnlyAction } = workspace;
    const canEdit = workspace.canDo("content.edit");

    const [filter, setFilter] = useState<TaskListFilter>("open");
    const [tasks, setTasks] = useState<ProjectTask[] | null>(null);
    const [people, setPeople] = useState<TaskPerson[]>([]);
    const [composer, setComposer] = useState<{ open: boolean; task: ProjectTask | null }>({
        open: false,
        task: null,
    });
    const [saving, setSaving] = useState(false);
    const [composerError, setComposerError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setTasks(await listProjectTasks(projectId, filter));
        } catch (error) {
            setTasks([]);
            notifyError(error, {
                action: "load the tasks",
                onRetry: () => void load(),
            });
        }
    }, [filter, projectId]);

    useEffect(() => {
        setTasks(null);
        void load();
    }, [load]);

    // The owner picker lists everyone who can open the project; the server
    // refuses anyone else, so there is nothing to guess here.
    useEffect(() => {
        if (!canEdit) return;
        let cancelled = false;
        getProjectPeople(projectId)
            .then((listed) => {
                if (cancelled) return;
                const next: TaskPerson[] = [];
                if (listed.owner?.email)
                    next.push({
                        email: listed.owner.email,
                        display_name: listed.owner.display_name ?? null,
                    });
                for (const member of listed.members ?? []) {
                    if (member.role === "deny" || !member.email) continue;
                    next.push({
                        email: member.email,
                        display_name: member.display_name ?? null,
                    });
                }
                setPeople(next);
            })
            .catch(() => {
                if (!cancelled) setPeople([]);
            });
        return () => {
            cancelled = true;
        };
    }, [canEdit, projectId]);

    const documents = useMemo(
        () =>
            (project?.documents ?? []).map((doc) => ({
                id: doc.id,
                filename: doc.filename,
            })),
        [project?.documents],
    );
    const documentNames = useMemo(
        () => new Map(documents.map((doc) => [doc.id, doc.filename] as const)),
        [documents],
    );

    const q = search.trim().toLowerCase();
    const visibleTasks = useMemo(() => {
        const rows = tasks ?? [];
        if (!q) return rows;
        return rows.filter(
            (task) =>
                task.title.toLowerCase().includes(q) ||
                (task.description ?? "").toLowerCase().includes(q) ||
                (task.assignee_display_name ?? "").toLowerCase().includes(q) ||
                (task.assignee_email ?? "").toLowerCase().includes(q),
        );
    }, [q, tasks]);

    function requireEditor(action: string): boolean {
        if (canEdit) return true;
        setOwnerOnlyAction({ action, requiredRole: "editor" });
        return false;
    }

    function openComposer(task: ProjectTask | null) {
        if (!requireEditor(task ? "edit tasks" : "create tasks")) return;
        setComposerError(null);
        setComposer({ open: true, task });
    }

    async function handleSave(input: ProjectTaskInput) {
        setSaving(true);
        setComposerError(null);
        try {
            const saved = composer.task
                ? await updateProjectTask(projectId, composer.task.id, input)
                : await createProjectTask(projectId, input);
            setTasks((prev) => {
                const rows = prev ?? [];
                const index = rows.findIndex((task) => task.id === saved.id);
                if (index === -1) return [...rows, saved];
                return rows.map((task) => (task.id === saved.id ? saved : task));
            });
            setComposer({ open: false, task: null });
            // A task that left the current filter (done while viewing open)
            // disappears on the next load rather than lingering.
            if (filter === "open" && (saved.status === "done" || saved.status === "cancelled"))
                void load();
        } catch (error) {
            setComposerError(
                userFacingApiError(error, "The task could not be saved. Please try again."),
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleSetStatus(task: ProjectTask, status: ProjectTaskStatus) {
        if (!requireEditor("change tasks")) return;
        try {
            const saved = await updateProjectTask(projectId, task.id, { status });
            setTasks((prev) =>
                (prev ?? [])
                    .map((row) => (row.id === saved.id ? saved : row))
                    .filter((row) =>
                        filter === "open"
                            ? row.status === "open" || row.status === "in_progress"
                            : true,
                    ),
            );
        } catch (error) {
            notifyError(error, {
                action: status === "done" ? "mark the task done" : "reopen the task",
                onRetry: () => void handleSetStatus(task, status),
            });
        }
    }

    async function handleDelete(task: ProjectTask) {
        if (!requireEditor("delete tasks")) return;
        // Await first, remove after: a refusal must not make the row vanish
        // and come back on reload with no explanation.
        await deleteProjectTask(projectId, task.id);
        setTasks((prev) => (prev ?? []).filter((row) => row.id !== task.id));
    }

    return (
        <>
            <ProjectTasksTable
                renderToolbar={(actions) => <ProjectSectionToolbar actions={actions} />}
                tasks={visibleTasks}
                loading={tasks === null}
                filter={filter}
                canEdit={canEdit}
                documentNames={documentNames}
                onFilterChange={setFilter}
                onCreate={() => openComposer(null)}
                onEdit={(task) => openComposer(task)}
                onSetStatus={handleSetStatus}
                onDelete={handleDelete}
            />
            <TaskComposerModal
                open={composer.open}
                task={composer.task}
                people={people}
                documents={documents}
                saving={saving}
                error={composerError}
                onClose={() => setComposer({ open: false, task: null })}
                onSave={handleSave}
            />
        </>
    );
}
