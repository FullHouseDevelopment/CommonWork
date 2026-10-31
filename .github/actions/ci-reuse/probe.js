'use strict';

// Same-PR successful-job reuse. A missing/ambiguous proof always means RUN.
const fs = require('node:fs');
const { globRegex } = require('../ci-impact/plan');

const CHECKS = Object.freeze(['python', 'python_windows', 'control',
  'dotnet_linux', 'dotnet_windows', 'python_reference']);
const POLICY = '.github/ci-reuse.json';
const SHA = /^[0-9a-f]{40}$/i;

function validate(policy) {
  if (!policy || policy.version !== 1 || policy.fallback !== 'run' ||
      !policy.checks || typeof policy.checks !== 'object' ||
      Array.isArray(policy.checks)) throw Error('Invalid CI reuse policy');
  const result = {};
  for (const [id, spec] of Object.entries(policy.checks)) {
    if (!CHECKS.includes(id) || !spec || typeof spec.job !== 'string' ||
        !spec.job.trim() || !Array.isArray(spec.safeChanges) ||
        !spec.safeChanges.length) throw Error('Invalid reuse check: ' + id);
    result[id] = { job: spec.job,
      safe: spec.safeChanges.map(globRegex) };
  }
  return result;
}

function safeDiff(files, safe) {
  if (!Array.isArray(files) || files.length > 299 || !files.length) return false;
  return files.every(file =>
    file && typeof file.filename === 'string' &&
    file.filename !== POLICY &&
    [file.filename, file.previous_filename].filter(Boolean)
      .every(path => safe.some(pattern => pattern.test(path))));
}

async function fromApi(api, path, token) {
  const res = await fetch(api + path, { headers: {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'commonwork-ci-reuse',
  } });
  if (!res.ok) throw Error('GitHub HTTP ' + res.status);
  return res.json();
}

async function probe(env, get) {
  const decisions = Object.fromEntries(CHECKS.map(id => [id, false]));
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || event.pull_request?.draft ||
      env.INPUT_FORCE_FULL === 'true') return { decisions, reason: 'PR reuse disabled' };
  const repo = env.GITHUB_REPOSITORY;
  const prNumber = event.pull_request?.number;
  const workflow = env.INPUT_WORKFLOW;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      !Number.isInteger(prNumber) || !/^[a-z0-9-]+\.yml$/.test(workflow || '')) {
    throw Error('Invalid repo, PR, or trusted workflow identifier');
  }
  const root = '/repos/' + repo;
  const pr = await get(root + '/pulls/' + prNumber);
  const head = pr.head?.sha, base = pr.base?.sha;
  if (!SHA.test(head || '') || !SHA.test(base || '') ||
      pr.base?.repo?.full_name !== repo ||
      pr.head?.sha !== event.pull_request?.head?.sha ||
      base !== event.pull_request?.base?.sha ||
      pr.base?.ref !== event.pull_request?.base?.ref ||
      ['main', 'master'].includes(pr.base.ref) ||
      /^release[/-]/.test(pr.base.ref)) {
    throw Error('PR identity drift or full-CI branch');
  }
  const file = await get(root + '/contents/' + POLICY + '?ref=' + base);
  if (file.encoding !== 'base64' || !file.content) throw Error('Missing trusted reuse policy');
  const policy = validate(JSON.parse(Buffer.from(file.content.replace(/\s/g, ''),
    'base64').toString('utf8')));
  const runs = await get(root + '/actions/workflows/' + workflow +
    '/runs?event=pull_request&branch=' + encodeURIComponent(pr.head.ref) + '&per_page=50');
  if (!Array.isArray(runs.workflow_runs)) throw Error('Missing workflow run history');
  const reasons = [];
  for (const run of runs.workflow_runs.slice(0, 50)) {
    if (CHECKS.every(id => decisions[id] || !policy[id])) break;
    if (run.conclusion !== 'success' || run.event !== 'pull_request' ||
        !SHA.test(run.head_sha || '') || run.head_sha === head ||
        run.id === Number(env.GITHUB_RUN_ID) ||
        run.path !== '.github/workflows/' + workflow ||
        run.head_branch !== pr.head.ref || !Array.isArray(run.pull_requests) ||
        !run.pull_requests.some(p => p.number === prNumber &&
          p.base?.sha === base && p.base?.ref === pr.base.ref)) continue;
    const comparison = await get(root + '/compare/' + run.head_sha + '...' + head);
    if (comparison.status !== 'ahead' || comparison.behind_by !== 0 ||
        comparison.ahead_by < 1 || comparison.total_commits > 250 ||
        !Array.isArray(comparison.files) || comparison.files.length >= 300) continue;
    const eligible = Object.entries(policy).filter(([id, spec]) =>
      !decisions[id] && safeDiff(comparison.files, spec.safe));
    if (!eligible.length) continue;
    const jobs = await get(root + '/actions/runs/' + run.id + '/jobs?per_page=100');
    if (!Array.isArray(jobs.jobs) || jobs.total_count > jobs.jobs.length) continue;
    for (const [id, spec] of eligible) {
      const matches = jobs.jobs.filter(job => job.name === spec.job);
      if (matches.length === 1 && matches[0].conclusion === 'success' &&
          matches[0].status === 'completed') {
        decisions[id] = true;
        reasons.push(id + ' <- successful run ' + run.id + ' @ ' + run.head_sha.slice(0, 12));
      }
    }
  }
  const current = await get(root + '/pulls/' + prNumber);
  if (current.head?.sha !== head || current.base?.sha !== base ||
      current.base?.ref !== pr.base.ref) throw Error('PR changed while proving reuse');
  return { decisions, reason: reasons.length ? reasons.join('; ') : 'No eligible earlier success' };
}

function output(result, env) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT,
    CHECKS.map(id => id + '=' + (result.decisions[id] ? 'true' : 'false')).join('\n') +
    '\nreason=' + result.reason.replace(/[\r\n]/g, ' ').slice(0, 900) + '\n');
  const summary = '### Same-PR CI reuse\n\n' + result.reason + '\n\n' +
    CHECKS.map(id => '- ' + id + ': ' +
      (result.decisions[id] ? 'verified previous success' : 'run normally')).join('\n');
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n');
}

async function main(env = process.env) {
  let result;
  try {
    if (!env.GITHUB_TOKEN) throw Error('Missing API token');
    result = await probe(env, path => fromApi(env.GITHUB_API_URL ||
      'https://api.github.com', path, env.GITHUB_TOKEN));
  } catch (error) {
    console.warn('Reuse proof unavailable; running tests: ' + error.message);
    result = { decisions: Object.fromEntries(CHECKS.map(id => [id, false])),
      reason: 'Fail-closed: ' + error.message };
  }
  output(result, env);
  return result;
}
if (require.main === module) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
module.exports = { CHECKS, validate, safeDiff, probe, main };
