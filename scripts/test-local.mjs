#!/usr/bin/env node
// Runs the integration suite against a local Supabase stack (Postgres +
// Auth + Realtime) launched via the Supabase CLI in Docker, instead of the
// real disposable cloud test project. Migrations and the Auth Hooks in
// supabase/config.toml are applied automatically by `supabase start`.
//
// Requires Docker Desktop running. Usage: npm run test:integration:local

import { spawnSync } from "node:child_process";

function run(args, opts = {}) {
  return spawnSync("npx", ["supabase", ...args], {
    stdio: opts.capture ? "pipe" : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

console.log("Starting local Supabase stack (Docker)...");
const start = run(["start"]);
if (start.status !== 0) {
  console.error(
    "\n`supabase start` failed. Is Docker Desktop installed and running?",
  );
  process.exit(start.status ?? 1);
}

const status = run(["status", "-o", "env"], { capture: true });
if (status.status !== 0) {
  console.error(status.stderr || "`supabase status` failed.");
  process.exit(status.status ?? 1);
}

const vars = {};
for (const line of status.stdout.split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (!match) continue;
  vars[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
}

const url = vars.API_URL;
const anonKey = vars.ANON_KEY;
const serviceRoleKey = vars.SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceRoleKey) {
  console.error(
    "Could not read API_URL / ANON_KEY / SERVICE_ROLE_KEY from `supabase status -o env`.\n" +
      "Raw output was:\n" + status.stdout,
  );
  process.exit(1);
}

console.log(`Running integration tests against local stack at ${url}...`);
const test = spawnSync("npx", ["vitest", "run", "tests/integration"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    SUPABASE_TEST_URL: url,
    SUPABASE_TEST_ANON_KEY: anonKey,
    SUPABASE_TEST_SERVICE_ROLE_KEY: serviceRoleKey,
  },
});

process.exit(test.status ?? 1);
