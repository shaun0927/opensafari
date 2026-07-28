'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  extractRecognizedFailures,
  reconcileSentinelIssue,
} = require('./sentinel-issue-lifecycle.cjs');

function writeReport(root, artifact, message) {
  const dir = path.join(root, artifact);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'report.json'),
    JSON.stringify({
      testResults: [{
        assertionResults: [{
          status: 'failed',
          ancestorTitles: ['Sentinel'],
          title: 'probe',
          failureMessages: [message],
        }],
      }],
    }),
  );
}

function makeGithub(issues) {
  const calls = { comments: [], creates: [], updates: [] };
  return {
    calls,
    rest: {
      issues: {
        listForRepo: async () => ({ data: issues }),
        createComment: async (input) => {
          calls.comments.push(input);
          return { data: {} };
        },
        create: async (input) => {
          calls.creates.push(input);
          return { data: { number: 99 } };
        },
        update: async (input) => {
          calls.updates.push(input);
          return { data: {} };
        },
      },
    },
  };
}

function baseOptions(root, github, status = 'failure') {
  return {
    github,
    context: { repo: { owner: 'owner', repo: 'repo' } },
    core: { info() {}, warning() {} },
    status,
    title: '[sentinel] Canonical regression',
    workflowName: 'test-sentinel',
    artifactRoot: root,
    reportFilename: 'report.json',
    failureCodes: ['API_MISSING'],
    runUrl: 'https://example.test/run/1',
  };
}

test('extracts only recognized contract failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lifecycle-'));
  try {
    writeReport(root, 'runner-a', 'Error: [API_MISSING] symbol disappeared');
    writeReport(root, 'runner-b', 'Error: [HARNESS_TIMEOUT] child stalled');
    const result = extractRecognizedFailures({
      artifactRoot: root,
      reportFilename: 'report.json',
      failureCodes: ['API_MISSING'],
    });
    assert.equal(result.reportFiles.length, 2);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].artifact, 'runner-a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('comments on an existing exact-title open issue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lifecycle-'));
  try {
    writeReport(root, 'runner-a', 'Error: [API_MISSING] symbol disappeared');
    const github = makeGithub([
      { number: 7, title: '[sentinel] Canonical regression', state: 'open' },
      { number: 8, title: '[sentinel] Canonical regression (runner-a)', state: 'open' },
    ]);
    const result = await reconcileSentinelIssue(baseOptions(root, github));
    assert.deepEqual(result, { action: 'commented', issueNumber: 7 });
    assert.equal(github.calls.comments[0].issue_number, 7);
    assert.equal(github.calls.creates.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reopens the same exact-title closed issue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lifecycle-'));
  try {
    writeReport(root, 'runner-a', 'Error: [API_MISSING] symbol disappeared');
    const github = makeGithub([
      { number: 12, title: '[sentinel] Canonical regression', state: 'closed' },
    ]);
    const result = await reconcileSentinelIssue(baseOptions(root, github));
    assert.deepEqual(result, { action: 'reopened', issueNumber: 12 });
    assert.deepEqual(github.calls.updates[0], {
      owner: 'owner',
      repo: 'repo',
      issue_number: 12,
      state: 'open',
    });
    assert.equal(github.calls.comments[0].issue_number, 12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('creates a canonical issue when no exact-title history exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lifecycle-'));
  try {
    writeReport(root, 'runner-a', 'Error: [API_MISSING] symbol disappeared');
    const github = makeGithub([]);
    const result = await reconcileSentinelIssue(baseOptions(root, github));
    assert.deepEqual(result, { action: 'created', issueNumber: 99 });
    assert.equal(github.calls.creates[0].title, '[sentinel] Canonical regression');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignores workflow failures with only harness diagnostics', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lifecycle-'));
  try {
    writeReport(root, 'runner-a', 'Error: [HARNESS_TIMEOUT] child stalled');
    const github = makeGithub([]);
    const result = await reconcileSentinelIssue(baseOptions(root, github));
    assert.deepEqual(result, { action: 'ignored_unclassified_failure' });
    assert.equal(github.calls.creates.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('comments and closes an exact-title open issue after full recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lifecycle-'));
  try {
    const github = makeGithub([
      { number: 21, title: '[sentinel] Canonical regression', state: 'open' },
    ]);
    const result = await reconcileSentinelIssue(baseOptions(root, github, 'success'));
    assert.deepEqual(result, { action: 'closed', issueNumber: 21 });
    assert.equal(github.calls.comments[0].issue_number, 21);
    assert.deepEqual(github.calls.updates[0], {
      owner: 'owner',
      repo: 'repo',
      issue_number: 21,
      state: 'closed',
      state_reason: 'completed',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
