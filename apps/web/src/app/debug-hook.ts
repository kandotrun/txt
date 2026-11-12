/**
 * Development-only inspection hook gate.
 *
 * The E2E suite observes async state through `window.__txtDebug`. That object
 * reaches the unlocked vault and the decrypted document, so it must never
 * exist on a deployed origin: any script that ever ran in the page — an
 * extension's injected script, for one — could read it by a well-known name.
 * Only a plain-http loopback page gets it; production is https-only (HSTS).
 */
export function debugHookAllowed(location: { protocol: string; hostname: string }): boolean {
  return (
    location.protocol === "http:" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  );
}
