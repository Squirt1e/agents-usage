#!/usr/bin/env node
// Baseline verification for the desktop migration.
//
// Runs the shared contract conformance suites on both runtimes plus a fixture
// sanity pass, and prints one line per check. The legacy web entry points have
// their own script (`npm run verify:legacy`, or `--with-legacy` here) because
// they are slower and are also run when the shared client code changes.
//
// Usage:
//   node scripts/verify-baseline.mjs [--with-legacy] [--no-rust]
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(repoRoot, 'fixtures', 'contracts');

const args = new Set(process.argv.slice(2));
const withLegacy = args.has('--with-legacy');
const withRust = !args.has('--no-rust');

function run(label, command, commandArgs) {
  process.stdout.write(`\n== ${label} ==\n`);
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${label}`);
    process.exit(result.status ?? 1);
  }
}

// Fixture sanity: every fixture must be parseable JSON, carry an id, and keep
// the "missing is not zero" distinction explicit wherever a value is involved.
function checkFixtures() {
  process.stdout.write('\n== contract fixture sanity ==\n');
  const files = readdirSync(fixtureDir).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('no contract fixtures found');

  for (const file of files) {
    const raw = readFileSync(join(fixtureDir, file), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.id !== 'string' || !parsed.id) throw new Error(`${file} has no id`);
    const serialized = JSON.stringify(parsed);
    if (/sk-[A-Za-z0-9]|not-a-real-key|not-a-real-token|not-a-real-session/.test(serialized) && parsed.id !== 'redaction') {
      throw new Error(`${file} contains values reserved for the redaction fixture`);
    }
    if (parsed.id === 'redaction') continue;
    if (/"(value|total_balance|granted_balance|balance)":\s*undefined/.test(raw)) {
      throw new Error(`${file} uses undefined instead of null for a missing value`);
    }
    printf(`fixture ok: ${file}`);
  }
}

function printf(line) {
  process.stdout.write(`${line}\n`);
}

checkFixtures();
run('typescript contract conformance', 'npx', ['vitest', 'run', 'tests/contracts-conformance.test.ts']);
if (withRust) run('rust workspace tests', 'bash', ['tools/cargo.sh', 'test', '--workspace']);
if (withLegacy) run('legacy web baseline', 'bash', ['scripts/verify-legacy-web.sh']);

process.stdout.write('\nbaseline verified\n');
