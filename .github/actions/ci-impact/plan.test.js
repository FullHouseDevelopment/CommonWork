'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classify, fullPlan, globRegex, validatePolicy, loadPrPlan, releaseCandidateBase } = require('./plan');

const groups = {
  workflow: ['.github/workflows/**', 'tests/*workflow*.py'],
  python: ['automation/**'],
  control: ['src/Control/**'],
  dotnet: ['src/**'],
  packaging: ['deploy/**'],
  box: ['box/**'],
  windows: ['windows/**'],
  oci: ['integrations/oci/**'],
  version: ['version/**'],
  docs: ['docs/**', '*.md'],
  full: ['.github/actions/ci-impact/**'],
};
const policy = { version: 1, fallback: 'full', groups };

test('CI-only PR skips runtime and installer validation', () => {
  const result = classify(['.github/workflows/ci.yml',
    'tests/test_git_flow_workflow_wiring.py'], policy);
  assert.equal(result.full, false);
  assert.equal(result.workflow, true);
  for (const group of ['python', 'control', 'dotnet', 'packaging', 'box', 'windows', 'oci']) {
    assert.equal(result[group], false, group);
  }
});

test('docs-only change retains the baseline policy job', () => {
  const result = classify(['docs/README.md'], policy);
  assert.equal(result.workflow, true);
  assert.equal(result.python, false);
  assert.equal(result.full, false);
});

test('unclassified and policy changes run full CI', () => {
  for (const path of ['new.unclassified', '.github/ci-impact.json',
    '.github/actions/ci-impact/plan.js']) {
    assert.equal(classify([path], policy).full, true, path);
  }
});

test('nested globs match safely without crossing segments', () => {
  assert.equal(globRegex('docs/**/README.md').test('docs/README.md'), true);
  assert.equal(globRegex('docs/**/README.md').test('docs/x/README.md'), true);
  assert.equal(globRegex('src/**').test('src/a/b.cs'), true);
  assert.equal(globRegex('src/*').test('src/a/b.cs'), false);
});

test('invalid policies cannot silently narrow checks', () => {
  assert.throws(() => validatePolicy({ ...policy, fallback: 'skip' }));
  assert.throws(() => validatePolicy({ ...policy, groups: { ...groups, unknown: [] } }));
  assert.throws(() => validatePolicy({ ...policy, groups: { ...groups, python: ['../evil'] } }));
  assert.throws(() => validatePolicy({ ...policy, groups: { ...groups, python: [] , dotnet: null } }));
});

test('full mode enables every execution group', () => {
  const result = fullPlan('main push');
  for (const group of Object.keys(groups).filter(x => !['docs', 'full'].includes(x))) {
    assert.equal(result[group], true);
  }
});

test('empty and oversized changes fail closed', () => {
  assert.equal(classify([], policy).full, true);
  assert.equal(classify(Array(3001).fill('docs/x.md'), policy).full, true);
});

test('PR head/base drift fails closed instead of accepting a stale file list', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-impact-'));
  const eventPath = path.join(folder, 'event.json');
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const root = '/repos/FullHouseDevelopment/AutoDev';
  try {
    fs.writeFileSync(eventPath, JSON.stringify({
      pull_request: { number: 17, head: { sha: head }, base: { sha: base, ref: 'develop' } },
    }));
    let prCalls = 0;
    const get = async endpoint => {
      if (endpoint === root + '/pulls/17') {
        prCalls++;
        return { base: { sha: base, ref: 'develop', repo: { full_name: 'FullHouseDevelopment/AutoDev' } },
          head: { sha: prCalls === 1 ? head : 'c'.repeat(40) } };
      }
      if (endpoint.startsWith(root + '/contents/')) {
        return { encoding: 'base64',
          content: Buffer.from(JSON.stringify(policy)).toString('base64') };
      }
      if (endpoint.startsWith(root + '/pulls/17/files?')) {
        return [{ filename: 'docs/README.md' }];
      }
      throw new Error('Unexpected test API call: ' + endpoint);
    };
    await assert.rejects(
      () => loadPrPlan({ GITHUB_REPOSITORY: 'FullHouseDevelopment/AutoDev',
        GITHUB_EVENT_PATH: eventPath }, get),
      /PR head or base changed/,
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('main and release PRs always run full validation', () => {
  for (const branch of ['main', 'master', 'release/1.4', 'release-2026']) {
    assert.equal(releaseCandidateBase(branch), true, branch);
  }
  assert.equal(releaseCandidateBase('develop'), false);
  assert.equal(releaseCandidateBase('feature/csharp'), false);
});
