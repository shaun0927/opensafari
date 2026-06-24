#!/usr/bin/env node
// Map pre-fetched App Store Connect/TestFlight build JSON to a safe CI status.
//
// Usage:
//   node scripts/qa/appstoreconnect-build-status.mjs <prefetched-appstoreconnect.json>
//   node scripts/qa/appstoreconnect-build-status.mjs --self-check
//
// Prints one compact JSON object to stdout:
//   {"status":"BUILD_AVAILABLE","reason":"...","build":{...}}
//
// Statuses: BUILD_PROCESSING, BUILD_AVAILABLE, BETA_REVIEW_REQUIRED, NO_BUILD, UNKNOWN.
// This script never reads App Store Connect credentials and intentionally prints only
// selected non-secret build metadata.

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit, stderr, stdout } from 'node:process';

const STATUSES = new Set(['BUILD_PROCESSING', 'BUILD_AVAILABLE', 'BETA_REVIEW_REQUIRED', 'NO_BUILD', 'UNKNOWN']);

function usage() {
  stderr.write('Usage: appstoreconnect-build-status.mjs <prefetched-json-file>\n');
}

function die(code, message) {
  stderr.write(`${message}\n`);
  exit(code);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function getAttrs(item) {
  if (!item || typeof item !== 'object') return {};
  return item.attributes && typeof item.attributes === 'object' ? item.attributes : item;
}

function findBuilds(input) {
  const candidates = [];
  if (Array.isArray(input?.data)) candidates.push(...input.data);
  if (input?.data && !Array.isArray(input.data)) candidates.push(input.data);
  if (Array.isArray(input?.builds)) candidates.push(...input.builds);
  if (input?.build) candidates.push(input.build);
  if (input?.attributes || input?.processingState || input?.buildNumber) candidates.push(input);

  return candidates.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    return !type || type === 'builds' || type === 'build';
  });
}

function findReviewStates(input) {
  const states = [];
  for (const item of asArray(input?.included)) {
    const type = typeof item?.type === 'string' ? item.type.toLowerCase() : '';
    if (!type.includes('review') && !type.includes('betabuild')) continue;
    const attrs = getAttrs(item);
    for (const key of ['betaReviewState', 'reviewState', 'state', 'externalBuildState']) {
      if (typeof attrs[key] === 'string') states.push(attrs[key]);
    }
  }
  return states;
}

function normalize(value) {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/[ -]+/g, '_') : '';
}

function newestFirst(a, b) {
  const aa = getAttrs(a);
  const bb = getAttrs(b);
  const ad = Date.parse(aa.uploadedDate ?? aa.createdDate ?? aa.uploaded_at ?? '');
  const bd = Date.parse(bb.uploadedDate ?? bb.createdDate ?? bb.uploaded_at ?? '');
  return (Number.isFinite(bd) ? bd : 0) - (Number.isFinite(ad) ? ad : 0);
}

function summarizeBuild(build, extraReviewStates) {
  const attrs = getAttrs(build);
  const betaReviewState =
    attrs.betaReviewState ?? attrs.reviewState ?? attrs.betaAppReviewState ?? extraReviewStates[0];
  return Object.fromEntries(
    Object.entries({
      id: typeof build?.id === 'string' ? build.id : undefined,
      version: attrs.version ?? attrs.marketingVersion,
      buildNumber: attrs.buildNumber ?? attrs.versionString,
      processingState: attrs.processingState,
      betaReviewState,
      internalBuildState: attrs.internalBuildState,
      externalBuildState: attrs.externalBuildState,
      uploadedDate: attrs.uploadedDate ?? attrs.createdDate,
    }).filter(([, value]) => typeof value === 'string' && value.length > 0),
  );
}

export function classifyAppStoreConnectBuildStatus(input) {
  const builds = findBuilds(input).sort(newestFirst);
  if (builds.length === 0) {
    return { status: 'NO_BUILD', reason: 'No build records found in the JSON input.' };
  }

  const build = builds[0];
  const attrs = getAttrs(build);
  const reviewStates = [attrs.betaReviewState, attrs.reviewState, attrs.betaAppReviewState, ...findReviewStates(input)]
    .map(normalize)
    .filter(Boolean);
  const processingState = normalize(attrs.processingState);
  const internalBuildState = normalize(attrs.internalBuildState);
  const externalBuildState = normalize(attrs.externalBuildState);
  const buildSummary = summarizeBuild(build, reviewStates);

  if (['PROCESSING', 'PROCESSING_UPLOAD', 'PROCESSING_BUILD', 'UPLOADED'].includes(processingState)) {
    return {
      status: 'BUILD_PROCESSING',
      reason: 'Latest build is still processing.',
      build: buildSummary,
    };
  }

  if (
    reviewStates.some((state) =>
      [
        'WAITING_FOR_REVIEW',
        'IN_REVIEW',
        'REJECTED',
        'MISSING_EXPORT_COMPLIANCE',
        'EXPORT_COMPLIANCE_REQUIRED',
        'BETA_REVIEW_REQUIRED',
      ].includes(state),
    ) ||
    ['IN_BETA_REVIEW', 'WAITING_FOR_BETA_REVIEW', 'BETA_REVIEW_REQUIRED'].includes(externalBuildState)
  ) {
    return {
      status: 'BETA_REVIEW_REQUIRED',
      reason: 'Latest build is blocked by TestFlight beta review or compliance state.',
      build: buildSummary,
    };
  }

  if (
    ['VALID', 'COMPLETE', 'COMPLETED', 'PROCESSED'].includes(processingState) ||
    ['READY_FOR_BETA_TESTING', 'AVAILABLE', 'EXTERNAL_TESTING_READY'].includes(externalBuildState) ||
    ['READY_FOR_BETA_TESTING', 'AVAILABLE', 'INTERNAL_TESTING_READY'].includes(internalBuildState)
  ) {
    return {
      status: 'BUILD_AVAILABLE',
      reason: 'Latest build is processed and available for testing.',
      build: buildSummary,
    };
  }

  // ponytail: broad ASC JSON shapes stay script-local; upgrade path is a typed API adapter if auth is approved.
  return {
    status: 'UNKNOWN',
    reason: 'Build record did not contain recognized processing, availability, or beta review fields.',
    build: buildSummary,
  };
}

function selfCheck() {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixtures = [
    ['processing.json', 'BUILD_PROCESSING'],
    ['available.json', 'BUILD_AVAILABLE'],
    ['beta-review-required.json', 'BETA_REVIEW_REQUIRED'],
    ['no-build.json', 'NO_BUILD'],
    ['unknown-with-secret.json', 'UNKNOWN'],
  ];
  for (const [name, expected] of fixtures) {
    const file = join(here, 'fixtures-appstoreconnect-build-status', name);
    const result = classifyAppStoreConnectBuildStatus(JSON.parse(readFileSync(file, 'utf8')));
    const output = JSON.stringify(result);
    if (result.status !== expected)
      die(70, `self-check failed for ${name}: expected ${expected}, got ${result.status}`);
    if (output.includes('SHOULD_NOT_PRINT')) die(70, `self-check leaked fixture secret for ${name}`);
  }
  stdout.write(JSON.stringify({ ok: true, checked: fixtures.length }) + '\n');
}

function main() {
  const file = argv[2];
  if (file === '--self-check') {
    selfCheck();
    return;
  }
  if (!file || file === '-h' || file === '--help') {
    usage();
    exit(file ? 0 : 64);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    die(65, `Could not read valid JSON from ${basename(file)}: ${error.message}`);
  }

  const result = classifyAppStoreConnectBuildStatus(parsed);
  if (!STATUSES.has(result.status)) {
    die(70, 'Internal error: classifier returned an invalid status');
  }
  stdout.write(`${JSON.stringify(result)}\n`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();
