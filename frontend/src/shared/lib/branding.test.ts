import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
    vi.resetModules();
    return import("./branding");
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("branding", () => {
    it("is Mike's name, tagline and home page when unset", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "");
        vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "");
        vi.stubEnv("NEXT_PUBLIC_APP_HOME_URL", "");
        vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
        vi.stubEnv("NEXT_PUBLIC_APP_DESCRIPTION", "");
        const branding = await load();
        expect(branding.APP_NAME).toBe("Mike");
        expect(branding.APP_TAGLINE).toBe("Legal AI Platform");
        expect(branding.APP_HOME_URL).toBe("https://mikeoss.com");
        expect(branding.appTitle()).toBe("Mike");
        expect(branding.appTitle(branding.APP_TAGLINE)).toBe("Mike - Legal AI Platform");
        expect(branding.APP_URL).toBe("https://app.mikeoss.com");
        expect(branding.APP_DESCRIPTION).toBe(
            "AI-powered legal document analysis and contract review platform.",
        );
    });

    it("reads the app's own URL and description", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.tax-oss.com");
        vi.stubEnv("NEXT_PUBLIC_APP_DESCRIPTION", "Open source AI for tax work.");
        const branding = await load();
        expect(branding.APP_URL).toBe("https://app.tax-oss.com");
        expect(branding.APP_DESCRIPTION).toBe("Open source AI for tax work.");
    });

    it("reads the environment", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "Tax OSS");
        vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "Open source tax AI platform");
        vi.stubEnv("NEXT_PUBLIC_APP_HOME_URL", "https://tax-oss.com");
        const branding = await load();
        expect(branding.APP_NAME).toBe("Tax OSS");
        expect(branding.APP_HOME_URL).toBe("https://tax-oss.com");
        expect(branding.appTitle(branding.APP_TAGLINE)).toBe(
            "Tax OSS - Open source tax AI platform",
        );
    });

    it("falls back on whitespace and trims", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "   ");
        vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "  Tagline  ");
        const branding = await load();
        expect(branding.APP_NAME).toBe("Mike");
        expect(branding.APP_TAGLINE).toBe("Tagline");
    });
});
