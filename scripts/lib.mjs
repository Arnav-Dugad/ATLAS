// Shared helpers for ATLAS developer scripts (Windows, macOS, Linux).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE = join(ROOT, "services", "engine");
export const WEB = join(ROOT, "apps", "web");
export const isWin = process.platform === "win32";
export const VENV = join(ENGINE, ".venv");
export const venvBin = (name) => join(VENV, isWin ? "Scripts" : "bin", isWin ? `${name}.exe` : name);

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = c("2");
export const bold = c("1");
export const cyan = c("36");
export const green = c("32");
export const red = c("31");
export const yellow = c("33");

export function step(msg) {
  console.log(`${cyan("◆")} ${bold(msg)}`);
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${res.status}`);
  }
  return res;
}

export function tryRun(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
  return res.status === 0 ? (res.stdout || "").trim() : null;
}

export function findPython() {
  const candidates = isWin ? ["py", "python", "python3"] : ["python3", "python"];
  for (const cand of candidates) {
    const args = cand === "py" ? ["-3", "--version"] : ["--version"];
    const out = tryRun(cand, args);
    if (!out) continue;
    const m = /Python (\d+)\.(\d+)/.exec(out);
    if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 11))) {
      return cand === "py" ? { cmd: "py", pre: ["-3"], version: out } : { cmd: cand, pre: [], version: out };
    }
  }
  return null;
}

export function ensureVenv() {
  if (!existsSync(venvBin("python"))) {
    throw new Error("Python environment missing. Run `pnpm setup` first.");
  }
}

export function spawnChild(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
}
