import { expect, test } from "vitest";
import { build } from "esbuild";
import { Script } from "node:vm";
import { PRF_INPUT_V1, sha256 } from "../../packages/protocol/src/crypto.ts";
import { utf8 } from "../../packages/protocol/src/encode.ts";

test("spec: 固定PRF入力は既存のSHA-256バイト列と完全一致する", async () => {
  expect(PRF_INPUT_V1).toEqual(await sha256(utf8("txt.2-38.com/prf-input/v1")));
});

test("spec: Service Workerの実バンドルはtop-level awaitを含まず起動できる", async () => {
  // Service Workers forbid top-level await, including in module workers.
  // IIFE compilation catches an await introduced by any bundled dependency.
  const result = await build({
    entryPoints: ["apps/web/src/app/service-worker.ts"],
    bundle: true, format: "iife", target: "es2022", write: false,
    minify: true, logLevel: "silent",
  });
  expect(() => new Script(result.outputFiles[0]!.text)).not.toThrow();
});
