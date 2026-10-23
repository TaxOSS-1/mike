// Review state of a document version: Draft, In review, Approved.
//
// Approval attaches to bytes, so the state lives on the version and a new
// version starts as a draft again. Moving a version into review or back to
// draft is content work (content.edit); marking it approved is a sign-off and
// sits with the project's Owners (access.manage), the tier that already
// decides who may work on the matter. There is no separate approver role.

import { recordAudit } from "../../lib/audit";
import { can, type ProjectRole } from "../../lib/permissions";
import { ensureDocumentAccess } from "./documents.access";
import type { Db } from "./documents.shared";

export const REVIEW_STATES = ["draft", "in_review", "approved"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const MAX_REVIEW_NOTE_CHARS = 2000;

/** The columns every version listing returns, in one place. */
export const VERSION_REVIEW_COLUMNS =
    "review_state, reviewed_by, reviewed_at, review_note";

export const APPROVAL_FORBIDDEN =
    "Only a project owner can approve a version.";
export const REVIEW_EDIT_FORBIDDEN =
    "You do not have permission to change this version's review state.";

export function isReviewState(value: unknown): value is ReviewState {
    return (
        typeof value === "string" &&
        (REVIEW_STATES as readonly string[]).includes(value)
    );
}

/** The capability a transition into `state` needs. */
export function reviewCapability(state: ReviewState) {
    return state === "approved" ? "access.manage" : "content.edit";
}

export function canSetReviewState(
    role: ProjectRole | null | undefined,
    state: ReviewState,
): boolean {
    return can(role, reviewCapability(state));
}

export type SetVersionReviewStateResult =
    | { ok: true; version: Record<string, unknown> }
    | { ok: false; status: 400 | 403 | 404; detail: string };

export async function setVersionReviewState(
    params: {
        documentId: string;
        versionId: string;
        state: unknown;
        note?: unknown;
        userId: string;
        userEmail: string | undefined;
    },
    db: Db,
): Promise<SetVersionReviewStateResult> {
    const { documentId, versionId, userId, userEmail } = params;
    if (!isReviewState(params.state))
        return {
            ok: false,
            status: 400,
            detail: "state must be draft, in_review or approved",
        };
    const state = params.state;
    let note: string | null = null;
    if (params.note !== undefined && params.note !== null) {
        if (typeof params.note !== "string")
            return { ok: false, status: 400, detail: "note must be a string" };
        note = params.note.trim() || null;
        if (note && note.length > MAX_REVIEW_NOTE_CHARS)
            return {
                ok: false,
                status: 400,
                detail: `note must be at most ${MAX_REVIEW_NOTE_CHARS} characters`,
            };
    }

    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    // A document a Viewer can open has not disappeared: the read-only tier is
    // refused by name below, and only a caller with no verdict gets 404.
    if (!access.ok) return { ok: false, status: 404, detail: "Document not found" };
    if (!canSetReviewState(access.projectRole, state))
        return {
            ok: false,
            status: 403,
            detail: state === "approved" ? APPROVAL_FORBIDDEN : REVIEW_EDIT_FORBIDDEN,
        };

    const { data: current, error: readError } = await db
        .from("document_versions")
        .select("id, version_number, filename, review_state")
        .eq("id", versionId)
        .eq("document_id", documentId)
        .is("deleted_at", null)
        .maybeSingle();
    if (readError || !current)
        return { ok: false, status: 404, detail: "Version not found" };
    const previous = (current as { review_state?: string | null }).review_state ?? "draft";

    const { data: updated, error } = await db
        .from("document_versions")
        .update({
            review_state: state,
            reviewed_by: userId,
            reviewed_at: new Date().toISOString(),
            review_note: note,
        })
        .eq("id", versionId)
        .eq("document_id", documentId)
        .is("deleted_at", null)
        .select(
            `id, version_number, source, created_at, filename, file_type, size_bytes, page_count, textless_page_count, ${VERSION_REVIEW_COLUMNS}`,
        )
        .single();
    if (error || !updated) return { ok: false, status: 404, detail: "Version not found" };

    const row = updated as Record<string, unknown>;
    await recordAudit(db, {
        userId,
        userEmail,
        action: "document.review_state_changed",
        title: typeof row.filename === "string" ? row.filename : null,
        surface: access.doc.project_id ? "project" : "assistant",
        projectId: access.doc.project_id ?? null,
        documentId,
        detail: {
            version_id: versionId,
            version_number: row.version_number ?? null,
            previous_state: previous,
            review_state: state,
            ...(note ? { note_length: note.length } : {}),
        },
    });
    return { ok: true, version: row };
}
