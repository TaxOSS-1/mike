// Outbound email from the backend.
//
// Supabase Auth sends its own messages (signup, recovery). Everything the
// product itself wants to say by email, an invitation to an organization, a
// notification digest, a task assigned, goes through here. The transport is
// SMTP, configured with one URL, because every deployment already has an
// SMTP endpoint (the Compose stack has Mailpit; production has whatever GoTrue
// uses). Unset means email is off: callers ask `mailConfigured()` and fall
// back to the in-app surface they already have.
//
//   SMTP_URL    smtp://user:pass@host:587 or smtps://user:pass@host:465;
//               a plain smtp:// without credentials is for local capture
//   MAIL_FROM   the sender, "Mike <no-reply@example.com>" or a bare address
//
// Sending never throws into a request: `sendMail` returns a result and logs
// the failure's category, never the message body or the recipient.

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { logError } from "../log";
import { safeError } from "../safeError";

export const SMTP_URL_ENV = "SMTP_URL";
export const MAIL_FROM_ENV = "MAIL_FROM";

export type MailMessage = {
    to: string;
    subject: string;
    text: string;
};

export type MailResult = { ok: true } | { ok: false; reason: "not_configured" | "send_failed" };

/** Something that delivers one message; nodemailer in production, a stub in tests. */
export type MailTransport = (message: MailMessage & { from: string }) => Promise<void>;

export type MailConfiguration = {
    smtpUrl: string;
    from: string;
};

/**
 * The configuration, or the reasons it is unusable. Both variables are
 * required together: a URL without a sender would send from nowhere, a
 * sender without a URL would silently drop everything.
 */
export function parseMailConfiguration(
    env: NodeJS.ProcessEnv = process.env,
): { config: MailConfiguration | null; errors: string[] } {
    const smtpUrl = env[SMTP_URL_ENV]?.trim() ?? "";
    const from = env[MAIL_FROM_ENV]?.trim() ?? "";
    if (!smtpUrl && !from) return { config: null, errors: [] };
    const errors: string[] = [];
    if (!smtpUrl) errors.push(`${SMTP_URL_ENV} is required when ${MAIL_FROM_ENV} is set`);
    else {
        let url: URL | null = null;
        try {
            url = new URL(smtpUrl);
        } catch {
            url = null;
        }
        if (!url || (url.protocol !== "smtp:" && url.protocol !== "smtps:") || !url.hostname)
            errors.push(`${SMTP_URL_ENV} must be an smtp:// or smtps:// URL with a host`);
    }
    if (!from) errors.push(`${MAIL_FROM_ENV} is required when ${SMTP_URL_ENV} is set`);
    else if (!/^[^<>@\s]+@[^<>@\s]+$|^[^<>]+<[^<>@\s]+@[^<>@\s]+>$/.test(from))
        errors.push(`${MAIL_FROM_ENV} must be an address, optionally with a display name`);
    return errors.length ? { config: null, errors } : { config: { smtpUrl, from }, errors: [] };
}

/** Fail the boot on a half-configured or malformed mail setting. */
export function validateMailConfiguration(env: NodeJS.ProcessEnv = process.env): void {
    const { errors } = parseMailConfiguration(env);
    if (errors.length > 0) {
        throw Object.assign(
            new Error(
                `Backend email configuration is invalid:\n- ${errors.join("\n- ")}\n\n` +
                    `Set both ${SMTP_URL_ENV} and ${MAIL_FROM_ENV}, or neither to keep email off; see docs/deployment.md.`,
            ),
            { code: "ERR_INVALID_MAIL_CONFIG" },
        );
    }
}

export function mailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return parseMailConfiguration(env).config !== null;
}

let transportOverride: MailTransport | null = null;
let cached: { smtpUrl: string; transporter: Transporter } | null = null;

/** Tests inject a transport; `null` restores nodemailer. */
export function setMailTransport(transport: MailTransport | null): void {
    transportOverride = transport;
}

function transporterFor(smtpUrl: string): Transporter {
    if (cached && cached.smtpUrl === smtpUrl) return cached.transporter;
    const transporter = nodemailer.createTransport(smtpUrl);
    cached = { smtpUrl, transporter };
    return transporter;
}

/**
 * Send one plain-text message. Not configured is a quiet `ok: false`, so a
 * caller can treat "email is off" as the normal case; a failed send is logged
 * by category and reported the same way, never thrown.
 */
export async function sendMail(
    message: MailMessage,
    env: NodeJS.ProcessEnv = process.env,
): Promise<MailResult> {
    const { config } = parseMailConfiguration(env);
    if (!config) return { ok: false, reason: "not_configured" };
    try {
        if (transportOverride) {
            await transportOverride({ ...message, from: config.from });
        } else {
            await transporterFor(config.smtpUrl).sendMail({
                from: config.from,
                to: message.to,
                subject: message.subject,
                text: message.text,
            });
        }
        return { ok: true };
    } catch (error) {
        logError("mail", safeError(error), { subject: message.subject.slice(0, 80) });
        return { ok: false, reason: "send_failed" };
    }
}

/** The web app's origin for links in messages. */
export function mailLinkBase(env: NodeJS.ProcessEnv = process.env): string {
    return (env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** A link into the web app; `path` starts with a slash. */
export function mailLink(path: string, env: NodeJS.ProcessEnv = process.env): string {
    return `${mailLinkBase(env)}${path.startsWith("/") ? path : `/${path}`}`;
}
