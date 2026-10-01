#!/usr/bin/env node
// One-command setup: Python env + engine deps, web deps, DuckDB extensions, Core Pack.
import { existsSync } from "node:fs";
import { ENGINE, ROOT, VENV, bold, dim, ensureVenv, findPython, green, red, run, step, venvBin, yellow } from "./lib.mjs";

const t0 = Date.now();
try {
  step("Checking prerequisites");
  const py = findPython();
  if (!py) throw new Error("Python 3.11+ is required (https://www.python.org/downloads/).");
  console.log(dim(`  ${py.version} · Node ${process.version}`));

  if (!existsSync(venvBin("python"))) {
    step("Creating Python virtual environment");
    run(py.cmd, [...py.pre, "-m", "venv", VENV]);
  }
  ensureVenv();

  step("Installing engine dependencies");
  run(venvBin("python"), ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
  run(venvBin("python"), ["-m", "pip", "install", "--quiet", "-e", `${ENGINE}[dev]`]);

  step("Installing web dependencies");
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install"], { cwd: ROOT, shell: process.platform === "win32" });

  step("Preparing ATLAS data (DuckDB extensions + Core Pack ~11 MB)");
  run(venvBin("atlas"), ["setup"], { cwd: ENGINE });

  console.log(`\n${green("✓")} ${bold("ATLAS is ready")} ${dim(`in ${((Date.now() - t0) / 1000).toFixed(0)} s`)}`);
  console.log(`  Start everything with ${bold("pnpm dev")} and open ${bold("http://localhost:5173")}`);
  console.log(dim("  Optional: `pnpm engine packs install population-ghsl` (~484 MB) for population exposure."));
} catch (err) {
  console.error(`\n${red("✗")} Setup failed: ${err.message}`);
  console.error(yellow("  See docs/TROUBLESHOOTING.md"));
  process.exit(1);
}
