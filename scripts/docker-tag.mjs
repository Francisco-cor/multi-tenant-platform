#!/usr/bin/env node
// Generates versioned image tags per commit (Fase 14: versioned artifacts reproducible)
// Usage: node scripts/docker-tag.mjs [--service api|web|worker] [--tag-only]
import { execSync } from 'node:child_process';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

const commit = process.env.GIT_COMMIT ?? sh('git rev-parse --short HEAD') ?? 'local';
const longCommit = process.env.GIT_COMMIT_LONG ?? sh('git rev-parse HEAD') ?? commit;
const branch = process.env.GIT_BRANCH ?? sh('git rev-parse --abbrev-ref HEAD') ?? 'local';
const date = process.env.BUILD_DATE ?? new Date().toISOString().slice(0, 10).replaceAll('-', '');
const version = `${date}-${commit}`;

const services = ['api', 'web', 'worker'];
const argvService = process.argv.find((a) => a.startsWith('--service='))?.split('=')[1];
const tagOnly = process.argv.includes('--tag-only');

const tags = {};
for (const svc of services) {
  if (argvService && argvService !== svc) continue;
  const base = `platform-${svc}`;
  tags[svc] = [
    `${base}:${version}`,
    `${base}:${commit}`,
    `${base}:latest`,
    `${base}:${branch}-${commit}`,
  ];
}

if (tagOnly) {
  const svc = argvService ?? 'api';
  const out = tags[svc] ?? tags.api;
  console.log(out.join('\n'));
  process.exit(0);
}

console.log(JSON.stringify({ commit, longCommit, branch, date, version, tags }, null, 2));
console.log(`\nBuild example:`);
for (const svc of Object.keys(tags)) {
  console.log(
    `  docker build -f apps/${svc}/Dockerfile --build-arg COMMIT_SHA=${longCommit} --build-arg BUILD_DATE=${date} -t ${tags[svc][0]} .`,
  );
}
