#!/usr/bin/env node
// Thin cross-platform wrapper around the engine's virtualenv.
//   node scripts/engine.mjs serve | test | lint | <any atlas CLI args>
import { ENGINE, ensureVenv, run, venvBin } from "./lib.mjs";

const [cmd = "serve", ...rest] = process.argv.slice(2);
ensureVenv();
const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

if (cmd === "test") {
  run(venvBin("python"), ["-m", "pytest", "-q", ...rest], { cwd: ENGINE, env });
} else if (cmd === "lint") {
  run(venvBin("ruff"), ["check", "src", "tests"], { cwd: ENGINE, env });
  run(venvBin("ruff"), ["format", "--check", "src", "tests"], { cwd: ENGINE, env });
} else {
  run(venvBin("atlas"), [cmd, ...rest], { cwd: ENGINE, env });
}
