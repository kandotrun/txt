import { expect, test } from "@playwright/test";

const BASE = process.env.TXT_BASE_URL ?? "http://localhost:8799";

for (const path of ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"]) {
  test(`spec: ブラウザで${path}へ移動しても関連付けやSPAを配信しない`, async ({ page }) => {
    // 実ナビゲーションを使い、Workerを迂回するアセットルーターも検証する。
    const response = await page.goto(`${BASE}${path}`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(404);
    expect(response!.headers()["cache-control"]).toContain("no-store");
    expect(response!.headers()["content-type"]).toContain("text/plain");
    expect(await response!.text()).toBe("not found");
  });
}

test("spec: Web専用化後もルートとOGP・ホーム画面アイコンを配信する", async ({ page, request }) => {
  const root = await page.goto(BASE);
  expect(root!.status()).toBe(200);
  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.getByRole("button", { name: "はじめて使う" })).toBeVisible();
  for (const path of ["/og.png", "/apple-touch-icon.png"]) {
    const response = await request.get(`${BASE}${path}`, { headers: { "Sec-Fetch-Mode": "navigate" } });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
});

for (const navigate of [false, true]) {
  test(`spec: ${navigate ? "ナビゲーション" : "通常GET"}でもAPIとローカルメディアをSPAへ迂回しない`, async ({ request }) => {
    const headers: Record<string, string> = navigate ? { "Sec-Fetch-Mode": "navigate" } : {};
    for (const [path, status, type] of [
      ["/api/v1/health", 200, "application/json"],
      ["/api/v1/session", 401, "application/json"],
      ["/api/v1/does-not-exist", 404, "application/json"],
      ["/_local/media/x", 404, "text/plain"],
    ] as const) {
      const response = await request.get(`${BASE}${path}`, { headers });
      expect(response.status(), path).toBe(status);
      expect(response.headers()["content-type"], path).toContain(type);
      expect(response.headers()["cache-control"], path).toContain("no-store");
      if (path === "/api/v1/health") expect((await response.json()).ok).toBe(true);
      else if (type === "application/json") expect(await response.json()).toHaveProperty("error");
      else expect(await response.text()).toBe("not found");
    }
  });
}
