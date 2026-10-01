#!/usr/bin/env node
// Build the static (snapshot-mode) site against the frozen real-data fixture for e2e tests.
import { cpSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(web, "public", "snapshot");
rmSync(target, { recursive: true, force: true });
cpSync(join(web, "e2e", "fixtures", "snapshot"), target, { recursive: true });
execSync("npx vite build --outDir dist-e2e", {
  cwd: web,
  stdio: "inherit",
  env: { ...process.env, ATLAS_BASE: "./", ATLAS_SOURCEMAP: "0", VITE_ATLAS_STATIC: "1", MSYS_NO_PATHCONV: "1" },
});
