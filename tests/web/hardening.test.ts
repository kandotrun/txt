/**
 * Client-side hardening contracts (spec §6.4, §14).
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { api } from "../../apps/web/src/app/api.ts";
import { debugHookAllowed } from "../../apps/web/src/app/debug-hook.ts";
import { renderableMime } from "../../apps/web/src/app/media-types.ts";
import { createScriptUrlPolicy, isTrustedScriptUrl } from "../../apps/web/src/app/trusted-types.ts";
import {
  BASELINE_SECURITY_HEADERS,
  SHELL_CSP,
  renderStaticHeaders,
} from "../../apps/worker/src/security-headers.ts";

const ORIGIN = "https://txt.2-38.com";

describe("debug hook", () => {
  it.each([
    ["https://txt.2-38.com/", false],
    ["https://localhost/", false],
    ["https://txt.2-38.com.evil.example/", false],
    ["http://localhost:8799/", true],
    ["http://127.0.0.1:8799/", true],
  ])("spec: %s exposes the inspection hook: %s", (href, allowed) => {
    expect(debugHookAllowed(new URL(href))).toBe(allowed);
  });

  it("spec: the app never assigns the hook unconditionally", async () => {
    const source = await readFile(new URL("../../apps/web/src/app/main.ts", import.meta.url), "utf8");
    const assignments = source.split("\n").filter((line) => /window\.__txtDebug\s*=/.test(line));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatch(/^\s*if \(debugHookAllowed\(/);
  });
});

describe("Trusted Types script URLs", () => {
  it.each([
    ["/sw.js", true],
    ["assets/crypto-worker.VKMA6QUP.js", true],
    ["/assets/crypto-worker.VKMA6QUP.js", true],
    ["/assets/app.J2SZCF7V.js", false],
    ["https://evil.example/sw.js", false],
    ["//evil.example/assets/crypto-worker.AAAA.js", false],
    ["/assets/../sw.js?x=1", false],
    ["/sw.js#fragment", false],
    ["data:text/javascript,alert(1)", false],
    ["blob:https://txt.2-38.com/1234", false],
    ["/_local/media/x.js", false],
  ])("spec: %s is a script URL the app may start: %s", (url, allowed) => {
    expect(isTrustedScriptUrl(url, `${ORIGIN}/`)).toBe(allowed);
  });

  it("spec: the policy refuses everything else instead of passing it through", () => {
    const createPolicy = vi.fn((_name: string, rules: { createScriptURL: (url: string) => string }) => rules);
    const policy = createScriptUrlPolicy({ createPolicy } as never, `${ORIGIN}/`);
    expect(createPolicy).toHaveBeenCalledWith("txt", expect.anything());
    expect(policy.createScriptURL("/sw.js")).toBe("/sw.js");
    expect(() => policy.createScriptURL("https://evil.example/x.js")).toThrow(TypeError);
  });

  it("spec: without Trusted Types support the same allow-list still applies", () => {
    const policy = createScriptUrlPolicy(undefined, `${ORIGIN}/`);
    expect(policy.createScriptURL("/sw.js")).toBe("/sw.js");
    expect(() => policy.createScriptURL("data:text/javascript,1")).toThrow(TypeError);
  });
});

describe("media types at render time", () => {
  it.each([
    ["image/png", "image/png"],
    ["IMAGE/PNG", "image/png"],
    ["video/quicktime", "video/quicktime"],
    ["audio/x-m4a", "audio/x-m4a"],
    ["image/svg+xml", "application/octet-stream"],
    ["text/html", "application/octet-stream"],
    ["text/html; charset=utf-8", "application/octet-stream"],
    ["application/pdf", "application/octet-stream"],
    ["", "application/octet-stream"],
  ])("spec: %s renders as %s", (stored, rendered) => {
    expect(renderableMime(stored)).toBe(rendered);
  });
});

describe("static security headers", () => {
  it("spec: the shell policy is same-origin only and enforces Trusted Types", () => {
    const directives = SHELL_CSP.split("; ");
    expect.soft(directives).toContain("default-src 'self'");
    expect.soft(directives).toContain("script-src 'self'");
    expect.soft(directives).toContain("object-src 'none'");
    expect.soft(directives).toContain("frame-src 'none'");
    expect.soft(directives).toContain("frame-ancestors 'none'");
    expect.soft(directives).toContain("require-trusted-types-for 'script'");
    expect.soft(directives).toContain("trusted-types txt ProseMirrorClipboard");
    expect(SHELL_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:|data:/);
    // blob: is for decrypted images only.
    expect(directives.filter((directive) => directive.includes("blob:"))).toEqual(["img-src 'self' blob:"]);
  });

  it("spec: the build renders the Worker's header values into _headers", async () => {
    const template = await readFile(new URL("../../apps/web/static/_headers", import.meta.url), "utf8");
    const rendered = renderStaticHeaders(template);
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
    const everyPath = rendered.slice(rendered.indexOf("\n/*\n"), rendered.indexOf("\n\n", rendered.indexOf("\n/*\n")));
    expect.soft(everyPath).toContain(`Content-Security-Policy: ${SHELL_CSP}`);
    expect.soft(everyPath).toContain(
      `Strict-Transport-Security: ${BASELINE_SECURITY_HEADERS["strict-transport-security"]}`,
    );
    expect.soft(everyPath).toContain(`Permissions-Policy: ${BASELINE_SECURITY_HEADERS["permissions-policy"]}`);
    expect.soft(everyPath).toContain("X-Frame-Options: DENY");
    expect.soft(everyPath).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect.soft(everyPath).toContain("X-Content-Type-Options: nosniff");
    expect.soft(everyPath).toContain("Referrer-Policy: no-referrer");
    // The share card must stay embeddable; scripts and the shell must not be.
    const block = (path: string) => rendered.split(/\n(?=\/)/).find((entry) => entry.startsWith(`${path}\n`)) ?? "";
    expect.soft(block("/og.png")).not.toContain("Cross-Origin-Resource-Policy");
    expect.soft(block("/assets/*")).toContain("Cross-Origin-Resource-Policy: same-origin");
    expect.soft(block("/sw.js")).toContain("Cross-Origin-Resource-Policy: same-origin");
    expect(() => renderStaticHeaders("/*\n  X: __UNKNOWN__\n")).toThrow(/unknown placeholder/);
  });
});

describe("document ETags on the client", () => {
  it("spec: the ETag kept for a copy is the same string whether or not the edge weakened it", async () => {
    // Cloudflare's edge may rewrite the origin's ETag into its weak form. The
    // client compares the ETags it holds with each other (a draft's base with
    // the loaded copy's), so it keeps one form only.
    const body = JSON.stringify({ documentId: "d", encryptedRevision: 3 });
    const answer = (etag: string): Response => new Response(body, { status: 200, headers: { etag, "content-type": "application/json" } });
    const fetchStub = vi.fn<(...args: unknown[]) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchStub);
    try {
      fetchStub.mockResolvedValueOnce(answer('W/"d-1-e-1-r3"'));
      const weakened = await api.document();
      fetchStub.mockResolvedValueOnce(answer('"d-1-e-1-r3"'));
      const untouched = await api.document();
      expect(weakened.etag).toBe('"d-1-e-1-r3"');
      expect(untouched.etag).toBe('"d-1-e-1-r3"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
