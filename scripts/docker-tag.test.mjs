import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SERVICES, buildTags, sanitizeTagComponent, validateTag } from './docker-tag.mjs';

describe('sanitizeTagComponent', () => {
  it('turns branches into valid tag components', () => {
    assert.equal(sanitizeTagComponent('feature/My Thing'), 'feature-my-thing');
    assert.equal(sanitizeTagComponent('fix//double__dash'), 'fix-double__dash');
    assert.equal(sanitizeTagComponent('--leading'), 'leading');
    assert.equal(sanitizeTagComponent(''), 'unknown');
    assert.equal(sanitizeTagComponent('...'), 'unknown');
  });

  it('caps length to stay within Docker limits', () => {
    assert.ok(sanitizeTagComponent('a'.repeat(500)).length <= 100);
  });
});

describe('validateTag', () => {
  it('rejects invalid tags', () => {
    assert.throws(() => validateTag('platform-api:bad/tag'), /invalid_docker_tag/u);
    assert.throws(() => validateTag('-leading'), /invalid_docker_tag/u);
  });
});

describe('buildTags', () => {
  it('builds valid tags for every service', () => {
    for (const service of SERVICES) {
      const tags = buildTags({
        service,
        commit: 'abc1234',
        date: '2026-11-13',
        branch: 'feature/x',
      });
      assert.equal(tags.length, 4);
      for (const tag of tags) assert.doesNotThrow(() => validateTag(tag));
      assert.ok(tags.includes(`platform-${service}:20261113-abc1234`));
      assert.ok(tags.includes(`platform-${service}:feature-x-abc1234`));
      assert.ok(tags.includes(`platform-${service}:latest`));
    }
  });

  it('deduplicates tags and can omit latest', () => {
    const tags = buildTags({
      service: 'api',
      commit: 'abc1234',
      date: '20261113',
      branch: 'abc1234',
      includeLatest: false,
    });
    assert.equal(new Set(tags).size, tags.length);
    assert.ok(!tags.some((tag) => tag.endsWith(':latest')));
  });

  it('rejects invalid services, commits and dates', () => {
    assert.throws(
      () => buildTags({ service: 'db', commit: 'abc1234', date: '20261113' }),
      /invalid_service/u,
    );
    assert.throws(
      () => buildTags({ service: 'api', commit: 'not a sha!', date: '20261113' }),
      /invalid_commit/u,
    );
    assert.throws(
      () => buildTags({ service: 'api', commit: 'abc1234', date: '13/11/2026' }),
      /invalid_build_date/u,
    );
  });
});
