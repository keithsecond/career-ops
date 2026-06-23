#!/usr/bin/env node

/**
 * prospects-bridge.mjs — Zero-token bridge from keithsecond/prospects → career-ops
 *
 * Reads prospects' jobResults.json, deduplicates against career-ops'
 * existing pipeline.md + scan-history.tsv, then appends new offers
 * to the pipeline and marks them in jobResults.json as status "5" (queued).
 *
 * Usage (run from inside career-ops directory):
 *   node prospects-bridge.mjs
 *   node prospects-bridge.mjs --dry-run
 *   node prospects-bridge.mjs --prospects-path ../prospects/test-data/jobResults.json
 *   node prospects-bridge.mjs --max-status 0   # only pull status "0" new jobs (default)
 *
 * jobResults.json status codes (from prospects/tests/jobResults-template.json):
 *   "0" new job  "1" applied  "2" received reply  "3" interviewing  "4" declined
 *   "5" queued → added by this bridge; prevents re-queuing on subsequent runs
 *
 * jobResults.json shape:
 * {
 *   "org key": {
 *     "Site": "Display Name",
 *     "URL":  "https://base-url.com",        ← org's portal root URL
 *     "jobs": [
 *       {
 *         "id":     "13717532",              ← provider job ID (always present)
 *         "title":  "Some Job Title",
 *         "link":   "https://full-url.com",  ← direct job URL (may be absent for ADP)
 *         "status": "0",
 *         "date":   "2026-01-01",
 *         "notes":  ""
 *       }
 *     ]
 *   },
 *   "Status Definitions": { ... }           ← skipped
 * }
 *
 * Dedup strategy (in priority order):
 *   1. job.link — exact URL match against pipeline.md, scan-history.tsv, applications.md
 *   2. job.id   — match against scan-history.tsv id column
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Config ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  prospectsDefault: resolve(__dirname, '../prospects/test-data/jobResults.json'),
  scanHistory:      resolve(__dirname, 'data/scan-history.tsv'),
  pipeline:         resolve(__dirname, 'data/pipeline.md'),
  applications:     resolve(__dirname, 'data/applications.md'),
};

// Keys in jobResults.json that are metadata, not org records
const SKIP_KEYS = new Set(['Status Definitions']);

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  return {
    dryRun:        args.includes('--dry-run'),
    prospectsPath: get('--prospects-path') ?? PATHS.prospectsDefault,
    maxStatus:     Number(get('--max-status') ?? 0),
  };
}

// ── Load prospects data ──────────────────────────────────────────────────────

function loadProspects(filePath) {
  if (!existsSync(filePath)) {
    console.error(`\nError: jobResults.json not found at:\n  ${filePath}`);
    console.error('Pass the correct path with --prospects-path <path>\n');
    process.exit(1);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// ── Build dedup sets from career-ops data ────────────────────────────────────

function loadSeen() {
  const seenUrls = new Set();
  const seenIds  = new Set();

  // scan-history.tsv: url\tfirst_seen\tportal\ttitle\tcompany\tid\tstatus
  if (existsSync(PATHS.scanHistory)) {
    for (const line of readFileSync(PATHS.scanHistory, 'utf-8').split('\n').slice(1)) {
      const cols = line.split('\t');
      if (cols[0]) seenUrls.add(cols[0].trim());
      if (cols[5]) seenIds.add(cols[5].trim());
    }
  }

  // pipeline.md: - [ ] https://url | Company | Title
  if (existsSync(PATHS.pipeline)) {
    for (const m of readFileSync(PATHS.pipeline, 'utf-8').matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seenUrls.add(m[1]);
    }
  }

  // applications.md: any bare URL
  if (existsSync(PATHS.applications)) {
    for (const m of readFileSync(PATHS.applications, 'utf-8').matchAll(/https?:\/\/[^\s|)\]]+/g)) {
      seenUrls.add(m[0]);
    }
  }

  return { seenUrls, seenIds };
}

// ── Resolve the best URL for a job ──────────────────────────────────────────

/**
 * Prefer job.link (full direct URL scraped by Playwright).
 * Fall back to org.URL + '?jobId=' + job.id for ADP-style sites
 * where adpSearch.ts constructs the URL dynamically from the query string.
 * Returns null if we can't build anything useful.
 */
function resolveUrl(job, orgUrl) {
  if (job.link && job.link.startsWith('http')) return job.link;
  if (orgUrl   && orgUrl.startsWith('http'))   return `${orgUrl.replace(/\/$/, '')}?jobId=${job.id}`;
  return null;
}

// ── Write to career-ops files ────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (!existsSync(PATHS.pipeline)) {
    writeFileSync(PATHS.pipeline, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }

  let text        = readFileSync(PATHS.pipeline, 'utf-8');
  const marker    = '## Pendientes';
  const markerIdx = text.indexOf(marker);
  const lines     = offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';

  if (markerIdx === -1) {
    text += `\n${marker}\n\n${lines}\n`;
  } else {
    const after       = markerIdx + marker.length;
    const nextSection = text.indexOf('\n## ', after);
    const insertAt    = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + '\n' + lines + text.slice(insertAt);
  }

  writeFileSync(PATHS.pipeline, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  mkdirSync(dirname(PATHS.scanHistory), { recursive: true });

  if (!existsSync(PATHS.scanHistory)) {
    writeFileSync(PATHS.scanHistory, 'url\tfirst_seen\tportal\ttitle\tcompany\tid\tstatus\n', 'utf-8');
  }

  const lines = offers
    .map(o => `${o.url}\t${date}\tprospects-bridge\t${o.title}\t${o.company}\t${o.id}\tadded`)
    .join('\n') + '\n';

  appendFileSync(PATHS.scanHistory, lines, 'utf-8');
}

function markAsQueued(prospectsData, queuedIds, prospectsPath) {
  for (const orgKey of Object.keys(prospectsData)) {
    if (SKIP_KEYS.has(orgKey)) continue;
    for (const job of (prospectsData[orgKey]?.jobs ?? [])) {
      if (queuedIds.has(job.id)) job.status = '5';
    }
  }
  writeFileSync(prospectsPath, JSON.stringify(prospectsData, null, 2), 'utf-8');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const { dryRun, prospectsPath, maxStatus } = parseArgs();

  console.log(`\nprospects-bridge`);
  console.log(`  source : ${prospectsPath}`);
  console.log(`  target : ${PATHS.pipeline}`);
  console.log(`  mode   : ${dryRun ? 'DRY RUN (no files written)' : 'live'}\n`);

  const prospectsData          = loadProspects(prospectsPath);
  const { seenUrls, seenIds }  = loadSeen();
  const date                   = new Date().toISOString().slice(0, 10);

  const newOffers = [];
  const queuedIds = new Set();
  let totalScanned = 0, totalSkippedStatus = 0, totalNoUrl = 0, totalDupes = 0;

  for (const orgKey of Object.keys(prospectsData)) {
    if (SKIP_KEYS.has(orgKey)) continue;

    const org     = prospectsData[orgKey];
    const company = org.Site ?? orgKey;
    const orgUrl  = org.URL  ?? '';

    for (const job of (org.jobs ?? [])) {
      totalScanned++;

      if (Number(job.status ?? 0) > maxStatus) { totalSkippedStatus++; continue; }

      const url = resolveUrl(job, orgUrl);
      if (!url) { totalNoUrl++; continue; }

      if (seenUrls.has(url) || seenIds.has(job.id)) { totalDupes++; continue; }

      seenUrls.add(url);
      seenIds.add(job.id);

      newOffers.push({ url, company, title: job.title ?? '(no title)', id: job.id });
      queuedIds.add(job.id);
    }
  }

  if (!dryRun && newOffers.length > 0) {
    mkdirSync(dirname(PATHS.pipeline), { recursive: true });
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
    markAsQueued(prospectsData, queuedIds, prospectsPath);
  }

  const W = 44;
  console.log('─'.repeat(W));
  console.log(`prospects-bridge — ${date}`);
  console.log('─'.repeat(W));
  console.log(`Jobs scanned          ${String(totalScanned).padStart(4)}`);
  console.log(`Skipped (status > ${maxStatus})  ${String(totalSkippedStatus).padStart(4)}`);
  console.log(`Skipped (no URL)      ${String(totalNoUrl).padStart(4)}`);
  console.log(`Duplicates skipped    ${String(totalDupes).padStart(4)}`);
  console.log(`New offers added      ${String(newOffers.length).padStart(4)}`);

  if (newOffers.length > 0) {
    console.log('');
    for (const o of newOffers) console.log(`  + ${o.company} | ${o.title}`);
    if (dryRun) {
      console.log('\n  (dry run — rerun without --dry-run to save)');
    } else {
      console.log(`\n  Saved to ${PATHS.pipeline}`);
      console.log(`  ${queuedIds.size} jobs marked status "5" (queued) in ${prospectsPath}`);
    }
  } else {
    console.log('\n  Nothing new to add.');
  }

  console.log('\n→ Next: node scan.mjs  →  /career-ops pipeline\n');
}

main();
