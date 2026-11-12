/**
 * Trusted Types policy for the app's script URLs (spec §14).
 *
 * The CSP sets `require-trusted-types-for 'script'`, so the browser refuses a
 * plain string at every DOM sink that can run code. The app has exactly two
 * such sinks — starting the crypto worker and registering the Service Worker —
 * and both take a fixed, same-origin, build-produced URL. This policy passes
 * those two shapes and throws on anything else, so even a bug that let an
 * attacker choose the string could not start a script of their choosing.
 *
 * Browsers without Trusted Types get the same check from the fallback object.
 */

interface ScriptUrlPolicy {
  /** A string, or the browser's TrustedScriptURL wrapper around it. */
  createScriptURL(url: string): string | object;
}

interface PolicyFactory {
  createPolicy(name: string, rules: { createScriptURL: (url: string) => string }): ScriptUrlPolicy;
}

const SERVICE_WORKER_PATH = "/sw.js";
const CRYPTO_WORKER_PATH = /^\/assets\/crypto-worker\.[A-Za-z0-9]+\.js$/;

/** Whether `url` is one of the two scripts this app is allowed to start. */
export function isTrustedScriptUrl(url: string, base: string): boolean {
  let parsed: URL;
  let origin: string;
  try {
    origin = new URL(base).origin;
    parsed = new URL(url, base);
  } catch {
    return false;
  }
  if (parsed.origin !== origin || parsed.search !== "" || parsed.hash !== "") return false;
  // Compare the path as written, not as normalised: `/assets/../sw.js` is not
  // a URL the build ever produces.
  const written = url.startsWith("/") ? url : `/${url}`;
  if (written !== parsed.pathname) return false;
  return parsed.pathname === SERVICE_WORKER_PATH || CRYPTO_WORKER_PATH.test(parsed.pathname);
}

export function createScriptUrlPolicy(
  factory: PolicyFactory | undefined,
  base: string,
): ScriptUrlPolicy {
  const rules = {
    createScriptURL(url: string): string {
      if (!isTrustedScriptUrl(url, base)) throw new TypeError("refused script URL");
      return url;
    },
  };
  return factory ? factory.createPolicy("txt", rules) : rules;
}

let policy: ScriptUrlPolicy | null = null;

/** Vets a script URL for `new Worker` / `serviceWorker.register`. */
export function trustedScriptUrl(url: string): string {
  policy ??= createScriptUrlPolicy(
    (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes,
    document.baseURI,
  );
  // The DOM accepts a TrustedScriptURL wherever it takes a URL string.
  return policy.createScriptURL(url) as string;
}
