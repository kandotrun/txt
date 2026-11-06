/**
 * `txt-agent edit`: edit the memo in the user's own editor (spec §6.6
 * exception; design §8.6).
 *
 * Flow: fetch + decrypt the current document → write the plaintext to a
 * 0600 file inside a fresh 0700 temp directory on the same device → open
 * it with the user's editor (default `zed --wait`) → re-read the file and
 * save the result through the vault's existing CAS write path.
 *
 * On success (or a no-change exit) the temp directory is removed. On a
 * conflict, a rejection, or any failure the edited file is KEPT and its
 * path printed, so the user's work is never lost silently; the command
 * then exits non-zero. `--keep` preserves the file even on success.
 * Nothing here logs plaintext, keys, or tokens.
 */

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentState } from "./config.ts";
import { AgentVault } from "./vault.ts";
import type { WriteOutcome } from "./vault.ts";

function argValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/** Editor resolution: --editor flag > $EDITOR > `zed --wait`. */
function resolveEditorCommand(argv: string[]): string[] {
  const spec = argValue(argv, "--editor") ?? process.env.EDITOR ?? "zed --wait";
  const parts = spec.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error("no editor command: pass --editor or set $EDITOR");
  }
  return parts;
}

/**
 * Runs the editor with the file path appended, inheriting stdio so the
 * user interacts with it directly. No shell: the command is split on
 * whitespace only. A non-zero editor exit code is only a warning — the
 * file content after exit is what decides the outcome (some editors use
 * their exit code to report "closed without saving").
 */
function runEditor(parts: string[], file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = parts as [string, ...string[]];
    const child = spawn(command, [...args, file], { stdio: "inherit" });
    child.on("error", (error) => {
      reject(new Error(`failed to launch editor (${command}): ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== null && code !== 0) {
        console.error(`warning: editor exited with code ${code}; using the file as left on disk`);
      }
      resolve();
    });
  });
}

function printOutcome(outcome: Exclude<WriteOutcome, { status: "saved" }>): void {
  switch (outcome.status) {
    case "conflict":
      console.error(
        `conflict: the document changed on the server while you were editing ` +
          `(your edit was based on revision ${outcome.baseRevision}, latest is ${outcome.latestRevision}). ` +
          `Nothing was overwritten.`,
      );
      console.error("diff (base -> latest):");
      console.error(outcome.diff);
      return;
    case "rejected": {
      console.error(`edit rejected: ${outcome.reason}`);
      if (outcome.currentText !== undefined) {
        console.error(`current text: ${outcome.currentText}`);
      }
      if (outcome.matchCount !== undefined) {
        console.error(`matches: ${outcome.matchCount}`);
      }
      return;
    }
    case "preview":
      console.error(`edit not applied: ${outcome.description}`);
      console.error(outcome.diff);
      return;
  }
}

export async function edit(state: AgentState, argv: string[]): Promise<void> {
  const keep = argv.includes("--keep");
  const editorParts = resolveEditorCommand(argv);
  const vault = new AgentVault(state);

  const doc = await vault.readDocument();
  const dir = await mkdtemp(path.join(tmpdir(), "txt-agent-edit-"));
  await chmod(dir, 0o700);
  const file = path.join(dir, "txt-memo.txt");
  await writeFile(file, doc.text, { mode: 0o600 });
  await chmod(file, 0o600);

  let preserved = keep;
  let failed = false;
  try {
    await runEditor(editorParts, file);
    const editedText = await readFile(file, "utf8");
    if (editedText === doc.text) {
      console.log(`no changes; nothing saved (revision ${doc.revision})`);
      return;
    }
    const outcome = await vault.replaceWholeText(editedText);
    if (outcome.status === "saved") {
      console.log(`saved: revision ${outcome.revision}`);
      return;
    }
    preserved = true;
    failed = true;
    printOutcome(outcome);
    console.error(`your edited file was kept at: ${file}`);
    process.exitCode = 1;
  } catch (error) {
    preserved = true;
    failed = true;
    console.error(`edit failed; your edited file was kept at: ${file}`);
    throw error;
  } finally {
    if (!preserved) {
      await rm(dir, { recursive: true, force: true });
    } else if (keep && !failed) {
      console.log(`edited file kept at: ${file}`);
    }
  }
}
