import { beforeEach, describe, expect, it, vi } from "vitest";

// Sharing a project is the one access decision an organization's audit log
// could not show. These tests pin the event each handler writes: the action,
// the recipient it names, the role, and that a refused or failed call writes
// nothing.

const {
  checkProjectAccess,
  recordAudit,
  upsertProjectGrant,
  deleteProjectGrant,
  findAssignableOrgMember,
  findOrgMemberByEmail,
  setOrgAccessOverride,
  deleteOrgAccessOverride,
} = vi.hoisted(() => ({
  checkProjectAccess: vi.fn(),
  recordAudit: vi.fn(async (..._args: unknown[]) => {}),
  upsertProjectGrant: vi.fn(),
  deleteProjectGrant: vi.fn(),
  findAssignableOrgMember: vi.fn(),
  findOrgMemberByEmail: vi.fn(),
  setOrgAccessOverride: vi.fn(),
  deleteOrgAccessOverride: vi.fn(),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
}));
vi.mock("../../../lib/audit", () => ({
  recordAudit: (...args: unknown[]) => recordAudit(...args),
}));
vi.mock("../../../lib/projectAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/projectAccess")>()),
  upsertProjectGrant: (...args: unknown[]) => upsertProjectGrant(...args),
  deleteProjectGrant: (...args: unknown[]) => deleteProjectGrant(...args),
}));
vi.mock("../../../lib/orgAccessOverrides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/orgAccessOverrides")>()),
  findAssignableOrgMember: (...args: unknown[]) => findAssignableOrgMember(...args),
  findOrgMemberByEmail: (...args: unknown[]) => findOrgMemberByEmail(...args),
  setOrgAccessOverride: (...args: unknown[]) => setOrgAccessOverride(...args),
  deleteOrgAccessOverride: (...args: unknown[]) => deleteOrgAccessOverride(...args),
}));

import { grantProjectAccess, revokeProjectAccess } from "../projects.access";

const personalProject = {
  ok: true,
  isCreator: true,
  orgRole: null,
  projectRole: "owner",
  project: { id: "p1", user_id: "u1", org_id: null, visibility: "private" },
};
const orgProject = {
  ...personalProject,
  orgRole: "admin",
  project: { id: "p2", user_id: "u9", org_id: "org-1", visibility: "private" },
};

// The service never reads the database itself; every query sits behind the
// mocked helpers, so a bare object stands in for the client.
const db = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
  }),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("grantProjectAccess audit", () => {
  it("records a direct grant with the recipient's email and role", async () => {
    checkProjectAccess.mockResolvedValue(personalProject);
    upsertProjectGrant.mockResolvedValue({
      ok: true,
      grant: { email: "jamie@example.com", role: "editor", created_by: "u1" },
    });

    const result = await grantProjectAccess(db, {
      projectId: "p1",
      userId: "u1",
      userEmail: "owner@example.com",
      body: { email: "Jamie@Example.com", role: "editor" },
    });

    expect(result.ok).toBe(true);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(db, {
      userId: "u1",
      userEmail: "owner@example.com",
      orgId: null,
      action: "project.access.granted",
      title: "jamie@example.com",
      surface: "project",
      projectId: "p1",
      detail: { org_id: null, target_email: "jamie@example.com", role: "editor" },
    });
  });

  it("records an organization override with the member's id, email and role", async () => {
    checkProjectAccess.mockResolvedValue(orgProject);
    findAssignableOrgMember.mockResolvedValue({
      ok: true,
      member: { userId: "u2", email: "jamie@example.com", orgRole: "member" },
    });
    setOrgAccessOverride.mockResolvedValue({ ok: true });

    const result = await grantProjectAccess(db, {
      projectId: "p2",
      userId: "u1",
      userEmail: "admin@example.com",
      body: { email: "jamie@example.com", role: "deny" },
    });

    expect(result.ok).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(db, {
      userId: "u1",
      userEmail: "admin@example.com",
      orgId: "org-1",
      action: "project.access.granted",
      title: "jamie@example.com",
      surface: "project",
      projectId: "p2",
      detail: {
        org_id: "org-1",
        target_user_id: "u2",
        target_email: "jamie@example.com",
        role: "deny",
      },
    });
  });

  it("writes nothing when the grant is refused or fails", async () => {
    checkProjectAccess.mockResolvedValue({ ...personalProject, projectRole: "editor" });
    const refused = await grantProjectAccess(db, {
      projectId: "p1",
      userId: "u1",
      body: { email: "jamie@example.com", role: "viewer" },
    });
    expect(refused.ok).toBe(false);

    checkProjectAccess.mockResolvedValue(personalProject);
    upsertProjectGrant.mockResolvedValue({ ok: false, kind: "db_error", detail: "boom" });
    const failed = await grantProjectAccess(db, {
      projectId: "p1",
      userId: "u1",
      body: { email: "jamie@example.com", role: "viewer" },
    });
    expect(failed.ok).toBe(false);

    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("revokeProjectAccess audit", () => {
  it("records a revoked direct grant by normalized email", async () => {
    checkProjectAccess.mockResolvedValue(personalProject);
    deleteProjectGrant.mockResolvedValue({ ok: true, removed: true });

    const result = await revokeProjectAccess(db, {
      projectId: "p1",
      userId: "u1",
      userEmail: "owner@example.com",
      targetEmail: " Jamie@Example.com ",
    });

    expect(result).toEqual({ ok: true });
    expect(recordAudit).toHaveBeenCalledWith(db, {
      userId: "u1",
      userEmail: "owner@example.com",
      orgId: null,
      action: "project.access.revoked",
      title: "jamie@example.com",
      surface: "project",
      projectId: "p1",
      detail: { org_id: null, target_email: "jamie@example.com" },
    });
  });

  it("records a removed organization override with the member's id", async () => {
    checkProjectAccess.mockResolvedValue(orgProject);
    findOrgMemberByEmail.mockResolvedValue({
      ok: true,
      member: { userId: "u2", email: "jamie@example.com", orgRole: "member" },
    });
    deleteOrgAccessOverride.mockResolvedValue({ ok: true, removed: true });

    const result = await revokeProjectAccess(db, {
      projectId: "p2",
      userId: "u1",
      targetEmail: "jamie@example.com",
    });

    expect(result).toEqual({ ok: true });
    expect(recordAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "project.access.revoked",
        orgId: "org-1",
        projectId: "p2",
        detail: { org_id: "org-1", target_user_id: "u2", target_email: "jamie@example.com" },
      }),
    );
  });

  it("writes nothing when there was no grant to remove", async () => {
    checkProjectAccess.mockResolvedValue(personalProject);
    deleteProjectGrant.mockResolvedValue({ ok: true, removed: false });

    const result = await revokeProjectAccess(db, {
      projectId: "p1",
      userId: "u1",
      targetEmail: "nobody@example.com",
    });

    expect(result).toMatchObject({ ok: false, kind: "not_found" });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
