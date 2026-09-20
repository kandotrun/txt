/**
 * Device-kept vault key (spec §6.4).
 *
 * IndexedDB is unavailable in the node test environment, so these tests cover
 * the parts that do not need storage: window arithmetic and the constants the
 * UI relies on. The full wrap/unwrap cycle is covered by the E2E suite in a
 * real browser, which is the only place `extractable: false` CryptoKeys and
 * IndexedDB behave as they will for a user.
 */

import { describe, expect, it } from "vitest";

import {
  DEVICE_KEEP_TTL_MS,
  IDLE_LOCK_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  STEPUP_TTL_MS,
} from "../../packages/protocol/src/windows.ts";

describe("session and retention windows (spec §5.4, §6.4)", () => {
  const days = (ms: number): number => ms / (24 * 60 * 60 * 1000);

  it("keeps the session for about a month of inactivity", () => {
    // Kan asked for roughly a month of retention; the idle window must be at
    // least 30 days and the absolute window comfortably longer.
    expect(days(SESSION_IDLE_TTL_MS)).toBeGreaterThanOrEqual(30);
    expect(days(SESSION_ABSOLUTE_TTL_MS)).toBeGreaterThan(days(SESSION_IDLE_TTL_MS));
  });

  it("keeps the device-held vault key for 30 days", () => {
    expect(days(DEVICE_KEEP_TTL_MS)).toBe(30);
  });

  it("still locks the in-memory key quickly", () => {
    // The idle lock may stay short precisely because re-unlock is silent when
    // device keeping is on.
    expect(IDLE_LOCK_MS).toBe(5 * 60 * 1000);
  });

  it("keeps step-up re-authentication short", () => {
    // Sensitive operations must still require a recent ceremony: the retention
    // work must not have widened this.
    expect(STEPUP_TTL_MS).toBe(5 * 60 * 1000);
  });
});

