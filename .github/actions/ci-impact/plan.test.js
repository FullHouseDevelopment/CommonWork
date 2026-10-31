'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classify, fullPlan, globRegex, validatePolicy } = require('./plan');

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
