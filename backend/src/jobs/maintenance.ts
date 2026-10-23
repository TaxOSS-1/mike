import { createServerSupabase, type Db } from "../lib/supabase";
import { safeError } from "../lib/safeError";
import { logError } from "../lib/log";
import { backfillDocumentText, sweepStaleProcessingDocuments } from "../modules/documents/documents.service";
import { sweepStaleGeneratingCells } from "../modules/tabular/tabular.service";
import { expireDepartureArchives, purgeExpiredOrganizations } from "../modules/orgs/orgs.service";
import { purgeExpiredSubagentRuns } from "../modules/chat/chat.service";
import { runNotificationDigestSweep } from "../modules/notifications/notifications.service";
import { runTaskReminderSweep } from "../modules/tasks/tasks.service";

/** Run recovery/expiry sweeps; errors are contained per sweep. */
export async function runStaleWorkSweep(
    db: Db = createServerSupabase(),
): Promise<{ documents: number; cells: number }> {
    await backfillDocumentText(db).catch((err) => {
        logError("stale-sweep", safeError(err), { sweep: "document-text" });
    });
    const documents = await sweepStaleProcessingDocuments(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "documents" });
        return 0;
    });
    const cells = await sweepStaleGeneratingCells(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "cells" });
        return 0;
    });
    await expireDepartureArchives(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "organization-archives" });
    });
    await purgeExpiredOrganizations(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "organizations" });
    });
    await purgeExpiredSubagentRuns(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "subagent-runs" });
    });
    return { documents, cells };
}

/**
 * Once an hour: remind task owners of what is due, then send the daily
 * digests to the people who chose them. Each sweep is idempotent (reminders
 * are rate-limited per task, digests mark what they emailed), so a second
 * replica running the same hour sends nothing twice. Errors are contained
 * per sweep.
 */
export async function runHourlySweeps(
    db: Db = createServerSupabase(),
    now: Date = new Date(),
): Promise<{ reminders: number; digests: number }> {
    const reminders = await runTaskReminderSweep(db, { now }).catch((err) => {
        logError("hourly-sweep", safeError(err), { sweep: "task-reminders" });
        return 0;
    });
    const digests = await runNotificationDigestSweep(db, { now })
        .then((result) => result.users)
        .catch((err) => {
            logError("hourly-sweep", safeError(err), { sweep: "notification-digests" });
            return 0;
        });
    return { reminders, digests };
}
