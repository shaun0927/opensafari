#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const file = process.argv[2];

  if (!file) {
    console.error('Usage: appstoreconnect-build-status.mjs <prefetched-appstoreconnect-json>');
    process.exit(64);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`${JSON.stringify(classify(parsed))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export function classify(input) {
  const builds = extractBuilds(input);
  if (builds.length === 0) {
    return { status: 'NO_BUILD', reason: 'No build records were present in the input.' };
  }

  const latest = builds[0];
  const state = normalizedState(latest);
  const review = normalizedReviewState(latest);
  const id = stringField(latest, ['id', 'buildId']);
  const version = stringField(latest, ['version', 'versionString']);
  const buildNumber = stringField(latest, ['buildNumber', 'number']);
  const summary = compact({ id, version, buildNumber });

  if (/(processing|upload|waiting_for_processing)/i.test(state)) {
    return compact({ status: 'BUILD_PROCESSING', reason: 'Latest build is still processing.', build: summary });
  }

  if (/(waiting|in_review|rejected|review)/i.test(review) && !/approved/i.test(review)) {
    return compact({ status: 'BETA_REVIEW_REQUIRED', reason: 'Latest build is blocked on beta app review.', build: summary });
  }

  if (/(valid|available|ready|complete|processed)/i.test(state) || /approved/i.test(review)) {
    return compact({ status: 'BUILD_AVAILABLE', reason: 'Latest build appears available for TestFlight use.', build: summary });
  }

  return compact({ status: 'UNKNOWN', reason: 'Build metadata did not match a known TestFlight availability state.', build: summary });
}

function extractBuilds(input) {
  const source = Array.isArray(input) ? input : input?.data ?? input?.builds ?? input?.included ?? [];
  if (!Array.isArray(source)) return [];
  return source
    .filter((item) => item && typeof item === 'object')
    .map(normalizeBuild)
    .filter((item) => item.kind === 'build')
    .sort((a, b) => String(b.uploadedDate ?? '').localeCompare(String(a.uploadedDate ?? '')));
}

function normalizeBuild(item) {
  const attrs = item.attributes && typeof item.attributes === 'object' ? item.attributes : {};
  return {
    kind: item.type === 'builds' || item.type === 'build' || attrs.processingState || item.processingState ? 'build' : 'other',
    id: item.id,
    version: item.version ?? attrs.version ?? attrs.versionString,
    buildNumber: item.buildNumber ?? attrs.buildNumber,
    uploadedDate: item.uploadedDate ?? attrs.uploadedDate ?? attrs.uploadedDateTime,
    processingState: item.processingState ?? attrs.processingState,
    betaReviewState: item.betaReviewState ?? attrs.betaReviewState ?? attrs.reviewState,
  };
}

function normalizedState(build) {
  return String(build.processingState ?? '').trim().toLowerCase();
}

function normalizedReviewState(build) {
  return String(build.betaReviewState ?? '').trim().toLowerCase();
}

function stringField(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
  }
  return undefined;
}

function compact(object) {
  if (!object || typeof object !== 'object') return object;
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}
