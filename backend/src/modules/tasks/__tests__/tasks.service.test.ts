import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  checkProjectAccess: vi.fn(),
  listProjectPeople: vi.fn(),
  recordAudit: vi.fn(async (..._args: unknown[]) => {}),
  notify: vi.fn(async (..._args: unknown[]) => null),
}));
vi.mock("../../notifications/notifications.service", () => ({
  notify: (...args: unknown[]) => mocks.notify(...args),
}));
vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  checkProjectAccess: (...args: unknown[]) => mocks.checkProjectAccess(...args),
}));
vi.mock("../../../lib/projectAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/projectAccess")>()),
  listProjectPeople: (...args: unknown[]) => mocks.listProjectPeople(...args),
}));
vi.mock("../../../lib/audit", () => ({
  recordAudit: (...args: unknown[]) => mocks.recordAudit(...args),
}));

import {
  createProjectTask,
  deleteProjectTask,
  listProjectTasks,
  parseDueOn,
  updateProjectTask,
} from "../tasks.service";

const project = { id: "p1", user_id: "owner", org_id: "org-1", visibility: "private" };
const access = (projectRole: "owner" | "editor" | "viewer") => ({
  ok: true,
  isCreator: projectRole === "owner",
  orgRole: "member",
  projectRole,
  project,
});
const people = {
  ok: true,
  scope: "organization",
  owner: { user_id: "owner", email: "owner@example.com", display_name: "Olivia Owner", role: "owner" },
  members: [
    { user_id: "u2", email: "jamie@example.com", display_name: "Jamie Morgan", role: "editor" },
    { user_id: "u3", email: "denied@example.com", display_name: "Denied", role: "deny" },
  ],
};
const row = {
  id: "t1",
  project_id: "p1",
  document_id: null,
  title: "File the FY2025 CIT return",
  description: null,
  status: "open",
  assignee_user_id: "u2",
  assignee_email: "jamie@example.com",
  due_on: "2026-11-30",
  created_by: "u1",
  completed_at: null,
  created_at: "2026-10-23T10:00:00Z",
  updated_at: "2026-10-23T10:00:00Z",
};
const actor = { projectId: "p1", userId: "u1", userEmail: "u1@test.local" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listProjectPeople.mockResolvedValue(people);
});

describe("parseDueOn", () => {
  it("accepts a calendar date and refuses anything else", () => {
    expect(parseDueOn("2026-11-30")).toEqual({ ok: true, due_on: "2026-11-30" });
    expect(parseDueOn(null)).toEqual({ ok: true, due_on: null });
    expect(parseDueOn("")).toEqual({ ok: true, due_on: null });
    expect(parseDueOn("2026-02-30")).toMatchObject({ ok: false });
    expect(parseDueOn("30/11/2026")).toMatchObject({ ok: false });
    expect(parseDueOn("2026-11-30T10:00:00Z")).toMatchObject({ ok: false });
    expect(parseDueOn(20261130)).toMatchObject({ ok: false });
  });
});

describe("listProjectTasks", () => {
  it("lists open tasks by default, ordered by due date, with the assignee's name", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("viewer"));
    const fake = scriptedDb([{ table: "project_tasks", data: [row] }]);

    const result = await listProjectTasks(fake.db, actor);

    expect(result).toEqual({
      ok: true,
      data: { tasks: [{ ...row, assignee_display_name: "Jamie Morgan" }] },
    });
    expect(fake.calls[0].filters).toContainEqual(["eq", "project_id", "p1"]);
    expect(fake.calls[0].filters).toContainEqual(["in", "status", ["open", "in_progress"]]);
    expect(fake.calls[0].filters).toContainEqual([
      "order",
      "due_on",
      { ascending: true, nullsFirst: false },
    ]);
    fake.done();
  });

  it("refuses an unknown status filter and hides a project the caller cannot open", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("viewer"));
    expect(await listProjectTasks(scriptedDb([]).db, { ...actor, status: "late" })).toMatchObject({
      ok: false,
      kind: "validation",
    });
    mocks.checkProjectAccess.mockResolvedValue({ ok: false });
    expect(await listProjectTasks(scriptedDb([]).db, actor)).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });
});

describe("createProjectTask", () => {
  it("assigns only people with access and audits the new task", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("editor"));
    const fake = scriptedDb([{ table: "project_tasks", op: "insert", data: row }]);

    const result = await createProjectTask(fake.db, {
      ...actor,
      body: {
        title: "  File the FY2025 CIT return ",
        assignee_email: "Jamie@Example.com",
        due_on: "2026-11-30",
      },
    });

    expect(result).toMatchObject({ ok: true, data: { task: { id: "t1", assignee_display_name: "Jamie Morgan" } } });
    expect(fake.calls[0].payload).toMatchObject({
      project_id: "p1",
      title: "File the FY2025 CIT return",
      status: "open",
      assignee_user_id: "u2",
      assignee_email: "jamie@example.com",
      due_on: "2026-11-30",
      created_by: "u1",
      completed_at: null,
    });
    expect(mocks.notify).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({
        userId: "u2",
        kind: "task.assigned",
        title: "Task assigned to you: File the FY2025 CIT return",
        body: "Due 2026-11-30.",
        href: "/projects/p1/tasks",
        subjectId: "t1",
      }),
    );
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({
        action: "task.created",
        title: "File the FY2025 CIT return",
        surface: "project",
        projectId: "p1",
        orgId: "org-1",
        detail: {
          org_id: "org-1",
          task_id: "t1",
          status: "open",
          due_on: "2026-11-30",
          target_user_id: "u2",
          target_email: "jamie@example.com",
        },
      }),
    );
    fake.done();
  });

  it("refuses an assignee without access, a denied member, and a viewer caller", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("editor"));
    expect(
      await createProjectTask(scriptedDb([]).db, {
        ...actor,
        body: { title: "Task", assignee_email: "stranger@example.com" },
      }),
    ).toEqual({
      ok: false,
      kind: "validation",
      detail: "Only people with access to this project can be assigned a task.",
    });
    expect(
      await createProjectTask(scriptedDb([]).db, {
        ...actor,
        body: { title: "Task", assignee_email: "denied@example.com" },
      }),
    ).toMatchObject({ ok: false, kind: "validation" });

    mocks.checkProjectAccess.mockResolvedValue(access("viewer"));
    expect(
      await createProjectTask(scriptedDb([]).db, { ...actor, body: { title: "Task" } }),
    ).toMatchObject({ ok: false, kind: "forbidden" });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("requires a title and a document from this project", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("editor"));
    expect(await createProjectTask(scriptedDb([]).db, { ...actor, body: { title: "  " } })).toEqual({
      ok: false,
      kind: "validation",
      detail: "title is required",
    });
    const fake = scriptedDb([{ table: "documents", data: null }]);
    expect(
      await createProjectTask(fake.db, { ...actor, body: { title: "Task", document_id: "doc-9" } }),
    ).toEqual({
      ok: false,
      kind: "validation",
      detail: "document_id must name a document in this project",
    });
    expect(fake.calls[0].filters).toContainEqual(["eq", "project_id", "p1"]);
    fake.done();
  });
});

describe("updateProjectTask", () => {
  it("stamps completion when a task is done and audits it as completed", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("editor"));
    const done = { ...row, status: "done", completed_at: "2026-10-24T09:00:00Z" };
    const fake = scriptedDb([
      { table: "project_tasks", data: row },
      { table: "project_tasks", op: "update", data: done },
    ]);

    const result = await updateProjectTask(fake.db, { ...actor, taskId: "t1", body: { status: "done" } });

    expect(result).toMatchObject({ ok: true, data: { task: { status: "done" } } });
    const payload = fake.calls[1].payload as Record<string, unknown>;
    expect(payload.status).toBe("done");
    expect(typeof payload.completed_at).toBe("string");
    expect(fake.calls[1].filters).toContainEqual(["eq", "project_id", "p1"]);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({
        action: "task.completed",
        detail: expect.objectContaining({ fields: ["status"], previous_status: "open", status: "done" }),
      }),
    );
    fake.done();
  });

  it("clears completion when a done task is reopened and names the changed fields", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("owner"));
    const done = { ...row, status: "done", completed_at: "2026-10-24T09:00:00Z" };
    const reopened = { ...row, status: "open", completed_at: null, title: "Renamed" };
    const fake = scriptedDb([
      { table: "project_tasks", data: done },
      { table: "project_tasks", op: "update", data: reopened },
    ]);

    await updateProjectTask(fake.db, {
      ...actor,
      taskId: "t1",
      body: { status: "open", title: "Renamed", assignee_email: null },
    });

    const payload = fake.calls[1].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "open",
      completed_at: null,
      title: "Renamed",
      assignee_user_id: null,
      assignee_email: null,
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({
        action: "task.updated",
        detail: expect.objectContaining({ fields: ["title", "assignee", "status"] }),
      }),
    );
    fake.done();
  });

  it("writes nothing when nothing changed, and 404s a task from another project", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("editor"));
    const unchanged = scriptedDb([{ table: "project_tasks", data: row }]);
    expect(
      await updateProjectTask(unchanged.db, { ...actor, taskId: "t1", body: { title: row.title } }),
    ).toMatchObject({ ok: true });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    unchanged.done();

    const missing = scriptedDb([{ table: "project_tasks", data: null }]);
    expect(await updateProjectTask(missing.db, { ...actor, taskId: "t9", body: { title: "x" } })).toEqual({
      ok: false,
      kind: "not_found",
      detail: "Task not found",
    });
    expect(missing.calls[0].filters).toContainEqual(["eq", "project_id", "p1"]);
  });
});

describe("deleteProjectTask", () => {
  it("deletes within the project and audits, or reports not found", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("editor"));
    const fake = scriptedDb([
      { table: "project_tasks", op: "delete", data: [{ id: "t1", title: row.title, status: "open", document_id: null }] },
    ]);
    expect(await deleteProjectTask(fake.db, { ...actor, taskId: "t1" })).toEqual({
      ok: true,
      data: { deleted_task_id: "t1" },
    });
    expect(fake.calls[0].filters).toContainEqual(["eq", "project_id", "p1"]);
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({ action: "task.deleted", title: row.title }),
    );
    fake.done();

    const none = scriptedDb([{ table: "project_tasks", op: "delete", data: [] }]);
    expect(await deleteProjectTask(none.db, { ...actor, taskId: "t9" })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });

  it("refuses a viewer before touching the table", async () => {
    mocks.checkProjectAccess.mockResolvedValue(access("viewer"));
    const fake = scriptedDb([]);
    expect(await deleteProjectTask(fake.db, { ...actor, taskId: "t1" })).toMatchObject({
      ok: false,
      kind: "forbidden",
    });
    fake.done();
  });
});
