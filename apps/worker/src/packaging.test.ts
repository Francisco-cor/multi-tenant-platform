import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

describe('worker packaging (P0-1)', () => {
  it('starts the compiled entrypoint with plain node, not tsx', () => {
    expect(packageJson.scripts.start).toBe('node dist/main.js');
    expect(packageJson.scripts.start).not.toContain('tsx');
  });

  it('keeps an explicitly named tsx fallback until workspace packages are compiled', () => {
    expect(packageJson.scripts['start:tsx']).toContain('tsx');
  });
});
