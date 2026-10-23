import { afterEach, describe, expect, it, vi } from "vitest";
import {
    mailConfigured,
    mailLink,
    parseMailConfiguration,
    sendMail,
    setMailTransport,
    validateMailConfiguration,
} from "../mail";

const configured = {
    SMTP_URL: "smtp://mailpit:1025",
    MAIL_FROM: "Mike <no-reply@mike.local>",
    FRONTEND_URL: "https://app.example.test/",
} as NodeJS.ProcessEnv;

afterEach(() => {
    setMailTransport(null);
    vi.restoreAllMocks();
});

describe("parseMailConfiguration", () => {
    it("is off when neither variable is set", () => {
        expect(parseMailConfiguration({} as NodeJS.ProcessEnv)).toEqual({ config: null, errors: [] });
        expect(mailConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    });

    it("accepts smtp and smtps URLs with a bare or named sender", () => {
        expect(parseMailConfiguration(configured).config).toEqual({
            smtpUrl: "smtp://mailpit:1025",
            from: "Mike <no-reply@mike.local>",
        });
        expect(
            parseMailConfiguration({
                SMTP_URL: "smtps://user:pass@smtp.example.test:465",
                MAIL_FROM: "no-reply@example.test",
            } as NodeJS.ProcessEnv).errors,
        ).toEqual([]);
        expect(mailConfigured(configured)).toBe(true);
    });

    it("names every problem with a half or malformed configuration", () => {
        expect(parseMailConfiguration({ SMTP_URL: "smtp://mailpit:1025" } as NodeJS.ProcessEnv).errors).toEqual([
            "MAIL_FROM is required when SMTP_URL is set",
        ]);
        expect(parseMailConfiguration({ MAIL_FROM: "a@b.test" } as NodeJS.ProcessEnv).errors).toEqual([
            "SMTP_URL is required when MAIL_FROM is set",
        ]);
        const bad = parseMailConfiguration({
            SMTP_URL: "https://mailpit:1025",
            MAIL_FROM: "not an address",
        } as NodeJS.ProcessEnv);
        expect(bad.config).toBeNull();
        expect(bad.errors).toHaveLength(2);
        expect(() => validateMailConfiguration({ SMTP_URL: "smtp://x" } as NodeJS.ProcessEnv)).toThrow(
            /email configuration is invalid/,
        );
        expect(() => validateMailConfiguration(configured)).not.toThrow();
    });
});

describe("sendMail", () => {
    it("reports not configured instead of throwing when email is off", async () => {
        const transport = vi.fn(async () => {});
        setMailTransport(transport);
        expect(await sendMail({ to: "a@b.test", subject: "s", text: "t" }, {} as NodeJS.ProcessEnv)).toEqual({
            ok: false,
            reason: "not_configured",
        });
        expect(transport).not.toHaveBeenCalled();
    });

    it("sends through the transport with the configured sender", async () => {
        const transport = vi.fn(async () => {});
        setMailTransport(transport);
        const result = await sendMail(
            { to: "jamie@example.test", subject: "Hello", text: "Body" },
            configured,
        );
        expect(result).toEqual({ ok: true });
        expect(transport).toHaveBeenCalledWith({
            from: "Mike <no-reply@mike.local>",
            to: "jamie@example.test",
            subject: "Hello",
            text: "Body",
        });
    });

    it("turns a transport failure into a result and logs only a category", async () => {
        setMailTransport(async () => {
            throw new Error("535 Authentication failed for user secret@host");
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const result = await sendMail(
            { to: "jamie@example.test", subject: "Hello", text: "Body" },
            configured,
        );
        expect(result).toEqual({ ok: false, reason: "send_failed" });
        const logged = JSON.stringify(errorSpy.mock.calls);
        expect(logged).not.toContain("secret@host");
        expect(logged).not.toContain("jamie@example.test");
    });
});

describe("mailLink", () => {
    it("joins the web app origin and a path without doubling slashes", () => {
        expect(mailLink("/settings/organizations", configured)).toBe(
            "https://app.example.test/settings/organizations",
        );
        expect(mailLink("projects/p1", {} as NodeJS.ProcessEnv)).toBe("http://localhost:3000/projects/p1");
    });
});
