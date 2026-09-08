#!/usr/bin/env node
// build:migrations -- generate a numbered SQL migration from the canonical
// resolver-function sources under db/sql/functions/.
//
// Why this exists: Postgres can't patch a function body, so every change to a
// resolver function is a full `create or replace function` re-emit. Hand-writing
// those as migrations meant a one-line behaviour change landed as a 2,000-line
// migration diff. Here the canonical source is db/sql/functions/<name>.sql and
// the migration is generated output -- see db/sql/README.md and issue #350.
//
// Model:
//   - db/sql/functions/<name>.sql   canonical body + revoke/grant + comment on,
//                                   as one unit. Edited by humans.
//   - db/sql/.emitted/<name>.sql    a byte copy of what last went into a
//                                   migration. Committed. The build's change
//                                   detector diffs canonical against this.
//   - supabase/migrations/<NNNN>_generated_resolver_functions.sql
//                                   the accumulating generated migration. While
//                                   it is unmerged (not present on the base
//                                   ref) the build keeps rewriting/renumbering
//                                   it; once merged it freezes and the next
//                                   change starts a fresh one.
//
// `npm run build:migrations`  -- regenerate.
// `npm run verify:migrations` -- regenerate then `git diff --exit-code`; a
//                                non-zero exit means a generated file was
//                                hand-edited or someone forgot to build.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO, 'db', 'sql', 'functions');
const EMITTED_DIR = path.join(REPO, 'db', 'sql', '.emitted');
const MIGRATIONS_DIR = path.join(REPO, 'supabase', 'migrations');
const GENERATED_SUFFIX = '_generated_resolver_functions.sql';
const BEGIN_MARKER = (name) => `-- BEGIN db/sql/functions/${name}.sql`;
const END_MARKER = (name) => `-- END db/sql/functions/${name}.sql`;

const norm = (s) => s.replace(/\r\n/g, '\n');
const read = (p) => norm(fs.readFileSync(p, 'utf8'));

function listFunctionNames() {
  if (!fs.existsSync(SRC_DIR)) return [];
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, -4))
    .sort();
}

function migrationNumber(filename) {
  const m = /^(\d+)_/.exec(filename);
  return m ? parseInt(m[1], 10) : null;
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => migrationNumber(f) !== null)
    .sort();
}

// A generated migration is "pending" (ours to keep rewriting) while it is not
// yet on the base ref. Prefer origin/master, fall back to master.
function baseRef() {
  for (const ref of ['origin/master', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
        cwd: REPO,
        stdio: 'ignore',
      });
      return ref;
    } catch {
      /* try next */
    }
  }
  return null;
}

function existsOnRef(ref, relPath) {
  if (!ref) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${relPath}`], {
      cwd: REPO,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function pendingGeneratedMigration(ref) {
  const generated = listMigrations().filter((f) => f.endsWith(GENERATED_SUFFIX));
  const pending = generated.filter(
    (f) => !existsOnRef(ref, `supabase/migrations/${f}`),
  );
  if (pending.length > 1) {
    throw new Error(
      `Multiple unmerged generated migrations: ${pending.join(', ')}. ` +
        `Expected at most one -- resolve by hand.`,
    );
  }
  return pending[0] ?? null;
}

// Which function bodies does an existing generated migration already carry?
function functionsInMigration(filename) {
  const text = read(path.join(MIGRATIONS_DIR, filename));
  const names = [];
  for (const line of text.split('\n')) {
    const m = /^-- BEGIN db\/sql\/functions\/(.+)\.sql$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

function renderMigration(names) {
  const header = [
    '-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT',
    '--',
    '-- Written by `npm run build:migrations` from the canonical resolver-function',
    '-- sources under db/sql/functions/. To change any function below, edit its',
    '-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.',
    '--',
    '-- Functions in this migration:',
    ...names.map((n) => `--   ${n}`),
    '',
    '',
  ].join('\n');

  const blocks = names.map((name) => {
    const body = read(path.join(SRC_DIR, `${name}.sql`)).replace(/\n+$/, '\n');
    return [BEGIN_MARKER(name), body.replace(/\n$/, ''), END_MARKER(name), ''].join(
      '\n',
    );
  });

  return header + blocks.join('\n') + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  const label = check ? 'verify:migrations' : 'build:migrations';
  if (!check) fs.mkdirSync(EMITTED_DIR, { recursive: true });

  const names = listFunctionNames();
  if (names.length === 0) {
    console.log(`${label}: no canonical functions under db/sql/functions/, nothing to do.`);
    return;
  }

  const changed = names.filter((name) => {
    const emittedPath = path.join(EMITTED_DIR, `${name}.sql`);
    if (!fs.existsSync(emittedPath)) return true;
    return read(path.join(SRC_DIR, `${name}.sql`)) !== read(emittedPath);
  });

  const ref = baseRef();
  const pending = pendingGeneratedMigration(ref);

  if (changed.length === 0 && !pending) {
    console.log(`${label}: canonical sources match .emitted/, no pending migration. Nothing to do.`);
    return;
  }

  // Functions to emit = whatever the pending migration already carries, plus
  // anything that changed since its last emit.
  const carried = pending ? functionsInMigration(pending) : [];
  const toEmit = [...new Set([...carried, ...changed])].sort();

  // Claim (highest existing migration number) + 1, ignoring our own pending
  // file so a rebase renumbers it above whatever landed in the meantime.
  const highest = listMigrations()
    .filter((f) => f !== pending)
    .reduce((max, f) => Math.max(max, migrationNumber(f)), 0);
  const nextNum = String(highest + 1).padStart(4, '0');
  const targetFile = `${nextNum}${GENERATED_SUFFIX}`;

  const rendered = renderMigration(toEmit);
  const targetPath = path.join(MIGRATIONS_DIR, targetFile);

  if (check) {
    // Report, without writing, every way the tree is out of sync with what the
    // canonical sources say the generated migration should be. Non-zero exit is
    // the pre-merge gate: a hand-edited generated file, or a skipped build.
    const problems = [];
    if (pending && pending !== targetFile) {
      problems.push(
        `${pending} needs renumbering to ${targetFile} (a later migration took its number).`,
      );
    }
    if (!fs.existsSync(targetPath)) {
      problems.push(`${targetFile} is missing — run \`npm run build:migrations\`.`);
    } else if (read(targetPath) !== norm(rendered)) {
      problems.push(
        `${targetFile} does not match db/sql/functions/ — it was hand-edited, or a canonical source changed without a rebuild.`,
      );
    }
    for (const name of toEmit) {
      const emittedPath = path.join(EMITTED_DIR, `${name}.sql`);
      if (!fs.existsSync(emittedPath) || read(emittedPath) !== read(path.join(SRC_DIR, `${name}.sql`))) {
        problems.push(`db/sql/.emitted/${name}.sql is stale — run \`npm run build:migrations\`.`);
      }
    }
    if (problems.length === 0) {
      console.log(`${label}: generated migration is in sync with db/sql/functions/.`);
      return;
    }
    console.error(`${label}: FAILED\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }

  if (pending && pending !== targetFile) {
    fs.rmSync(path.join(MIGRATIONS_DIR, pending));
    console.log(`build:migrations: renumbered ${pending} -> ${targetFile}`);
  }
  fs.writeFileSync(targetPath, rendered);

  for (const name of toEmit) {
    fs.copyFileSync(
      path.join(SRC_DIR, `${name}.sql`),
      path.join(EMITTED_DIR, `${name}.sql`),
    );
  }

  console.log(
    `build:migrations: wrote supabase/migrations/${targetFile} (${toEmit.join(', ')}).`,
  );
}

main();
