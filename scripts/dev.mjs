#!/usr/bin/env node
// Root dev wrapper: load .env (Node >=24 process.loadEnvFile) before Turbo
// spawns app dev scripts. App scripts cannot load it themselves yet, so the
// wrapper is the supported path: `pnpm dev` -> `node scripts/dev.mjs`.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.ENV_FILE ?? resolve(root, '.env');
const exampleFile = resolve(root, '.env.example');

export function loadEnv(file = envFile, fallback = exampleFile) {
  const loaded = [];
  const target = existsSync(file) ? file : existsSync(fallback) ? fallback : null;
  if (!target) return loaded;
  // process.loadEnvFile does not override existing variables, which keeps
  // `DATABASE_URL=... pnpm dev` and CI overrides authoritative.
  process.loadEnvFile(target);
  loaded.push(target);
  return loaded;
}

function main() {
  const loaded = loadEnv();
  if (loaded.length === 0) {
    console.warn('[dev] no .env or .env.example found; relying on the ambient environment');
  } else {
    console.log(`[dev] loaded ${loaded[0]}`);
    if (loaded[0].endsWith('.env.example')) {
      console.warn('[dev] using .env.example defaults; copy it to .env for local secrets');
    }
  }
  const child = spawn('turbo', ['run', 'dev', '--parallel', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
