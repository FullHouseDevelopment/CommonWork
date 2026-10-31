'use strict';

const fs = require('node:fs');

const GROUPS = Object.freeze([
  'workflow', 'python', 'control', 'dotnet', 'packaging',
  'box', 'windows', 'oci', 'version',
]);
const POLICY_PATH = '.github/ci-impact.json';
const MAX_PAGES = 30;

function globRegex(glob) {
  if (typeof glob !== 'string' || !glob || glob.startsWith('/') ||
      glob.includes('..') || glob.includes('\\')) {
    throw new Error('Invalid impact glob: ' + String(glob));
  }
  let regex = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; regex += '(?:.*/)?'; }
      else regex += '.*';
    } else if (c === '*') regex += '[^/]*';
    else if (c === '?') regex += '[^/]';
    else regex += '.+^$()[]{}|\\'.includes(c) ? '\\' + c : c;
  }
  return new RegExp(regex + '$');
}

function validatePolicy(policy) {
  if (!policy || policy.version !== 1 || policy.fallback !== 'full' ||
      !policy.groups || typeof policy.groups !== 'object' ||
      Array.isArray(policy.groups)) {
    throw new Error('Invalid CI impact policy; require version 1 and fallback=full');
  }
  const allowed = new Set([...GROUPS, 'docs', 'full']);
  const matchers = {};
  for (const [group, patterns] of Object.entries(policy.groups)) {
    if (!allowed.has(group) || !Array.isArray(patterns) ||
        patterns.some(p => typeof p !== 'string')) {
      throw new Error('Invalid CI impact group: ' + group);
    }
    matchers[group] = patterns.map(globRegex);
  }
  for (const group of GROUPS) {
    if (!Object.hasOwn(matchers, group)) throw new Error('Missing group: ' + group);
  }
  return matchers;
}

function releaseCandidateBase(ref) {
  return ref === 'main' || ref === 'master' ||
    (typeof ref === 'string' && /^release[/-]/.test(ref));
}

function fullPlan(reason) {
  return { ...Object.fromEntries(GROUPS.map(group => [group, true])),
    full: true, reason };
}

function classify(files, policy) {
  const matchers = validatePolicy(policy);
  if (!Array.isArray(files) || !files.length || files.length > MAX_PAGES * 100) {
    return fullPlan('Missing, empty or oversized change list');
  }
  const selected = Object.fromEntries(GROUPS.map(group => [group, false]));
  const touched = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || !file || file === POLICY_PATH) {
      return fullPlan('Invalid path or CI impact policy itself changed');
    }
    const matches = Object.entries(matchers)
      .filter(([, patterns]) => patterns.some(regex => regex.test(file)))
      .map(([group]) => group);
    if (!matches.length) return fullPlan('Unclassified path: ' + file);
    if (matches.includes('full')) return fullPlan('Sensitive path: ' + file);
    for (const group of matches) {
      touched.add(group);
      if (Object.hasOwn(selected, group)) selected[group] = true;
    }
  }
  // Workflow policy remains required, including docs-only changes.
  selected.workflow = true;
  return { ...selected, full: false,
    reason: 'Targeted: ' + [...touched].sort().join(', ') };
}

async function getJson(api, url, token) {
  const response = await fetch(api + url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'commonwork-ci-impact',
    },
  });
  if (!response.ok) throw new Error('GitHub API returned HTTP ' + response.status);
  return response.json();
}

async function loadPrPlan(env, fetchJson) {
  const repository = env.GITHUB_REPOSITORY;
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isInteger(number) || number <= 0) {
    throw new Error('Missing trusted PR identity');
  }
  const root = '/repos/' + repository;
  const pr = await fetchJson(root + '/pulls/' + number);
  const baseSha = pr.base?.sha;
  const headSha = pr.head?.sha;
  if (!/^[a-f0-9]{40}$/i.test(baseSha || '') ||
      !/^[a-f0-9]{40}$/i.test(headSha || '') ||
      pr.base?.repo?.full_name !== repository ||
      event.pull_request?.base?.sha !== baseSha ||
      event.pull_request?.head?.sha !== headSha) {
    throw new Error('Unverifiable or changed PR source/base identity');
  }
  const policyFile = await fetchJson(root + '/contents/' + POLICY_PATH +
    '?ref=' + encodeURIComponent(baseSha));
  if (policyFile.encoding !== 'base64' || !policyFile.content) {
    throw new Error('Missing trusted base-branch impact policy');
  }
  const policy = JSON.parse(Buffer.from(policyFile.content.replace(/\s/g, ''),
    'base64').toString('utf8'));
  const files = [];
  let exhausted = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchJson(root + '/pulls/' + number +
      '/files?per_page=100&page=' + page);
    if (!Array.isArray(items)) throw new Error('Invalid PR changed-file response');
    for (const item of items) {
      files.push(item.filename);
      if (item.previous_filename) files.push(item.previous_filename);
    }
    if (items.length < 100) { exhausted = true; break; }
  }
  if (!exhausted) return fullPlan('PR change list exceeds safe pagination limit');
  const after = await fetchJson(root + '/pulls/' + number);
  if (after.head?.sha !== headSha || after.base?.sha !== baseSha) {
    throw new Error('PR head or base changed during impact observation');
  }
  return classify(files, policy);
}

function writeResult(plan, env) {
  const lines = [...GROUPS, 'full'].map(name =>
    name + '=' + (plan[name] ? 'true' : 'false'));
  lines.push('reason=' + plan.reason.replace(/[\r\n]/g, ' ').slice(0, 500));
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
  const summary = '### CommonWork CI impact plan\n\n' +
    '**Mode:** ' + (plan.full ? 'Full' : 'Targeted') + '\n\n' +
    '**Reason:** ' + plan.reason + '\n\n' +
    '| Group | Decision |\n| --- | --- |\n' +
    GROUPS.map(group => '| ' + group + ' | ' +
      (plan[group] ? 'Run' : 'Skip') + ' |').join('\n') + '\n';
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
}

async function main(env = process.env) {
  let plan;
  if (env.GITHUB_EVENT_NAME !== 'pull_request' ||
      env.INPUT_FORCE_FULL === 'true') {
    plan = fullPlan('Non-PR execution or explicit full-CI override');
  } else {
    try {
      const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      if (releaseCandidateBase(event.pull_request?.base?.ref)) {
        plan = fullPlan('PR targets main or a release-candidate branch');
      } else {
        const api = env.GITHUB_API_URL || 'https://api.github.com';
        if (!env.GITHUB_TOKEN) throw new Error('Missing GitHub token');
        plan = await loadPrPlan(env, path => getJson(api, path, env.GITHUB_TOKEN));
      }
    } catch (error) {
      console.warn('Impact classifier unavailable; selecting full CI: ' + error.message);
      plan = fullPlan('Classifier error: ' + error.message);
    }
  }
  writeResult(plan, env);
  return plan;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { GROUPS, POLICY_PATH, globRegex, validatePolicy, releaseCandidateBase,
  classify, fullPlan, loadPrPlan, main };
