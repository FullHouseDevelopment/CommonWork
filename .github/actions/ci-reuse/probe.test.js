'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate, safeDiff, probe } = require('./probe');
const base = 'a'.repeat(40), previous = 'b'.repeat(40), current = 'c'.repeat(40);
const repo = 'FullHouseDevelopment/AutoDev', root = '/repos/' + repo;
const policy = { version: 1, fallback: 'run', checks: {
  python: { job: 'Integration CI / Python 3.14 / Ubuntu',
    safeChanges: ['src/AutoDev.Desktop/**'] },
  control: { job: 'Integration CI / Control contract replay / .NET 9',
    safeChanges: ['docs/roadmap/**'] },
} };

test('unknown or unsafe reuse policy refuses validation', () => {
  assert.throws(() => validate({ ...policy, fallback: 'reuse' }));
  assert.throws(() => validate({ ...policy,
    checks: { unsupported: { job: 'test', safeChanges: ['docs/**'] } } }));
  assert.throws(() => validate({ ...policy,
    checks: { python: { job: 'x', safeChanges: ['../unsafe/**'] } } }));
});

test('only explicit unrelated paths qualify, including rename origins', () => {
  const safe = validate(policy).python.safe;
  assert.equal(safeDiff([{ filename: 'src/AutoDev.Desktop/panel.cs' }], safe), true);
  assert.equal(safeDiff([{ filename: 'src/AutoDev.Core/core.cs' }], safe), false);
  assert.equal(safeDiff([{ filename: 'src/AutoDev.Desktop/panel.cs',
    previous_filename: '.github/workflows/ci.yml' }], safe), false);
  assert.equal(safeDiff(Array(300).fill({ filename: 'src/AutoDev.Desktop/a.cs' }), safe), false);
});

async function fixture(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reuse-'));
  const eventPath = path.join(tmp, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 19,
    head: { sha: current }, base: { sha: base, ref: 'develop' }, draft: false } }));
  const env = { GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath, INPUT_WORKFLOW: 'ci-develop.yml', GITHUB_RUN_ID: '999' };
  const pr = { number: 19, head: { sha: current, ref: 'feature/work' },
    base: { sha: base, ref: 'develop', repo: { full_name: repo } } };
  const run = { id: 250, head_sha: previous, status: options.status || 'completed',
    conclusion: options.result || 'success',
    event: 'pull_request', path: '.github/workflows/ci-develop.yml',
    head_branch: 'feature/work',
    pull_requests: options.missingPrMetadata ? [] : [{ number: options.prNumber || 19,
      base: { sha: options.baseSha || base, ref: 'develop' } }] };
  const get = async p => {
    if (p === root + '/pulls/19') return pr;
    if (p.startsWith(root + '/contents/')) return { encoding: 'base64',
      content: Buffer.from(JSON.stringify(policy)).toString('base64') };
    if (p.startsWith(root + '/actions/workflows/')) return { workflow_runs: [run] };
    if (p.startsWith(root + '/commits/') && p.endsWith('/pulls?per_page=100'))
      return [{ number: options.prNumber || 19, base: { ref: 'develop' } }];
    if (p === root + '/compare/' + base + '...' + previous) return {
      status: options.movedBase ? 'diverged' : 'ahead', behind_by: options.movedBase ? 2 : 0 };
    if (p.startsWith(root + '/compare/')) return { status: 'ahead', ahead_by: 1,
      behind_by: 0, total_commits: 1, files: options.files ||
        [{ filename: 'src/AutoDev.Desktop/panel.cs' }] };
    if (p.endsWith('/actions/runs/250/jobs?per_page=100')) return {
      total_count: 2, jobs: [{ name: 'Integration CI / Python 3.14 / Ubuntu',
        status: 'completed', conclusion: options.jobResult || 'success' },
        { name: 'Integration CI / Control contract replay / .NET 9',
          status: 'completed', conclusion: 'success' }] };
    throw Error('Unexpected test endpoint ' + p);
  };
  try { return await probe(env, get); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('same PR, base, ancestor, successful job and safe diff permits reuse', async () => {
  const { decisions } = await fixture();
  assert.equal(decisions.python, true);
  assert.equal(decisions.control, false);
});
test('failed job never becomes reusable evidence', async () => {
  assert.equal((await fixture({ jobResult: 'failure' })).decisions.python, false);
});
test('successful job in a completed failed run establishes reusable proof', async () => {
  assert.equal((await fixture({ result: 'failure' })).decisions.python, true);
});
test('cancelled or incomplete run cannot establish reuse', async () => {
  assert.equal((await fixture({ result: 'cancelled' })).decisions.python, false);
  assert.equal((await fixture({ status: 'in_progress' })).decisions.python, false);
});
test('different PR or base cannot donate CI success', async () => {
  assert.equal((await fixture({ prNumber: 18 })).decisions.python, false);
  assert.equal((await fixture({ baseSha: 'd'.repeat(40) })).decisions.python, false);
});
test('changed relevant inputs or workflow edits forbid reuse', async () => {
  for (const file of ['tests/test_a.py', '.github/workflows/ci.yml']) {
    assert.equal((await fixture({ files: [{ filename: file }] })).decisions.python, false);
  }
});


test('empty GitHub run PR metadata can be verified via associated commit', async () => {
  assert.equal((await fixture({ missingPrMetadata: true })).decisions.python, true);
});
test('base branch movement invalidates old CI results', async () => {
  assert.equal((await fixture({ movedBase: true })).decisions.python, false);
});
