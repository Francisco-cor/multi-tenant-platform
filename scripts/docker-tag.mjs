#!/usr/bin/env node
// Generates versioned image tags per commit (Fase 14: versioned artifacts reproducible).
// Usage: node scripts/docker-tag.mjs [--service api|web|worker] [--tag-only]
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICES = ['api', 'web', 'worker'];

const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const NAME_RE = /^[a-z0-9]+(?:(?:[._-]|__)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._-]|__)[a-z0-9]+)*)*$/u;
const COMMIT_RE = /^[a-f0-9]{7,40}$/u;

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/** Docker tags allow [A-Za-z0-9_.-]; branch names may contain slashes and uppercase. */
export function sanitizeTagComponent(value, fallback = 'unknown') {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[.-]+/u, '')
    .replace(/[.-]+$/u, '')
    .slice(0, 100);
  return cleaned || fallback;
}

export function validateTag(tag) {
  const separator = String(tag).lastIndexOf(':');
  const name = separator === -1 ? '' : String(tag).slice(0, separator);
  const version = separator === -1 ? '' : String(tag).slice(separator + 1);
  if (!NAME_RE.test(name) || !TAG_RE.test(version)) throw new Error(`invalid_docker_tag:${tag}`);
  return tag;
}

export function buildTags({ service, commit, date, branch = 'local', includeLatest = true }) {
  if (!SERVICES.includes(service)) throw new Error(`invalid_service:${service}`);
  const short = sanitizeTagComponent(commit, 'local').slice(0, 40);
  if (commit !== 'local' && !COMMIT_RE.test(String(commit).toLowerCase())) {
    throw new Error(`invalid_commit:${commit}`);
  }
  const buildDate = String(date ?? '').replaceAll('-', '');
  if (!/^\d{8}$/u.test(buildDate)) throw new Error(`invalid_build_date:${date}`);
  const safeBranch = sanitizeTagComponent(branch, 'local');
  const base = `platform-${service}`;
  const candidates = [
    `${base}:${buildDate}-${short}`,
    `${base}:${short}`,
    `${base}:${safeBranch}-${short}`,
    ...(includeLatest ? [`${base}:latest`] : []),
  ];
  return [...new Set(candidates.map(validateTag))];
}

export function resolveMetadata(argv = process.argv, env = process.env) {
  const commitRaw = env.GIT_COMMIT ?? sh('git rev-parse --short HEAD') ?? 'local';
  const longCommit = env.GIT_COMMIT_LONG ?? sh('git rev-parse HEAD') ?? commitRaw;
  const branch = env.GIT_BRANCH ?? sh('git rev-parse --abbrev-ref HEAD') ?? 'local';
  const date = env.BUILD_DATE ?? new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const service = argv.find((a) => a.startsWith('--service='))?.split('=')[1];
  const tagOnly = argv.includes('--tag-only');
  const includeLatest = !argv.includes('--no-latest') && env.NODE_ENV !== 'production';
  return { commitRaw, longCommit, branch, date, service, tagOnly, includeLatest };
}

function main() {
  const { commitRaw, longCommit, branch, date, service, tagOnly, includeLatest } =
    resolveMetadata();
  const commit = commitRaw.toLowerCase();
  const services = service ? [service] : SERVICES;
  const tags = {};
  for (const svc of services) {
    tags[svc] = buildTags({ service: svc, commit, date, branch, includeLatest });
  }

  if (tagOnly) {
    const svc = service ?? 'api';
    console.log((tags[svc] ?? []).join('\n'));
    return;
  }

  console.log(
    JSON.stringify(
      { commit, longCommit, branch, date, version: `${date}-${commit}`, tags },
      null,
      2,
    ),
  );
  console.log(`\nBuild example:`);
  for (const svc of Object.keys(tags)) {
    console.log(
      `  docker build -f apps/${svc}/Dockerfile --build-arg COMMIT_SHA=${longCommit} --build-arg BUILD_DATE=${date} -t ${tags[svc][0]} .`,
    );
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
