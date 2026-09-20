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
 * Idle lock: how long the app may sit unattended before it drops the in-memory
 * VaultKey. With device keeping enabled the re-unlock is silent, so this can be
 * short without hurting the user (spec §6.4).
 */
export const IDLE_LOCK_MS = 5 * 60 * 1000;
