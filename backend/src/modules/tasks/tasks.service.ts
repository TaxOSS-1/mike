// Tasks on a project: a title, an owner, a due date and a status, optionally
// tied to one document.
//
// This file is the module's facade and, the module being small, its
// implementation. Reading tasks needs access to the project; creating,
// changing and deleting them is content work (content.edit). The assignee
// must already have access to the project: a task names who is responsible,
// it never grants anything.

import { checkProjectAccess, normalizeEmail } from "../../lib/access";
import { recordAudit } from "../../lib/audit";
import { can } from "../../lib/permissions";
import { listProjectPeople } from "../../lib/projectAccess";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import { notify } from "../notifications/notifications.service";

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskStatusFilter = "open" | "done" | "all";

export const MAX_TASK_TITLE_CHARS = 300;
export const MAX_TASK_DESCRIPTION_CHARS = 4000;

export type ProjectTask = {
  id: string;
  project_id: string;
  document_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee_user_id: string | null;
  assignee_email: string | null;
  /** Resolved from the project's people on read; never stored. */
  assignee_display_name: string | null;
  due_on: string | null;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

const TASK_COLUMNS =
  "id, project_id, document_id, title, description, status, assignee_user_id, assignee_email, due_on, created_by, completed_at, created_at, updated_at";

const TASK_EDIT_FORBIDDEN = "Only project editors and owners can change tasks.";

type TaskRow = Omit<ProjectTask, "assignee_display_name">;

type ProjectForPeople = {
  id: string;
  user_id: string | null;
  org_id?: string | null;
  visibility?: string | null;
};

type Person = { user_id: string | null; email: string | null; display_name: string | null };

/** Everyone who can open the project, by lower-cased email. Fails soft. */
async function projectPeople(db: Db, project: ProjectForPeople): Promise<Person[]> {
  const listed = await listProjectPeople(db, project);
  if (!listed.ok) return [];
  const people: Person[] = [];
  if (listed.owner)
    people.push({
      user_id: listed.owner.user_id,
      email: listed.owner.email,
      display_name: listed.owner.display_name,
    });
  for (const member of listed.members) {
    if (member.role === "deny") continue;
    people.push({
      user_id: member.user_id ?? null,
      email: member.email,
      display_name: member.display_name,
    });
  }
  return people;
}

function withNames(rows: TaskRow[], people: Person[]): ProjectTask[] {
  const byUser = new Map<string, Person>();
  const byEmail = new Map<string, Person>();
  for (const person of people) {
    if (person.user_id) byUser.set(person.user_id, person);
    const email = normalizeEmail(person.email);
    if (email) byEmail.set(email, person);
  }
  return rows.map((row) => {
    const person =
      (row.assignee_user_id ? byUser.get(row.assignee_user_id) : undefined) ??
      (row.assignee_email ? byEmail.get(row.assignee_email) : undefined);
    return {
      ...row,
      assignee_display_name: person?.display_name?.trim() || null,
    };
  });
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function parseTaskStatusFilter(value: unknown): TaskStatusFilter | null {
  if (value === undefined || value === null || value === "") return "open";
  if (value === "open" || value === "done" || value === "all") return value;
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date as YYYY-MM-DD, or an explanation of why the input is not one. */
export function parseDueOn(value: unknown): { ok: true; due_on: string | null } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "") return { ok: true, due_on: null };
  if (typeof value !== "string" || !DATE_RE.test(value))
    return { ok: false, detail: "due_on must be a date as YYYY-MM-DD" };
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    return { ok: false, detail: "due_on must be a valid calendar date" };
  return { ok: true, due_on: value };
}

type Validated = {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  due_on?: string | null;
  document_id?: string | null;
  assignee?: { user_id: string | null; email: string } | null;
};

async function validateTaskInput(
  db: Db,
  body: Record<string, unknown>,
  project: ProjectForPeople,
  mode: "create" | "update",
): Promise<{ ok: true; values: Validated } | { ok: false; detail: string }> {
  const values: Validated = {};
  if ("title" in body || mode === "create") {
    if (typeof body.title !== "string" || !body.title.trim())
      return { ok: false, detail: "title is required" };
    const title = body.title.trim();
    if (title.length > MAX_TASK_TITLE_CHARS)
      return { ok: false, detail: `title must be at most ${MAX_TASK_TITLE_CHARS} characters` };
    values.title = title;
  }
  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string")
      return { ok: false, detail: "description must be a string" };
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length > MAX_TASK_DESCRIPTION_CHARS)
      return {
        ok: false,
        detail: `description must be at most ${MAX_TASK_DESCRIPTION_CHARS} characters`,
      };
    values.description = description || null;
  }
  if ("status" in body) {
    if (!isTaskStatus(body.status))
      return { ok: false, detail: "status must be open, in_progress, done or cancelled" };
    values.status = body.status;
  }
  if ("due_on" in body) {
    const due = parseDueOn(body.due_on);
    if (!due.ok) return due;
    values.due_on = due.due_on;
  }
  if ("document_id" in body) {
    if (body.document_id === null || body.document_id === "") values.document_id = null;
    else if (typeof body.document_id !== "string")
      return { ok: false, detail: "document_id must be a document id" };
    else {
      // The document has to live in this project: a task may not point into
      // another matter, and the check doubles as the access check.
      const { data, error } = await db
        .from("documents")
        .select("id")
        .eq("id", body.document_id)
        .eq("project_id", project.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { ok: false, detail: "document_id must name a document in this project" };
      values.document_id = body.document_id;
    }
  }
  if ("assignee_email" in body) {
    if (body.assignee_email === null || body.assignee_email === "") values.assignee = null;
    else {
      const email = normalizeEmail(typeof body.assignee_email === "string" ? body.assignee_email : null);
      if (!email || !email.includes("@"))
        return { ok: false, detail: "assignee_email must be an email address" };
      const person = (await projectPeople(db, project)).find(
        (candidate) => candidate.email && normalizeEmail(candidate.email) === email,
      );
      if (!person)
        return {
          ok: false,
          detail: "Only people with access to this project can be assigned a task.",
        };
      values.assignee = { user_id: person.user_id, email };
    }
  }
  return { ok: true, values };
}

export async function listProjectTasks(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string; status?: unknown },
): Promise<ServiceResult<{ tasks: ProjectTask[] }>> {
  const filter = parseTaskStatusFilter(args.status);
  if (!filter) return failure("validation", "status must be open, done or all");
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");
  try {
    let query = db
      .from("project_tasks")
      .select(TASK_COLUMNS)
      .eq("project_id", args.projectId);
    if (filter === "open") query = query.in("status", ["open", "in_progress"]);
    else if (filter === "done") query = query.in("status", ["done", "cancelled"]);
    const { data, error } = await query
      .order("due_on", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    if (error) return internalFailure(error);
    const rows = (data ?? []) as unknown as TaskRow[];
    const people = rows.some((row) => row.assignee_user_id || row.assignee_email)
      ? await projectPeople(db, access.project)
      : [];
    return ok({ tasks: withNames(rows, people) });
  } catch (error) {
    return internalFailure(error);
  }
}

export async function createProjectTask(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string; body: Record<string, unknown> },
): Promise<ServiceResult<{ task: ProjectTask }>> {
  const { projectId, userId, userEmail } = args;
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");
  if (!can(access.projectRole, "content.edit")) return failure("forbidden", TASK_EDIT_FORBIDDEN);
  try {
    const validated = await validateTaskInput(db, args.body ?? {}, access.project, "create");
    if (!validated.ok) return failure("validation", validated.detail);
    const { values } = validated;
    const status = values.status ?? "open";
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("project_tasks")
      .insert({
        project_id: projectId,
        document_id: values.document_id ?? null,
        title: values.title,
        description: values.description ?? null,
        status,
        assignee_user_id: values.assignee?.user_id ?? null,
        assignee_email: values.assignee?.email ?? null,
        due_on: values.due_on ?? null,
        created_by: userId,
        completed_at: status === "done" ? now : null,
      })
      .select(TASK_COLUMNS)
      .single();
    if (error || !data) return internalFailure(error ?? new Error("task insert returned no row"));
    const row = data as unknown as TaskRow;
    await recordAudit(db, {
      userId,
      userEmail,
      orgId: access.project.org_id ?? null,
      action: "task.created",
      title: row.title,
      surface: "project",
      projectId,
      documentId: row.document_id,
      detail: {
        org_id: access.project.org_id ?? null,
        task_id: row.id,
        status: row.status,
        due_on: row.due_on,
        ...(row.assignee_user_id ? { target_user_id: row.assignee_user_id } : {}),
        ...(row.assignee_email ? { target_email: row.assignee_email } : {}),
      },
    });
    const people = row.assignee_user_id || row.assignee_email
      ? await projectPeople(db, access.project)
      : [];
    await notifyAssignee(db, row, userId, access.project.org_id ?? null);
    return ok({ task: withNames([row], people)[0] });
  } catch (error) {
    return internalFailure(error);
  }
}

/** Tell the owner of a task about it, unless they gave it to themselves. */
async function notifyAssignee(
  db: Db,
  task: TaskRow,
  actorId: string,
  orgId: string | null,
): Promise<void> {
  if (!task.assignee_user_id || task.assignee_user_id === actorId) return;
  await notify(db, {
    userId: task.assignee_user_id,
    orgId,
    kind: "task.assigned",
    title: `Task assigned to you: ${task.title}`,
    body: task.due_on ? `Due ${task.due_on}.` : null,
    href: `/projects/${task.project_id}/tasks`,
    projectId: task.project_id,
    documentId: task.document_id,
    subjectType: "task",
    subjectId: task.id,
  });
}

/**
 * Once a day, remind every owner of an open task that is due within two
 * days or overdue. Rate-limited per task by `notify`'s repeat window, so the
 * hourly caller can run it freely; it only acts in its own hour.
 */
export async function runTaskReminderSweep(
  db: Db,
  options: { now?: Date; hourUtc?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const hour = options.hourUtc ?? taskReminderHourUtc();
  if (now.getUTCHours() !== hour) return 0;
  const horizon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const { data, error } = await db
    .from("project_tasks")
    .select(TASK_COLUMNS)
    .in("status", ["open", "in_progress"])
    .not("assignee_user_id", "is", null)
    .lte("due_on", horizon)
    .order("due_on", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  let sent = 0;
  for (const row of (data ?? []) as unknown as TaskRow[]) {
    if (!row.assignee_user_id || !row.due_on) continue;
    const overdue = row.due_on < today;
    const created = await notify(db, {
      userId: row.assignee_user_id,
      kind: overdue ? "task.overdue" : "task.due",
      title: overdue ? `Overdue: ${row.title}` : `Due soon: ${row.title}`,
      body: `Due ${row.due_on}.`,
      href: `/projects/${row.project_id}/tasks`,
      projectId: row.project_id,
      documentId: row.document_id,
      subjectType: "task",
      subjectId: row.id,
      once: true,
    });
    if (created) sent += 1;
  }
  return sent;
}

/** The UTC hour reminders go out; TASK_REMINDER_HOUR_UTC, default 6. */
export function taskReminderHourUtc(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.TASK_REMINDER_HOUR_UTC ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 6;
}

export async function updateProjectTask(
  db: Db,
  args: {
    projectId: string;
    taskId: string;
    userId: string;
    userEmail?: string;
    body: Record<string, unknown>;
  },
): Promise<ServiceResult<{ task: ProjectTask }>> {
  const { projectId, taskId, userId, userEmail } = args;
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");
  if (!can(access.projectRole, "content.edit")) return failure("forbidden", TASK_EDIT_FORBIDDEN);
  try {
    const { data: existing, error: readError } = await db
      .from("project_tasks")
      .select(TASK_COLUMNS)
      .eq("id", taskId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (readError) return internalFailure(readError);
    if (!existing) return failure("not_found", "Task not found");
    const before = existing as unknown as TaskRow;

    const validated = await validateTaskInput(db, args.body ?? {}, access.project, "update");
    if (!validated.ok) return failure("validation", validated.detail);
    const { values } = validated;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const changed: string[] = [];
    if (values.title !== undefined && values.title !== before.title) {
      patch.title = values.title;
      changed.push("title");
    }
    if (values.description !== undefined && values.description !== before.description) {
      patch.description = values.description;
      changed.push("description");
    }
    if (values.due_on !== undefined && values.due_on !== before.due_on) {
      patch.due_on = values.due_on;
      changed.push("due_on");
    }
    if (values.document_id !== undefined && values.document_id !== before.document_id) {
      patch.document_id = values.document_id;
      changed.push("document_id");
    }
    if (values.assignee !== undefined) {
      const nextUser = values.assignee?.user_id ?? null;
      const nextEmail = values.assignee?.email ?? null;
      if (nextUser !== before.assignee_user_id || nextEmail !== before.assignee_email) {
        patch.assignee_user_id = nextUser;
        patch.assignee_email = nextEmail;
        changed.push("assignee");
      }
    }
    if (values.status !== undefined && values.status !== before.status) {
      patch.status = values.status;
      // Done is a moment, so the timestamp is set when the task reaches it
      // and cleared when it is reopened.
      patch.completed_at = values.status === "done" ? patch.updated_at : null;
      changed.push("status");
    }
    if (changed.length === 0)
      return ok({ task: withNames([before], await projectPeople(db, access.project))[0] });

    const { data, error } = await db
      .from("project_tasks")
      .update(patch)
      .eq("id", taskId)
      .eq("project_id", projectId)
      .select(TASK_COLUMNS)
      .single();
    if (error || !data) return internalFailure(error ?? new Error("task update returned no row"));
    const row = data as unknown as TaskRow;

    const completed = changed.includes("status") && row.status === "done";
    await recordAudit(db, {
      userId,
      userEmail,
      orgId: access.project.org_id ?? null,
      action: completed ? "task.completed" : "task.updated",
      title: row.title,
      surface: "project",
      projectId,
      documentId: row.document_id,
      detail: {
        org_id: access.project.org_id ?? null,
        task_id: row.id,
        fields: changed,
        status: row.status,
        ...(changed.includes("status") ? { previous_status: before.status } : {}),
        due_on: row.due_on,
        ...(row.assignee_user_id ? { target_user_id: row.assignee_user_id } : {}),
        ...(row.assignee_email ? { target_email: row.assignee_email } : {}),
      },
    });
    const people = row.assignee_user_id || row.assignee_email
      ? await projectPeople(db, access.project)
      : [];
    if (changed.includes("assignee"))
      await notifyAssignee(db, row, userId, access.project.org_id ?? null);
    return ok({ task: withNames([row], people)[0] });
  } catch (error) {
    return internalFailure(error);
  }
}

export async function deleteProjectTask(
  db: Db,
  args: { projectId: string; taskId: string; userId: string; userEmail?: string },
): Promise<ServiceResult<{ deleted_task_id: string }>> {
  const { projectId, taskId, userId, userEmail } = args;
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");
  if (!can(access.projectRole, "content.edit")) return failure("forbidden", TASK_EDIT_FORBIDDEN);
  try {
    const { data, error } = await db
      .from("project_tasks")
      .delete()
      .eq("id", taskId)
      .eq("project_id", projectId)
      .select("id, title, status, document_id");
    if (error) return internalFailure(error);
    const removed = ((data ?? []) as unknown as Pick<TaskRow, "id" | "title" | "status" | "document_id">[])[0];
    if (!removed) return failure("not_found", "Task not found");
    await recordAudit(db, {
      userId,
      userEmail,
      orgId: access.project.org_id ?? null,
      action: "task.deleted",
      title: removed.title,
      surface: "project",
      projectId,
      documentId: removed.document_id,
      detail: { org_id: access.project.org_id ?? null, task_id: removed.id, status: removed.status },
    });
    return ok({ deleted_task_id: removed.id });
  } catch (error) {
    return internalFailure(error);
  }
}
