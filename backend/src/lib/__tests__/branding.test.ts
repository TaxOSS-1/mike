import { afterEach, describe, expect, it } from "vitest";
import { appDomain, appName, assistantPersona } from "../branding";

afterEach(() => {
    delete process.env.APP_NAME;
    delete process.env.APP_ASSISTANT_PERSONA;
    delete process.env.APP_DOMAIN;
});

describe("branding", () => {
    it("defaults to Mike and the legal persona", () => {
        expect(appName()).toBe("Mike");
        expect(assistantPersona()).toBe(
            "an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.",
        );
        expect(appDomain()).toBe("legal");
    });

    it("reads the environment", () => {
        process.env.APP_NAME = "Tax OSS";
        process.env.APP_ASSISTANT_PERSONA = "an AI assistant for tax professionals.";
        process.env.APP_DOMAIN = "tax";
        expect(appName()).toBe("Tax OSS");
        expect(assistantPersona()).toBe("an AI assistant for tax professionals.");
        expect(appDomain()).toBe("tax");
    });

    it("falls back on empty or whitespace values", () => {
        process.env.APP_NAME = "   ";
        process.env.APP_ASSISTANT_PERSONA = "";
        process.env.APP_DOMAIN = "";
        expect(appName()).toBe("Mike");
        expect(assistantPersona()).toBe(
            "an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.",
        );
        expect(appDomain()).toBe("legal");
    });

    it("trims surrounding whitespace", () => {
        process.env.APP_NAME = "  Tax OSS  ";
        expect(appName()).toBe("Tax OSS");
    });
});
