#!/usr/bin/env node
// Compile workspace packages to plain JS and rewrite their package.json exports
// so production images can run `node dist/main.js` without tsx.
//
// This runs inside the Docker build stage, against a throwaway copy of the
// workspace. It never writes to the host checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function rewriteExports(manifest) {
  const next = structuredClone(manifest);
  if (typeof next.main === 'string' && next.main.endsWith('.ts')) {
    next.main = next.main.replace(/^\.\/src\//u, './dist/').replace(/\.ts$/u, '.js');
  }
  if (next.exports && typeof next.exports === 'object') {
    next.exports = Object.fromEntries(
      Object.entries(next.exports).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value.replace(/^\.\/src\//u, './dist/').replace(/\.ts$/u, '.js')
          : value,
      ]),
    );
  }
  return next;
}

function packageDirs() {
  const dirs = [];
  for (const group of ['packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(groupDir, entry.name);
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'tsconfig.json'))) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

export function compilePackages({ exclude = [] } = {}) {
  const compiled = [];
  for (const dir of packageDirs()) {
    const manifestPath = join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (exclude.includes(manifest.name)) continue;
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsc',
        '-p',
        join(dir, 'tsconfig.json'),
        '--noEmit',
        'false',
        '--outDir',
        join(dir, 'dist'),
        '--declaration',
        'false',
        '--declarationMap',
        'false',
        '--sourceMap',
        'false',
        '--incremental',
        'false',
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (!existsSync(join(dir, 'dist', 'index.js'))) {
      throw new Error(`compile_missing_entry:${manifest.name}:dist/index.js`);
    }
    writeFileSync(manifestPath, `${JSON.stringify(rewriteExports(manifest), null, 2)}\n`);
    compiled.push(manifest.name);
  }
  return compiled;
}

export function deployApp(filter, target) {
  execFileSync('pnpm', ['--filter', filter, 'deploy', '--prod', '--legacy', target], {
    cwd: root,
    stdio: 'inherit',
  });
  return target;
}

function main() {
  const args = process.argv.slice(2);
  const filterIndex = args.indexOf('--filter');
  if (filterIndex === -1 || !args[filterIndex + 1]) {
    console.error('usage: node scripts/build-runtime.mjs --filter @platform/api --target /out');
    process.exit(2);
  }
  const targetIndex = args.indexOf('--target');
  const target = targetIndex === -1 ? '/out' : args[targetIndex + 1];
  const compiled = compilePackages({ exclude: ['@platform/testing'] });
  console.log(`[build-runtime] compiled ${compiled.join(', ')}`);
  deployApp(args[filterIndex + 1], target);
  console.log(`[build-runtime] deployed ${args[filterIndex + 1]} -> ${target}`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
