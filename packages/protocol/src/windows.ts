/**
 * Session and retention windows (spec §5.4, §6.4).
 *
 * Kept in the shared protocol package so the web app, the worker sessions and
 * the tests all read the same numbers. Values are milliseconds.
 */

/**
 * Session lifetime.
 *
 * Kan asked for roughly a month of retention, so the idle window is 30 days
 * (each authorized request extends it) and the absolute cap is 45 days.
 */
export const SESSION_ABSOLUTE_TTL_MS = 45 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sensitive operations always require a ceremony within this window. */
export const STEPUP_TTL_MS = 5 * 60 * 1000;

/**
 * How long a device-kept VaultKey stays valid (spec §6.4). The window is
 * extended on every successful unlock; explicit lock and logout delete it.
 */
export const DEVICE_KEEP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Agent access windows (agent design §5.3, §4.3).
 *
 * Agent tokens carry an absolute 30-day expiry and no idle window: agents
 * run intermittently, and the 30-day rhythm matches the T3 Code access
 * token the operator already renews. Enrollment pairing codes are
 * single-enrollment, hashed at rest, and expire after 10 minutes.
 */
export const AGENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AGENT_ENROLLMENT_TTL_MS = 10 * 60 * 1000;
