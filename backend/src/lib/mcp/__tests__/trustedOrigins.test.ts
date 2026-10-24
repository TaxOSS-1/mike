import { describe, expect, it } from "vitest";
import {
    isMetadataAddress,
    isTrustedPrivateOrigin,
    parseTrustedPrivateOrigins,
    trustedPrivateHostnames,
} from "../trustedOrigins";

describe("parseTrustedPrivateOrigins", () => {
    it("accepts exact origins separated by commas or whitespace, normalised", () => {
        const parsed = parseTrustedPrivateOrigins(
            " http://tax-register:8080, HTTPS://Ollama.internal:443/ \n http://localhost:11434 ",
        );
        expect(parsed.errors).toEqual([]);
        expect(parsed.origins).toEqual([
            "http://tax-register:8080",
            "https://ollama.internal",
            "http://localhost:11434",
        ]);
    });

    it("treats an empty or unset value as no trusted origins", () => {
        expect(parseTrustedPrivateOrigins(undefined)).toEqual({ origins: [], errors: [] });
        expect(parseTrustedPrivateOrigins("  ")).toEqual({ origins: [], errors: [] });
    });

    it("reports every entry that is not a bare http(s) origin", () => {
        const parsed = parseTrustedPrivateOrigins(
            "::::, ftp://files.internal, http://a.internal/mcp, http://u:p@b.internal, http://c.internal/?x=1",
        );
        expect(parsed.origins).toEqual([]);
        expect(parsed.errors).toHaveLength(5);
        expect(parsed.errors[0]).toMatch(/is not a URL/);
        expect(parsed.errors[1]).toMatch(/must use http or https/);
        expect(parsed.errors[2]).toMatch(/must be an origin/);
        expect(parsed.errors[3]).toMatch(/must be an origin/);
        expect(parsed.errors[4]).toMatch(/must be an origin/);
    });

    it("never accepts a cloud metadata endpoint", () => {
        for (const entry of [
            "http://metadata.google.internal",
            "http://instance-data",
            "http://169.254.169.254",
            "http://[::ffff:169.254.169.254]",
            "http://METADATA.GOOGLE.INTERNAL.",
        ]) {
            const parsed = parseTrustedPrivateOrigins(entry);
            expect(parsed.origins, entry).toEqual([]);
            expect(parsed.errors[0], entry).toMatch(/cloud metadata endpoint/);
        }
    });

    it("de-duplicates origins that differ only in case or default port", () => {
        const parsed = parseTrustedPrivateOrigins(
            "http://a.internal:80, http://A.internal, https://b.internal:443, https://b.internal",
        );
        expect(parsed.origins).toEqual(["http://a.internal", "https://b.internal"]);
    });
});

describe("isTrustedPrivateOrigin", () => {
    const env = { TRUSTED_PRIVATE_ORIGINS: "http://tax-register:8080" } as NodeJS.ProcessEnv;

    it("matches the exact origin only", () => {
        expect(isTrustedPrivateOrigin(new URL("http://tax-register:8080/mcp"), env)).toBe(true);
        expect(isTrustedPrivateOrigin(new URL("http://TAX-REGISTER:8080/"), env)).toBe(true);
        expect(isTrustedPrivateOrigin(new URL("https://tax-register:8080/mcp"), env)).toBe(false);
        expect(isTrustedPrivateOrigin(new URL("http://tax-register:9000/mcp"), env)).toBe(false);
        expect(isTrustedPrivateOrigin(new URL("http://tax-register/mcp"), env)).toBe(false);
        expect(isTrustedPrivateOrigin(new URL("http://tax-register.evil.example:8080/"), env)).toBe(
            false,
        );
    });

    it("trusts nothing when the variable is unset", () => {
        expect(isTrustedPrivateOrigin(new URL("http://tax-register:8080/mcp"), {} as NodeJS.ProcessEnv)).toBe(
            false,
        );
    });

    it("lists the trusted hostnames for the connect-time guard", () => {
        expect([...trustedPrivateHostnames(env)]).toEqual(["tax-register"]);
    });
});

describe("isMetadataAddress", () => {
    it("blocks the link-local ranges and nothing else", () => {
        expect(isMetadataAddress("169.254.169.254")).toBe(true);
        expect(isMetadataAddress("169.254.0.1")).toBe(true);
        expect(isMetadataAddress("fe80::1")).toBe(true);
        expect(isMetadataAddress("FE80::1%eth0")).toBe(true);
        expect(isMetadataAddress("::ffff:169.254.169.254")).toBe(true);
        expect(isMetadataAddress("::ffff:a9fe:a9fe")).toBe(true);
        expect(isMetadataAddress("172.18.0.5")).toBe(false);
        expect(isMetadataAddress("10.0.0.5")).toBe(false);
        expect(isMetadataAddress("127.0.0.1")).toBe(false);
        expect(isMetadataAddress("fd00::1")).toBe(false);
        expect(isMetadataAddress("not-an-ip")).toBe(true);
    });
});
