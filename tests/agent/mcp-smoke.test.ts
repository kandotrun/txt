/**
 * MCP stdio smoke test (phase 2): builds the real agent-mcp bundle and
 * drives it as a subprocess over stdio JSON-RPC against the stub Worker —
 * initialize, tools/list, txt_append → txt_read round trip,
 * approval-gated txt_replace preview, confirmed txt_search_replace.
 */

import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentState, FileSecretStore } from "../../apps/agent-mcp/src/config.ts";
import { AGENT_ID, FIRST_TEXT_ID, StubWorker, TOKEN, textOnlyModel } from "./stub-worker.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../..");

interface JsonRpcResponse {
  id?: number;
  result?: {
    serverInfo?: { name: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

class McpStdioClient {
  private buffer = "";
  private pending = new Map<number, (response: JsonRpcResponse) => void>();
  private nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id !== undefined) {
            this.pending.get(parsed.id)?.(parsed);
            this.pending.delete(parsed.id);
          }
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const promise = new Promise<JsonRpcResponse>((resolve) => this.pending.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (!this.child.killed) this.child.kill();
  }
}

let stub: StubWorker;
let dir: string;
let client: McpStdioClient;
let child: ChildProcessWithoutNullStreams;

beforeAll(async () => {
  await execFileAsync("node", ["apps/agent-mcp/build.mjs"], { cwd: REPO_ROOT });

  stub = new StubWorker();
  const apiBase = await stub.start(textOnlyModel("smoke base"));
  dir = mkdtempSync(path.join(tmpdir(), "txt-agent-smoke-"));
  const state = new AgentState(new FileSecretStore(dir));
  state.saveConfig({ apiBase, agentId: AGENT_ID, displayName: "Test Agent" });
  state.saveKeyPair({ privateKeyJwk: stub.privateKeyJwk, publicKey: stub.publicKeyB64 });
  state.saveToken({ token: TOKEN, tokenId: "token-1", expiresAt: Date.now() + 60_000 });

  child = spawn("node", ["apps/agent-mcp/dist/txt-agent.mjs", "serve"], {
    cwd: REPO_ROOT,
    env: { ...process.env, TXT_AGENT_HOME: dir },
  }) as ChildProcessWithoutNullStreams;
  client = new McpStdioClient(child);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await stub?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("agent MCP stdio smoke (phase 2)", () => {
  it("initializes, lists the write tools, and round-trips append -> read", async () => {
    const init = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    expect(init.result?.serverInfo?.name).toBe("txt-agent");
    client.notify("notifications/initialized");

    const list = await client.request("tools/list", {});
    const names = (list.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "txt_status",
        "txt_read",
        "txt_append",
        "txt_replace",
        "txt_search_replace",
        "txt_rollback",
      ]),
    );

    const appended = await client.request("tools/call", {
      name: "txt_append",
      arguments: { text: " via mcp" },
    });
    const appendedText = appended.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(appendedText)).toMatchObject({ status: "saved", revision: 1 });

    const read = await client.request("tools/call", { name: "txt_read", arguments: {} });
    expect(read.result?.content?.[0]?.text).toBe("smoke base via mcp");
    expect(await stub.currentText()).toBe("smoke base via mcp");
  }, 30_000);

  it("gates txt_replace behind confirm and applies a confirmed search_replace", async () => {
    const preview = await client.request("tools/call", {
      name: "txt_replace",
      arguments: {
        block_id: FIRST_TEXT_ID,
        expected_text: "smoke base via mcp",
        new_text: "changed",
      },
    });
    const previewText = preview.result?.content?.[0]?.text ?? "";
    expect(previewText).toContain("nothing was written");
    expect(await stub.currentText()).toBe("smoke base via mcp");

    const replaced = await client.request("tools/call", {
      name: "txt_search_replace",
      arguments: { find: "via mcp", replacement: "via MCP", confirm: true },
    });
    const replacedText = replaced.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(replacedText)).toMatchObject({ status: "saved", revision: 2 });
    expect(await stub.currentText()).toBe("smoke base via MCP");
  }, 30_000);
});
