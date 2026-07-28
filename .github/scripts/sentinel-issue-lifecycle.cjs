'use strict';

const fs = require('fs');
const path = require('path');

function findFiles(root, filename) {
  if (!root || !fs.existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name === filename) found.push(fullPath);
    }
  }
  return found.sort();
}

function extractRecognizedFailures(options) {
  const reportFiles = findFiles(options.artifactRoot, options.reportFilename);
  const failures = [];
  for (const reportPath of reportFiles) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch {
      continue;
    }

    const artifact = path.basename(path.dirname(reportPath));
    for (const suite of report.testResults ?? []) {
      for (const assertion of suite.assertionResults ?? []) {
        if (assertion.status !== 'failed') continue;
        const messages = (assertion.failureMessages ?? []).map(String);
        const combined = messages.join('\n');
        const codes = options.failureCodes.filter((code) => combined.includes(`[${code}]`));
        if (codes.length === 0) continue;
        failures.push({
          artifact,
          name: [...(assertion.ancestorTitles ?? []), assertion.title]
            .filter(Boolean)
            .join(' › '),
          codes,
          messages,
        });
      }
    }
  }
  return { reportFiles, failures };
}

async function listIssues(github, params) {
  if (typeof github.paginate === 'function') {
    return github.paginate(github.rest.issues.listForRepo, params);
  }
  const response = await github.rest.issues.listForRepo(params);
  return response.data;
}

function exactIssueMatches(issues, title) {
  return issues.filter((issue) => !issue.pull_request && issue.title === title);
}

function truncateFailureMessage(message) {
  return message
    .split('\n')
    .slice(0, 12)
    .join('\n')
    .replace(/```/g, '~~~');
}

function buildFailureBody({ workflowName, runUrl, failures }) {
  const blocks = failures.map((failure) => [
    `### ${failure.artifact}: ${failure.name}`,
    '',
    `Contract codes: ${failure.codes.map((code) => `\`${code}\``).join(', ')}`,
    '',
    '```text',
    failure.messages.map(truncateFailureMessage).join('\n---\n'),
    '```',
  ].join('\n'));

  return [
    `\`${workflowName}\` detected a recognized private-API contract failure.`,
    '',
    `- Workflow run: ${runUrl}`,
    `- Recognized failing probes: ${failures.length}`,
    '',
    '## Failing probes',
    '',
    blocks.join('\n\n'),
    '',
    'Harness-only failures such as timeouts, empty output, dependency installation, or build failures are intentionally excluded from this issue lifecycle.',
  ].join('\n');
}

function buildRecoveryBody({ workflowName, runUrl }) {
  return [
    `\`${workflowName}\` completed successfully across the full runner matrix.`,
    '',
    `- Recovery run: ${runUrl}`,
    '',
    'Closing this tracking issue as completed. A later recognized contract regression will reopen the same exact-title issue.',
  ].join('\n');
}

async function reconcileSentinelIssue(options) {
  const {
    github,
    context,
    core = console,
    status,
    title,
    workflowName,
    artifactRoot,
    reportFilename,
    failureCodes,
    runUrl,
  } = options;

  if (status !== 'success' && status !== 'failure') {
    core.info?.(`Sentinel issue reconciliation skipped for status '${status}'.`);
    return { action: 'ignored_status' };
  }

  const issues = await listIssues(github, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'all',
    labels: 'sentinel',
    per_page: 100,
  });
  const matches = exactIssueMatches(issues, title);
  const openIssue = matches.find((issue) => issue.state === 'open');
  const closedIssue = matches.find((issue) => issue.state === 'closed');

  if (status === 'success') {
    if (!openIssue) {
      core.info?.(`No open exact-title sentinel issue to close: ${title}`);
      return { action: 'no_open_issue' };
    }
    const body = buildRecoveryBody({ workflowName, runUrl });
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: openIssue.number,
      body,
    });
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: openIssue.number,
      state: 'closed',
      state_reason: 'completed',
    });
    return { action: 'closed', issueNumber: openIssue.number };
  }

  const extracted = extractRecognizedFailures({
    artifactRoot,
    reportFilename,
    failureCodes,
  });
  if (extracted.failures.length === 0) {
    core.warning?.(
      `Sentinel workflow failed, but no recognized contract code was found in ${extracted.reportFiles.length} report(s); issue state was not changed.`,
    );
    return { action: 'ignored_unclassified_failure' };
  }

  const body = buildFailureBody({
    workflowName,
    runUrl,
    failures: extracted.failures,
  });

  if (openIssue) {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: openIssue.number,
      body,
    });
    return { action: 'commented', issueNumber: openIssue.number };
  }

  if (closedIssue) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: closedIssue.number,
      state: 'open',
    });
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: closedIssue.number,
      body,
    });
    return { action: 'reopened', issueNumber: closedIssue.number };
  }

  const created = await github.rest.issues.create({
    owner: context.repo.owner,
    repo: context.repo.repo,
    title,
    body,
    labels: ['sentinel', 'bug'],
  });
  return { action: 'created', issueNumber: created.data.number };
}

module.exports = {
  buildFailureBody,
  buildRecoveryBody,
  exactIssueMatches,
  extractRecognizedFailures,
  reconcileSentinelIssue,
};
