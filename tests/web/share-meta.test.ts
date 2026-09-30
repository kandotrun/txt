/**
 * Share card and search metadata of the public shell (spec §4.2, §14).
 *
 * Crawlers read the static files as shipped, so these checks run against
 * `apps/web/static/` directly.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const STATIC = path.resolve(import.meta.dirname, "../../apps/web/static");
const ORIGIN = "https://txt.2-38.com";
const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
const head = html.slice(0, html.indexOf("</head>"));

/** Content of `<meta {attribute}="{name}" content="…">` (first match). */
function meta(attribute: "name" | "property", name: string): string | undefined {
  const tag = head.match(new RegExp(`<meta\\s+${attribute}="${name}"[^>]*>`))?.[0];
  return tag?.match(/content="([^"]*)"/)?.[1];
}

function link(rel: string): string | undefined {
  const tag = head.match(new RegExp(`<link\\s+rel="${rel}"[^>]*>`))?.[0];
  return tag?.match(/href="([^"]*)"/)?.[1];
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(path.join(STATIC, file));
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("public shell metadata", () => {
  it("allows search indexing", () => {
    expect(meta("name", "robots") ?? "").not.toMatch(/noindex|nofollow/);
  });

  it("keeps the fixed title (spec §4.2)", () => {
    expect(head).toContain("<title>txt</title>");
  });

  it("describes the app for search results and link previews", () => {
    expect(meta("name", "description")).toMatch(/パスキー/);
    expect(meta("property", "og:description")).toMatch(/パスキー/);
    expect(meta("property", "og:title")).toMatch(/^txt — /);
    expect(meta("property", "og:site_name")).toBe("txt");
    expect(meta("property", "og:type")).toBe("website");
    expect(meta("property", "og:locale")).toBe("ja_JP");
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
  });

  it("uses absolute production URLs for canonical, og:url and og:image", () => {
    expect(link("canonical")).toBe(`${ORIGIN}/`);
    expect(meta("property", "og:url")).toBe(`${ORIGIN}/`);
    expect(meta("property", "og:image")).toBe(`${ORIGIN}/og.png`);
    expect(meta("property", "og:image:alt")).toBeTruthy();
  });

  it("declares the share image size that the file actually has", () => {
    const size = pngSize("og.png");
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(meta("property", "og:image:width")).toBe(String(size.width));
    expect(meta("property", "og:image:height")).toBe(String(size.height));
  });

  it("offers a 180×180 touch icon and light/dark theme colours", () => {
    expect(link("apple-touch-icon")).toBe("/apple-touch-icon.png");
    expect(pngSize("apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
    expect(head).toMatch(/<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)"/);
    expect(head).toMatch(/<meta name="theme-color" content="#0b0b0c" media="\(prefers-color-scheme: dark\)"/);
  });
});

describe("robots.txt", () => {
  const robots = fs.readFileSync(path.join(STATIC, "robots.txt"), "utf8");

  it("allows the shell and keeps the API and local media out", () => {
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).toMatch(/^Disallow: \/api\/$/m);
    expect(robots).toMatch(/^Disallow: \/_local\/$/m);
  });
});

describe("web build", () => {
  it("ships the share files with the shell", () => {
    const build = fs.readFileSync(path.resolve(STATIC, "../build.mjs"), "utf8");
    for (const file of ["og.png", "apple-touch-icon.png", "robots.txt"]) {
      expect(build).toContain(`"${file}"`);
    }
  });
});
