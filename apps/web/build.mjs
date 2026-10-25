/**
 * Web build: bundles the app entry and copies static assets.
 *
 * Spec §2/§16: no framework. HTML/CSS/JS plus the minimal ProseMirror set.
 * The output directory is what the Worker serves through the ASSETS binding.
 */

import esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(root, "dist");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });

const result = await esbuild.build({
  entryPoints: {
    app: path.join(root, "src/app/main.ts"),
    "sw": path.join(root, "src/app/service-worker.ts"),
    "crypto-worker": path.join(root, "src/app/crypto-worker.ts"),
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  splitting: false,
  minify: true,
  sourcemap: false,
  outdir: path.join(dist, "assets"),
  entryNames: "[name].[hash]",
  assetNames: "assets/[name].[hash]",
  metafile: true,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

// The Service Worker must be reachable at a stable, unhashed path.
const swEntry = Object.keys(result.metafile.outputs).find((file) => /[/\\]sw\.[A-Z0-9]+\.js$/.test(file));
const cryptoWorkerEntry = Object.keys(result.metafile.outputs).find((file) =>
  /[/\\]crypto-worker\.[A-Z0-9]+\.js$/.test(file),
);
const appEntry = Object.keys(result.metafile.outputs).find((file) =>
  /[/\\]app\.[A-Z0-9]+\.js$/.test(file),
);
if (!swEntry || !appEntry || !cryptoWorkerEntry) {
  throw new Error("build: expected bundles were not produced");
}

const swOutput = path.basename(swEntry);
const cryptoWorkerOutput = path.basename(cryptoWorkerEntry);
const appOutput = path.basename(appEntry);

await fs.copyFile(path.join(dist, "assets", swOutput), path.join(dist, "sw.js"));

for (const name of [
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "icon.svg",
  "_headers",
  // Share card and crawler files (spec §14).
  "og.png",
  "apple-touch-icon.png",
  "robots.txt",
]) {
  await fs.copyFile(path.join(root, "static", name), path.join(dist, name));
}

// AI-agent connection guides (spec §17.4). The canonical sources live in
// skills/txt-agent/ and are copied at build time so the served files can
// never drift from the repo copies. Real files in dist are served as-is
// by the ASSETS binding — they are not replaced by the SPA shell.
const repoRoot = path.join(root, "..", "..");
for (const [from, to] of [
  ["skills/txt-agent/SKILL.md", "agents.md"],
  ["skills/txt-agent/SKILL.ja.md", "agents.ja.md"],
  ["skills/txt-agent/llms.txt", "llms.txt"],
]) {
  await fs.copyFile(path.join(repoRoot, from), path.join(dist, to));
}

// index.html references the hashed app bundle and the crypto worker URL.
const html = await fs.readFile(path.join(dist, "index.html"), "utf8");
const replaced = html
  .replace("__APP_BUNDLE__", `assets/${appOutput}`)
  .replace("__CRYPTO_WORKER__", `assets/${cryptoWorkerOutput}`);
await fs.writeFile(path.join(dist, "index.html"), replaced);

const total = Object.entries(result.metafile.outputs).reduce(
  (sum, [, output]) => sum + (output.bytes ?? 0),
  0,
);
console.log(`web build complete: ${Object.keys(result.metafile.outputs).length} bundles, ${(total / 1024).toFixed(1)} KiB`);
