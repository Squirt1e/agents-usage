#!/usr/bin/env node

import { renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [sourceArgument, version] = process.argv.slice(2);

if (!sourceArgument || !version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法：prepare-release-dmg.mjs <source.dmg> <major.minor.patch>');
  process.exit(2);
}

const source = resolve(sourceArgument);
const asset = join(dirname(source), `Agents-Usage_v${version}-macos.dmg`);
renameSync(source, asset);
process.stdout.write(`${asset}\n`);
