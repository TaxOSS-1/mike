// Operator-trusted private origins for guarded egress.
//
// `validateRemoteMcpUrl` refuses plain http and any host that resolves to a
// loopback, private or link-local address, because the URL comes from a user
// and the backend must never become a proxy into the network it runs in. A
// self-hosted deployment, though, often runs the service it wants to connect
// beside Mike: an MCP server or an OpenAI-compatible model endpoint on the
// same Compose network, reachable only as `http://service:port`. The operator
// (never the user) can name those origins exactly in TRUSTED_PRIVATE_ORIGINS.
//
// The exception is as narrow as the configuration: an origin is
// `scheme://host[:port]`, compared exactly after URL normalisation, so
// `http://tax-register:8080` trusts neither `https://tax-register:8080` nor
// `http://tax-register:9000`. Cloud metadata endpoints can never be trusted:
// their names are rejected at boot and their link-local addresses stay blocked
// even when a trusted name resolves to one.

import net from "net";
import { BLOCKED_METADATA_HOSTS, canonicalHostname } from "./types";

export const TRUSTED_PRIVATE_ORIGINS_ENV = "TRUSTED_PRIVATE_ORIGINS";

export type ParsedTrustedOrigins = {
    /** Normalised origins, e.g. "http://tax-register:8080". */
    origins: string[];
    /** One message per entry that was not accepted. */
    errors: string[];
};

/**
 * Parse the TRUSTED_PRIVATE_ORIGINS value: origins separated by commas or
 * whitespace. Every entry must be an http or https URL with nothing beyond
 * the origin (no path other than "/", no query, hash or credentials) and must
 * not name a cloud metadata host. Invalid entries are reported, never
 * silently dropped, so that a typo cannot widen or narrow the trust list
 * unnoticed; `validateEgressConfiguration` turns them into a boot failure.
 */
export function parseTrustedPrivateOrigins(raw: string | undefined): ParsedTrustedOrigins {
    const origins = new Set<string>();
    const errors: string[] = [];
    for (const entry of (raw ?? "").split(/[\s,]+/)) {
        if (!entry) continue;
        let url: URL;
        try {
            url = new URL(entry);
        } catch {
            errors.push(`${TRUSTED_PRIVATE_ORIGINS_ENV}: "${entry}" is not a URL`);
            continue;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            errors.push(`${TRUSTED_PRIVATE_ORIGINS_ENV}: "${entry}" must use http or https`);
            continue;
        }
        if (
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.pathname !== "/" && url.pathname !== "")
        ) {
            errors.push(
                `${TRUSTED_PRIVATE_ORIGINS_ENV}: "${entry}" must be an origin (scheme://host[:port]) with no path, query, hash or credentials`,
            );
            continue;
        }
        const hostname = canonicalHostname(url);
        if (isMetadataHost(hostname)) {
            errors.push(
                `${TRUSTED_PRIVATE_ORIGINS_ENV}: "${entry}" names a cloud metadata endpoint, which can never be trusted`,
            );
            continue;
        }
        origins.add(url.origin.toLowerCase());
    }
    return { origins: [...origins], errors };
}

/** Origins the operator trusts; invalid entries are ignored here (boot rejects them). */
export function trustedPrivateOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
    return new Set(parseTrustedPrivateOrigins(env[TRUSTED_PRIVATE_ORIGINS_ENV]).origins);
}

/** True when `url` has exactly one of the trusted origins. */
export function isTrustedPrivateOrigin(url: URL, env: NodeJS.ProcessEnv = process.env): boolean {
    return trustedPrivateOrigins(env).has(url.origin.toLowerCase());
}

/** Hostnames of the trusted origins, for the connect-time DNS guard. */
export function trustedPrivateHostnames(env: NodeJS.ProcessEnv = process.env): Set<string> {
    const names = new Set<string>();
    for (const origin of trustedPrivateOrigins(env)) {
        names.add(canonicalHostname(new URL(origin)));
    }
    return names;
}

function isMetadataHost(hostname: string): boolean {
    const literal =
        hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (BLOCKED_METADATA_HOSTS.has(hostname)) return true;
    return net.isIP(literal) !== 0 && isMetadataAddress(literal);
}

// 169.254.0.0/16 and fe80::/10 carry every cloud provider's metadata service;
// the IPv4-mapped form of the former is listed so a literal written as
// ::ffff:169.254.169.254 (which URL normalises to ::ffff:a9fe:a9fe) is caught.
const metadataRanges = new net.BlockList();
metadataRanges.addSubnet("169.254.0.0", 16, "ipv4");
metadataRanges.addSubnet("fe80::", 10, "ipv6");
metadataRanges.addSubnet("::ffff:169.254.0.0", 112, "ipv6");

/**
 * Addresses a trusted origin may still not reach: the link-local ranges that
 * carry cloud metadata services. Everything else is the operator's own
 * network, which is what trusting the origin means. Non-IP input is blocked.
 */
export function isMetadataAddress(address: string): boolean {
    const normalized = address.toLowerCase().split("%", 1)[0];
    const family = net.isIP(normalized);
    if (family === 4) return metadataRanges.check(normalized, "ipv4");
    if (family === 6) return metadataRanges.check(normalized, "ipv6");
    return true;
}
