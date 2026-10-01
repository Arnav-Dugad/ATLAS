#!/usr/bin/env node
// Run the engine (API + ingestion) and the web client together. Ctrl+C stops both.
import { ENGINE, WEB, cyan, dim, ensureVenv, isWin, spawnChild, venvBin } from "./lib.mjs";

ensureVenv();
const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
const children = [
  spawnChild(venvBin("atlas"), ["serve", ...process.argv.slice(2)], { cwd: ENGINE, env }),
  spawnChild(isWin ? "pnpm.cmd" : "pnpm", ["dev"], { cwd: WEB, env, shell: isWin }),
];
console.log(`${cyan("◆")} ATLAS engine → http://127.0.0.1:8787   web → http://localhost:5173 ${dim("(Ctrl+C to stop)")}`);

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (!c.killed) c.kill(isWin ? undefined : "SIGINT");
  }
  setTimeout(() => process.exit(code), 800);
};
for (const c of children) c.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
