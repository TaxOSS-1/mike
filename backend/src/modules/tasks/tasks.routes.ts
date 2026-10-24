// HTTP layer for project tasks, mounted at /projects/:projectId/tasks. The
// handlers parse the request, call the service and map its typed results
// onto status codes; they never query the database.

import { Router } from "express";
import { sendServiceFailure } from "../../lib/serviceResult";
import { createServerSupabase } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute } from "../../middleware/asyncRoute";
import {
  createProjectTask,
  deleteProjectTask,
  listProjectTasks,
  updateProjectTask,
} from "./tasks.service";

export const projectTasksRouter = Router({ mergeParams: true });

projectTasksRouter.use(requireAuth);

type Params = { projectId: string; taskId?: string };

function body(req: { body?: unknown }): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

// GET /projects/:projectId/tasks?status=open|done|all (open is the default)
projectTasksRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const { projectId } = req.params as Params;
    const result = await listProjectTasks(createServerSupabase(), {
      projectId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      status: req.query.status,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

// POST /projects/:projectId/tasks
projectTasksRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const { projectId } = req.params as Params;
    const result = await createProjectTask(createServerSupabase(), {
      projectId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      body: body(req),
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(201).json(result.data.task);
  }),
);

// PATCH /projects/:projectId/tasks/:taskId
projectTasksRouter.patch(
  "/:taskId",
  asyncRoute(async (req, res) => {
    const { projectId, taskId } = req.params as Required<Params>;
    const result = await updateProjectTask(createServerSupabase(), {
      projectId,
      taskId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      body: body(req),
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data.task);
  }),
);

// DELETE /projects/:projectId/tasks/:taskId
projectTasksRouter.delete(
  "/:taskId",
  asyncRoute(async (req, res) => {
    const { projectId, taskId } = req.params as Required<Params>;
    const result = await deleteProjectTask(createServerSupabase(), {
      projectId,
      taskId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);
