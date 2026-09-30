import { describe, expect, it } from "vitest";
import { readSessionToken } from "../../apps/worker/src/auth/sessions.ts";
import type { Env } from "../../apps/worker/src/types.ts";

const env = { APP_ORIGIN: "https://txt.2-38.com" } as Env;

describe("Web-only session transport", () => {
  it("accepts the unchanged browser cookie transport", () => {
    expect(readSessionToken(new Request(env.APP_ORIGIN, {
      headers: { cookie: "__Host-txt_session=synthetic-session" },
    }), env)).toEqual({ token: "synthetic-session", via: "cookie" });
  });

  it.each([undefined, "Bearer synthetic-session", "Basic synthetic-session"])(
    "does not authenticate Authorization transport %s", (authorization) => {
      const headers = new Headers();
      if (authorization !== undefined) headers.set("authorization", authorization);
      expect(readSessionToken(new Request(env.APP_ORIGIN, { headers }), env)).toBeNull();
    },
  );

  it("rejects mixed Authorization and cookie instead of falling back to the cookie", () => {
    expect(readSessionToken(new Request(env.APP_ORIGIN, {
      headers: { cookie: "__Host-txt_session=synthetic-session", authorization: "Bearer synthetic-session" },
    }), env)).toBeNull();
  });
});
