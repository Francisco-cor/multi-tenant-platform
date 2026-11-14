#!/usr/bin/env node
// Docs link checker: validates relative Markdown links and repository paths cited
// in backticks. It intentionally does not validate external URLs or anchors.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'IMPLEMENTATION_PLAN.md', 'docs'];
const skipSchemes = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/iu;
const pathLike =
  /^(?:docs|apps|packages|scripts|infra|k6|tests|\.github)\/[A-Za-z0-9._@/{}*<>|+-]+$/u;

function walk(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith('.md') ? [path] : [];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

const files = roots.flatMap((entry) => walk(resolve(root, entry)));
const failures = [];
const seen = new Set();

function checkPath(fromFile, target, kind) {
  const clean = target.trim().replace(/^<|>$/gu, '').split('#')[0].split('?')[0];
  if (!clean || skipSchemes.test(clean) || clean.includes('://')) return;
  const absolute =
    kind === 'code-path'
      ? resolve(root, clean.replace(/^\.?\//u, ''))
      : clean.startsWith('/')
        ? resolve(root, clean.slice(1))
        : resolve(dirname(fromFile), clean);
  const key = `${kind}:${fromFile}:${clean}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (!existsSync(absolute)) {
    failures.push({ file: relative(root, fromFile), target: clean, kind });
  }
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    checkPath(file, match[1], 'markdown-link');
  }
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    const raw = match[1].trim().replace(/:\d+(?:-\d+)?$/u, '');
    if (!pathLike.test(raw) || raw.includes('*') || raw.includes('{') || raw.includes('|'))
      continue;
    checkPath(file, raw, 'code-path');
  }
}

if (failures.length > 0) {
  console.error(`[docs-links] ${failures.length} broken reference(s):`);
  for (const failure of failures) {
    console.error(`  ${failure.file}: ${failure.kind} -> ${failure.target}`);
  }
  process.exit(1);
}

console.log(
  `[docs-links] OK: ${files.length} markdown files, no broken relative links or cited paths`,
);
