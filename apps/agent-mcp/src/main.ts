#!/usr/bin/env node
/**
 * txt-agent entrypoint: MCP server (default) + enrollment CLI.
 *
 *   txt-agent serve [--http]   MCP server (stdio unless --http)
 *   txt-agent enroll ...       see enroll.ts
 *   txt-agent activate ...     see enroll.ts
 *   txt-agent set-token ...    see enroll.ts
 *   txt-agent fingerprint      prints the local public key fingerprint
 */

import { AgentState } from "./config.ts";
import { activate, enroll, fingerprint, setToken } from "./enroll.ts";
import { serveHttp, serveStdio } from "./server.ts";

async function main(): Promise<void> {
  const [command = "serve", ...rest] = process.argv.slice(2);
  const state = new AgentState();
  switch (command) {
    case "serve":
      if (rest.includes("--http") || process.env.TXT_AGENT_MCP_HTTP === "1") {
        await serveHttp(state);
      } else {
        await serveStdio(state);
      }
      return;
    case "enroll":
      await enroll(state, rest);
      return;
    case "activate":
      await activate(state, rest);
      return;
    case "set-token":
      await setToken(state, rest);
      return;
    case "fingerprint":
      await fingerprint(state);
      return;
    default:
      console.error(`unknown command: ${command}`);
      console.error("usage: txt-agent <serve [--http] | enroll | activate | set-token | fingerprint>");
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
