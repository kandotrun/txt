/**
 * Response headers every Worker response carries (spec §14).
 *
 * Cloudflare serves static files without invoking the Worker, so the web build
 * renders the same values into `_headers` through `renderStaticHeaders`.
 */

/**
 * Browser features the app never uses are switched off for this origin and
 * for anything it could ever embed. Passkeys, clipboard writes and fullscreen
 * media are the features it does use. Only names every target browser
 * recognises are listed — an unknown one is ignored with a console error —
 * so the share sheet (`web-share`, same-origin by default) is left unnamed.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=(self)",
  "bluetooth=()",
  "browsing-topics=()",
  "camera=()",
  "clipboard-write=(self)",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=(self)",
  "publickey-credentials-create=(self)",
  "publickey-credentials-get=(self)",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/** Two years; the host has no http surface and no subdomains of its own. */
export const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains";

export const BASELINE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": STRICT_TRANSPORT_SECURITY,
  // Legacy twin of `frame-ancestors 'none'`.
  "x-frame-options": "DENY",
  // No other origin may hold a window reference to, or embed a response of,
  // this origin.
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": PERMISSIONS_POLICY,
};

/**
 * Content Security Policy for the HTML shell and every static file.
 *
 * Everything is same-origin. `blob:` is allowed for images only (decrypted
 * small images); video and audio stream from the Service Worker's same-origin
 * virtual URLs. Trusted Types closes the DOM-injection sinks: the app's own
 * `txt` policy only passes its two same-origin script URLs, and
 * `ProseMirrorClipboard` is the editor's clipboard parser, which builds a
 * detached document and never executes it.
 */
export const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "media-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types txt ProseMirrorClipboard",
].join("; ");

/** Fills the `__NAME__` placeholders of the `_headers` template. */
export function renderStaticHeaders(template: string): string {
  const values: Record<string, string> = {
    STRICT_TRANSPORT_SECURITY,
    PERMISSIONS_POLICY,
    SHELL_CSP,
  };
  const rendered = template.replace(/__([A-Z_]+)__/g, (match, name: string) => values[name] ?? match);
  const unresolved = /__[A-Z_]+__/.exec(rendered);
  if (unresolved) throw new Error(`_headers: unknown placeholder ${unresolved[0]}`);
  return rendered;
}
