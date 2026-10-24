/**
 * Agent MCP build: bundles the server/CLI into a single Node ESM file,
 * following the same esbuild approach as the Web build. The protocol
 * package is bundled in, so the crypto contract has exactly one
 * implementation (design §3).
 */

import esbuild from "esbuild";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);

await esbuild.build({
  entryPoints: { "txt-agent": path.join(root, "src/main.ts") },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  splitting: false,
  minify: false,
  sourcemap: false,
  outdir: path.join(root, "dist"),
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  legalComments: "none",
});

console.log("agent-mcp build complete");
