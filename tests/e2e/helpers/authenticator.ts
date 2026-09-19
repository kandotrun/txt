/**
 * Virtual authenticator helpers (CDP WebAuthn domain).
 *
 * The virtual authenticator is configured with `hasPrf: true` so the full
 * passkey + PRF flow can be exercised end to end without a physical key.
 *
 * CDP virtual authenticators are owned by the *browser*, but adding one is a
 * per-session operation. Two pages in the same context must therefore share a
 * single authenticator (a real device would behave the same way); this helper
 * installs one per browser context and reuses it for later pages.
 */

import type { BrowserContext, CDPSession, Page } from "@playwright/test";

export interface VirtualAuthenticatorOptions {
  hasPrf?: boolean;
  automaticPresenceSimulation?: boolean;
}

export interface VirtualAuthenticator {
  authenticatorId: string;
  /** CDP session of the page that created it (used for credential queries). */
  client: CDPSession;
}

const installedByContext = new WeakMap<BrowserContext, VirtualAuthenticator>();

export async function installVirtualAuthenticator(
  page: Page,
  options: VirtualAuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const existing = installedByContext.get(page.context());
  if (existing) {
    // The authenticator already holds the credentials created earlier in this
    // context; a second authenticator would not know them.
    return existing;
  }
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: options.automaticPresenceSimulation ?? true,
      hasPrf: options.hasPrf ?? true,
    },
  });
  const authenticator: VirtualAuthenticator = { authenticatorId, client };
  installedByContext.set(page.context(), authenticator);
  return authenticator;
}

export async function listCredentials(
  client: CDPSession,
  authenticatorId: string,
): Promise<Array<{ credentialId: string }>> {
  const { credentials } = await client.send("WebAuthn.getCredentials", { authenticatorId });
  return credentials.map((credential) => ({ credentialId: credential.credentialId }));
}
