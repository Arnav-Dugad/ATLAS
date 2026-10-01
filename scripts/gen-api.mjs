#!/usr/bin/env node
// Generate TypeScript types for the web client from the engine's OpenAPI schema.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE, WEB, ensureVenv, isWin, run, step, tryRun, venvBin } from "./lib.mjs";

ensureVenv();
step("Exporting OpenAPI schema from the engine");
const schema = tryRun(
  venvBin("python"),
  ["-c", "import json; from atlas.api.app import create_app; print(json.dumps(create_app().openapi()))"],
  { cwd: ENGINE, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 32 * 1024 * 1024 },
);
if (!schema) throw new Error("could not export OpenAPI schema");
const out = join(WEB, "src", "lib");
mkdirSync(out, { recursive: true });
const schemaPath = join(out, "openapi.json");
writeFileSync(schemaPath, schema);

step("Generating src/lib/api-types.ts");
run(isWin ? "pnpm.cmd" : "pnpm", ["exec", "openapi-typescript", schemaPath, "-o", join(out, "api-types.ts")], {
  cwd: WEB,
  shell: isWin,
});
