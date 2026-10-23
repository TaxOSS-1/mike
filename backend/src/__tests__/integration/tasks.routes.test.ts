import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The router's part is to parse the request and map the service's typed
// results onto status codes; the service itself is exercised by its own unit
// tests. Only the service functions are stubbed here.
const mocks = vi.hoisted(() => ({
  listProjectTasks: vi.fn(),
  createProjectTask: vi.fn(),
  updateProjectTask: vi.fn(),
  deleteProjectTask: vi.fn(),
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

vi.mock("../../modules/tasks/tasks.service", () => ({
  listProjectTasks: (...args: unknown[]) => mocks.listProjectTasks(...args),
  createProjectTask: (...args: unknown[]) => mocks.createProjectTask(...args),
  updateProjectTask: (...args: unknown[]) => mocks.updateProjectTask(...args),
  deleteProjectTask: (...args: unknown[]) => mocks.deleteProjectTask(...args),
}));

import { projectTasksRouter } from "../../modules/tasks/tasks.routes";

const app = express();
app.use(express.json());
app.use("/projects/:projectId/tasks", projectTasksRouter);

const task = {
  id: "t1",
  project_id: "p1",
  title: "File the FY2025 CIT return",
  status: "open",
  due_on: "2026-11-30",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project tasks routes", () => {
  it("lists tasks with the status filter and the caller's identity", async () => {
    mocks.listProjectTasks.mockResolvedValue({ ok: true, data: { tasks: [task] } });
    const res = await request(app).get("/projects/p1/tasks?status=all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: [task] });
    expect(mocks.listProjectTasks).toHaveBeenCalledWith(
      { marker: "db" },
      { projectId: "p1", userId: "u1", userEmail: "u1@test.local", status: "all" },
    );
  });

  it("creates a task with 201 and passes the body through untouched", async () => {
    mocks.createProjectTask.mockResolvedValue({ ok: true, data: { task } });
    const res = await request(app)
      .post("/projects/p1/tasks")
      .send({ title: "File the FY2025 CIT return", assignee_email: "jamie@example.com" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(task);
    expect(mocks.createProjectTask).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        projectId: "p1",
        body: { title: "File the FY2025 CIT return", assignee_email: "jamie@example.com" },
      }),
    );
  });

  it("updates and deletes by task id within the project", async () => {
    mocks.updateProjectTask.mockResolvedValue({ ok: true, data: { task: { ...task, status: "done" } } });
    const patched = await request(app).patch("/projects/p1/tasks/t1").send({ status: "done" });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("done");
    expect(mocks.updateProjectTask).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({ projectId: "p1", taskId: "t1", body: { status: "done" } }),
    );

    mocks.deleteProjectTask.mockResolvedValue({ ok: true, data: { deleted_task_id: "t1" } });
    const deleted = await request(app).delete("/projects/p1/tasks/t1");
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted_task_id: "t1" });
  });

  it("maps the service's failure kinds onto status codes without leaking details", async () => {
    mocks.listProjectTasks.mockResolvedValue({ ok: false, kind: "not_found", detail: "Project not found" });
    expect((await request(app).get("/projects/p1/tasks")).status).toBe(404);

    mocks.createProjectTask.mockResolvedValue({
      ok: false,
      kind: "forbidden",
      detail: "Only project editors and owners can change tasks.",
    });
    const forbidden = await request(app).post("/projects/p1/tasks").send({ title: "x" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ detail: "Only project editors and owners can change tasks." });

    mocks.updateProjectTask.mockResolvedValue({ ok: false, kind: "validation", detail: "title is required" });
    expect((await request(app).patch("/projects/p1/tasks/t1").send({ title: "" })).status).toBe(400);

    mocks.deleteProjectTask.mockResolvedValue({ ok: false, kind: "error", error: new Error("pg down") });
    const failed = await request(app).delete("/projects/p1/tasks/t1");
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("pg down");
  });

  it("treats a non-object body as empty", async () => {
    mocks.createProjectTask.mockResolvedValue({ ok: false, kind: "validation", detail: "title is required" });
    const res = await request(app)
      .post("/projects/p1/tasks")
      .set("Content-Type", "application/json")
      .send("[1,2]");
    expect(res.status).toBe(400);
    expect(mocks.createProjectTask).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({ body: {} }),
    );
  });
});
