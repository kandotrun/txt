/**
 * Agent MCP write tests (design §8.4, §9; phase 2 acceptance):
 * append / replace / search-replace / rollback against the stateful stub
 * Worker in stub-worker.ts, which implements the real CAS contract.
 * Model operations are also unit-tested directly. No plaintext, key or
 * token is logged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { plainTextForCopy } from "../../packages/protocol/src/document.ts";
import type { DocumentModel } from "../../packages/protocol/src/document.ts";
import { AgentState, FileSecretStore } from "../../apps/agent-mcp/src/config.ts";
import {
  AgentVault,
  appendToModel,
  diffTexts,
  replaceBlockInModel,
  searchReplaceInModel,
} from "../../apps/agent-mcp/src/vault.ts";
import {
  AGENT_ID,
  FIRST_TEXT_ID,
  MEDIA_BLOCK_ID,
  MEDIA_ID,
  TAIL_TEXT_ID,
  TOKEN,
  StubWorker,
  mediaModel,
  textOnlyModel,
} from "./stub-worker.ts";

interface Fixture {
  vault: AgentVault;
  state: AgentState;
  stub: StubWorker;
  dir: string;
}

const fixtures: Fixture[] = [];

async function setup(model: DocumentModel): Promise<Fixture> {
  const stub = new StubWorker();
  const apiBase = await stub.start(model);
  const dir = mkdtempSync(path.join(tmpdir(), "txt-agent-write-test-"));
  const state = new AgentState(new FileSecretStore(dir));
  state.saveConfig({ apiBase, agentId: AGENT_ID, displayName: "Test Agent" });
  state.saveKeyPair({ privateKeyJwk: stub.privateKeyJwk, publicKey: stub.publicKeyB64 });
  state.saveToken({ token: TOKEN, tokenId: "token-1", expiresAt: Date.now() + 60_000 });
  const fixture = { vault: new AgentVault(state), state, stub, dir };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop() as Fixture;
    await fixture.stub.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Pure model operations                                               */
/* ------------------------------------------------------------------ */

describe("document model write operations", () => {
  it("append adds to the trailing text block and keeps every block ID", () => {
    const model = mediaModel();
    const next = appendToModel(model, " more");
    expect(next.blocks.map((block) => block.id)).toEqual([
      FIRST_TEXT_ID,
      MEDIA_BLOCK_ID,
      TAIL_TEXT_ID,
    ]);
    expect(next.blocks[2]).toMatchObject({ type: "text", text: "after more" });
    // The input model is not mutated.
    expect(model.blocks[2]).toMatchObject({ text: "after" });
  });

  it("append after trailing media inserts a fresh text block (design §9.1)", () => {
    const model: DocumentModel = {
      schemaVersion: 1,
      blocks: [
        { id: FIRST_TEXT_ID, type: "text", text: "head" },
        { id: MEDIA_BLOCK_ID, type: "media", mediaId: MEDIA_ID },
      ],
      media: mediaModel().media,
    };
    const next = appendToModel(model, "tail text");
    expect(next.blocks).toHaveLength(3);
    expect(next.blocks[0]?.id).toBe(FIRST_TEXT_ID);
    expect(next.blocks[1]?.id).toBe(MEDIA_BLOCK_ID);
    const added = next.blocks[2];
    expect(added?.type).toBe("text");
    expect(added && added.type === "text" ? added.text : null).toBe("tail text");
    expect(added?.id).not.toBe(MEDIA_BLOCK_ID);
  });

  it("replace requires an exact expected_text match", () => {
    const model = textOnlyModel("hello world");
    const mismatch = replaceBlockInModel(model, FIRST_TEXT_ID, "hello", "bye");
    expect("reason" in mismatch).toBe(true);
    if ("reason" in mismatch) expect(mismatch.currentText).toBe("hello world");
    const matched = replaceBlockInModel(model, FIRST_TEXT_ID, "hello world", "bye");
    expect("model" in matched).toBe(true);
    if ("model" in matched) {
      expect(matched.model.blocks[0]).toMatchObject({ id: FIRST_TEXT_ID, text: "bye" });
    }
  });

  it("search & replace counts occurrences across text blocks", () => {
    const model: DocumentModel = {
      schemaVersion: 1,
      blocks: [
        { id: FIRST_TEXT_ID, type: "text", text: "alpha beta" },
        { id: TAIL_TEXT_ID, type: "text", text: "gamma alpha" },
      ],
      media: {},
    };
    const multiple = searchReplaceInModel(model, "alpha", "ALPHA");
    expect("matchCount" in multiple && multiple.matchCount).toBe(2);
    const none = searchReplaceInModel(model, "delta", "x");
    expect("matchCount" in none && none.matchCount).toBe(0);
    const once = searchReplaceInModel(model, "beta", "BETA");
    expect("model" in once).toBe(true);
    if ("model" in once) {
      expect(plainTextForCopy(once.model)).toBe("alpha BETAgamma alpha");
    }
  });

  it("diff renders added and removed lines", () => {
    const diff = diffTexts("one\ntwo\n", "one\nthree\n");
    expect(diff).toContain("- two");
    expect(diff).toContain("+ three");
    expect(diffTexts("same", "same")).toBe("(no differences)");
  });
});

/* ------------------------------------------------------------------ */
/* Vault writes against the stub Worker                                */
/* ------------------------------------------------------------------ */

describe("agent MCP vault writes", () => {
  it("append round-trips: read returns base + appended text, IDs preserved", async () => {
    const { vault, stub } = await setup(mediaModel());
    const outcome = await vault.appendText(" and more");
    expect(outcome.status).toBe("saved");
    if (outcome.status === "saved") expect(outcome.revision).toBe(1);
    expect(await stub.currentText()).toBe("before\n[画像: photo.jpg]after and more");
    const model = await stub.currentModel();
    expect(model.blocks.map((block) => block.id)).toEqual([
      FIRST_TEXT_ID,
      MEDIA_BLOCK_ID,
      TAIL_TEXT_ID,
    ]);
    expect(Object.keys(model.media)).toEqual([MEDIA_ID]);
    const read = await vault.readDocument();
    expect(read.text).toBe("before\n[画像: photo.jpg]after and more");
  });

  it("backs up the pre-write ciphertext before saving", async () => {
    const { vault, state, stub } = await setup(textOnlyModel("original"));
    const before = { ...stub.record };
    await vault.appendText(" +v2");
    const backups = state.loadCiphertextBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]?.revision).toBe(0);
    expect(backups[0]?.ciphertext).toBe(before.ciphertext);
    expect(backups[0]?.nonce).toBe(before.nonce);
    expect(backups[0]?.mutationId).toBe(before.mutationId);
    // Backups hold ciphertext only: no plaintext anywhere in the record.
    expect(JSON.stringify(backups)).not.toContain("original");
  });

  it("replace without confirm returns a preview and writes nothing", async () => {
    const { vault, state, stub } = await setup(textOnlyModel("draft text"));
    const outcome = await vault.replaceBlock({
      blockId: FIRST_TEXT_ID,
      expectedText: "draft text",
      newText: "final text",
    });
    expect(outcome.status).toBe("preview");
    if (outcome.status === "preview") {
      expect(outcome.diff).toContain("- draft text");
      expect(outcome.diff).toContain("+ final text");
    }
    expect(stub.record.revision).toBe(0);
    expect(stub.putAttempts).toBe(0);
    expect(state.loadCiphertextBackups()).toHaveLength(0);
  });

  it("replace with confirm and a stale expected_text is refused with the current text", async () => {
    const { vault, stub } = await setup(textOnlyModel("actual text"));
    const outcome = await vault.replaceBlock({
      blockId: FIRST_TEXT_ID,
      expectedText: "assumed text",
      newText: "replacement",
      confirm: true,
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.currentText).toBe("actual text");
    expect(stub.record.revision).toBe(0);
    expect(await stub.currentText()).toBe("actual text");
  });

  it("replace with confirm and an exact match saves", async () => {
    const { vault, stub } = await setup(textOnlyModel("old block"));
    const outcome = await vault.replaceBlock({
      blockId: FIRST_TEXT_ID,
      expectedText: "old block",
      newText: "new block",
      confirm: true,
    });
    expect(outcome.status).toBe("saved");
    expect(await stub.currentText()).toBe("new block");
  });

  it("search_replace refuses multiple matches and zero matches without writing", async () => {
    const { vault, stub } = await setup(textOnlyModel("alpha beta alpha"));
    const multiple = await vault.searchReplace({ find: "alpha", replacement: "x", confirm: true });
    expect(multiple.status).toBe("rejected");
    if (multiple.status === "rejected") expect(multiple.matchCount).toBe(2);
    const none = await vault.searchReplace({ find: "delta", replacement: "x", confirm: true });
    expect(none.status).toBe("rejected");
    if (none.status === "rejected") expect(none.matchCount).toBe(0);
    expect(stub.record.revision).toBe(0);
    expect(stub.putAttempts).toBe(0);
    const once = await vault.searchReplace({ find: "beta", replacement: "BETA", confirm: true });
    expect(once.status).toBe("saved");
    expect(await stub.currentText()).toBe("alpha BETA alpha");
  });

  it("on a 412 conflict it does not retry or overwrite, and returns the diff", async () => {
    const { vault, stub } = await setup(textOnlyModel("base text"));
    stub.hijackNextPutWith(textOnlyModel("browser edit"));
    const outcome = await vault.appendText(" agent append");
    expect(outcome.status).toBe("conflict");
    if (outcome.status === "conflict") {
      expect(outcome.baseRevision).toBe(0);
      expect(outcome.latestRevision).toBe(1);
      expect(outcome.diff).toContain("+ browser edit");
      expect(outcome.latestText).toBe("browser edit");
    }
    // Exactly one PUT was attempted, and the concurrent edit survived.
    expect(stub.putAttempts).toBe(1);
    expect(await stub.currentText()).toBe("browser edit");
  });

  it("a lost PUT response resolves by mutationId instead of duplicating the write", async () => {
    const { vault, stub } = await setup(textOnlyModel("base"));
    stub.dropResponseOfNextPut();
    const outcome = await vault.appendText(" +once");
    expect(outcome.status).toBe("saved");
    if (outcome.status === "saved") expect(outcome.revision).toBe(1);
    expect(stub.putAttempts).toBe(1);
    expect(await stub.currentText()).toBe("base +once");
  });

  it("rollback restores the pre-write ciphertext and is itself undoable", async () => {
    const { vault, stub } = await setup(textOnlyModel("version one"));
    await vault.appendText(" plus two");
    expect(await stub.currentText()).toBe("version one plus two");

    const preview = await vault.rollback();
    expect(preview.status).toBe("preview");
    expect(await stub.currentText()).toBe("version one plus two");

    const rolled = await vault.rollback({ confirm: true });
    expect(rolled.status).toBe("saved");
    if (rolled.status === "saved") expect(rolled.revision).toBe(2);
    expect(await stub.currentText()).toBe("version one");

    // The rollback saved a backup of what it replaced, so it can be undone.
    const undone = await vault.rollback({ confirm: true });
    expect(undone.status).toBe("saved");
    expect(await stub.currentText()).toBe("version one plus two");
  });

  it("rollback without any backup is a rejection, not an error", async () => {
    const { vault } = await setup(textOnlyModel("nothing yet"));
    const outcome = await vault.rollback({ confirm: true });
    expect(outcome.status).toBe("rejected");
  });

  it("backup generations are capped at 20", async () => {
    const { vault, state } = await setup(textOnlyModel("x"));
    for (let i = 0; i < 22; i++) {
      const outcome = await vault.appendText(".");
      expect(outcome.status).toBe("saved");
    }
    expect(state.loadCiphertextBackups()).toHaveLength(20);
    const read = await vault.readDocument();
    expect(read.revision).toBe(22);
  });
});
