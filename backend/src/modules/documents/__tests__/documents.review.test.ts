import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRole } from "../../../lib/permissions";

// Only the verdict is stubbed; the capability ladder under test is the
// production one.
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  recordAudit: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("../documents.access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents.access")>()),
  ensureDocumentAccess: mocks.access,
}));
vi.mock("../../../lib/audit", () => ({
  recordAudit: (...args: unknown[]) => mocks.recordAudit(...args),
}));

import {
  APPROVAL_FORBIDDEN,
  REVIEW_EDIT_FORBIDDEN,
  canSetReviewState,
  setVersionReviewState,
} from "../documents.review";

const access = (role: ProjectRole, project: string | null = "p1") => ({
  ok: true,
  isCreator: false,
  projectRole: role,
  doc: { id: "doc", user_id: "other", project_id: project, org_id: "o1", workflow_id: null },
});

/** A version row the fake database holds, mutated by update(). */
let version: Record<string, unknown> | null;
let updates: Record<string, unknown>[];

function fakeDb() {
  const chain = (terminal: () => unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is"]) q[m] = () => q;
    q.update = (payload: Record<string, unknown>) => {
      updates.push(payload);
      if (version) Object.assign(version, payload);
      return q;
    };
    q.maybeSingle = async () => ({ data: terminal(), error: null });
    q.single = async () => ({ data: terminal(), error: null });
    return q;
  };
  return { from: () => chain(() => version) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  version = {
    id: "v2",
    version_number: 2,
    filename: "return.pdf",
    review_state: "draft",
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
  };
});

describe("canSetReviewState", () => {
  it("lets editors move a version into review or back to draft, and only owners approve", () => {
    expect(canSetReviewState("editor", "in_review")).toBe(true);
    expect(canSetReviewState("editor", "draft")).toBe(true);
    expect(canSetReviewState("editor", "approved")).toBe(false);
    expect(canSetReviewState("owner", "approved")).toBe(true);
    expect(canSetReviewState("viewer", "in_review")).toBe(false);
    expect(canSetReviewState(null, "draft")).toBe(false);
  });
});

describe("setVersionReviewState", () => {
  const base = { documentId: "doc", versionId: "v2", userId: "u1", userEmail: "u1@test.local" };

  it("records who set the state and when, and audits the transition", async () => {
    mocks.access.mockResolvedValue(access("owner"));
    const result = await setVersionReviewState(
      { ...base, state: "approved", note: "  Filed as approved.  " },
      fakeDb(),
    );

    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      review_state: "approved",
      reviewed_by: "u1",
      review_note: "Filed as approved.",
    });
    expect(typeof updates[0].reviewed_at).toBe("string");
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "u1",
        action: "document.review_state_changed",
        title: "return.pdf",
        surface: "project",
        projectId: "p1",
        documentId: "doc",
        detail: {
          version_id: "v2",
          version_number: 2,
          previous_state: "draft",
          review_state: "approved",
          note_length: 18,
        },
      }),
    );
  });

  it("refuses an editor's approval by name and writes nothing", async () => {
    mocks.access.mockResolvedValue(access("editor"));
    const result = await setVersionReviewState({ ...base, state: "approved" }, fakeDb());
    expect(result).toEqual({ ok: false, status: 403, detail: APPROVAL_FORBIDDEN });
    expect(updates).toEqual([]);
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("lets an editor send a version into review", async () => {
    mocks.access.mockResolvedValue(access("editor"));
    const result = await setVersionReviewState({ ...base, state: "in_review" }, fakeDb());
    expect(result.ok).toBe(true);
    expect(updates[0]).toMatchObject({ review_state: "in_review", review_note: null });
  });

  it("refuses a viewer, keeps 404 for no verdict, and rejects unknown states", async () => {
    mocks.access.mockResolvedValue(access("viewer"));
    expect(await setVersionReviewState({ ...base, state: "draft" }, fakeDb())).toEqual({
      ok: false,
      status: 403,
      detail: REVIEW_EDIT_FORBIDDEN,
    });

    mocks.access.mockResolvedValue({ ok: false, kind: "forbidden" });
    expect(await setVersionReviewState({ ...base, state: "draft" }, fakeDb())).toEqual({
      ok: false,
      status: 404,
      detail: "Document not found",
    });

    mocks.access.mockResolvedValue(access("owner"));
    expect(await setVersionReviewState({ ...base, state: "signed" }, fakeDb())).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await setVersionReviewState({ ...base, state: "draft", note: "x".repeat(2001) }, fakeDb()),
    ).toMatchObject({ ok: false, status: 400 });
    expect(updates).toEqual([]);
  });

  it("answers 404 for a deleted or unknown version before writing", async () => {
    mocks.access.mockResolvedValue(access("owner"));
    version = null;
    const result = await setVersionReviewState({ ...base, state: "in_review" }, fakeDb());
    expect(result).toEqual({ ok: false, status: 404, detail: "Version not found" });
    expect(updates).toEqual([]);
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
