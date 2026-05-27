#!/usr/bin/env node
// Build data/dso.json from OpenNGC.
//
// Selection rule (matches the single-frame Alt-Az + APS-C constraint of the app):
//   - All Messier objects, OR
//   - NGC/IC entries with V-Mag ≤ 7 AND major axis ≤ 60'
//   - Drop any entry whose major axis > 0.95° (won't fit the smaller f/6.3 FOV)
//
// Output row schema: {id, m?, name, type, ra, dec, mag, size}
//
// Run: `node scripts/build-dso.js` (zero npm deps; needs Node ≥ 20 for global fetch).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT = resolve(__dirname, '..', 'data', 'dso.json');

const NGC_URL = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv';
const ADD_URL = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv';

// Map OpenNGC's verbose type codes to our short codes used in the UI.
const TYPE_MAP = {
  'G':   'G',   // Galaxy
  'GPair': 'G',
  'GTrpl': 'G',
  'GGroup': 'G',
  'OCl': 'OC',  // Open cluster
  'GCl': 'GC',  // Globular cluster
  'PN':  'PN',  // Planetary nebula
  'Neb': 'EN',  // Nebula
  'EmN': 'EN',  // Emission nebula
  'RfN': 'RN',  // Reflection nebula
  'HII': 'EN',  // H II region
  'SNR': 'EN',  // Supernova remnant
  'Cl+N': 'OC', // Cluster + nebulosity (treat as OC)
  'Other': null,
  'Dup': null,
  '*':   null,  // single star
  '**':  null,  // double star
  '*Ass': null, // association
  'NonEx': null,
};

// Parse RA "HH:MM:SS.ss" -> decimal hours.
function parseRa(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d+):(\d+):([\d.]+)$/);
  if (!m) return null;
  return +m[1] + +m[2] / 60 + +m[3] / 3600;
}

// Parse Dec "+/-DD:MM:SS.s" -> decimal degrees.
function parseDec(s) {
  if (!s) return null;
  const m = s.trim().match(/^([+-]?)(\d+):(\d+):([\d.]+)$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (+m[2] + +m[3] / 60 + +m[4] / 3600);
}

// Parse a single OpenNGC CSV row (semicolon-separated).
// Returns null if we don't want this row.
function parseRow(headers, line) {
  const cols = line.split(';');
  if (cols.length < headers.length) return null;
  const row = {};
  for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i];

  const type = TYPE_MAP[row['Type']];
  if (!type) return null;

  const ra = parseRa(row['RA']);
  const dec = parseDec(row['Dec']);
  if (ra == null || dec == null) return null;

  // Prefer V-mag; fall back to B-mag if missing.
  const vmag = parseFloat(row['V-Mag']);
  const bmag = parseFloat(row['B-Mag']);
  const mag = !isNaN(vmag) ? vmag : (!isNaN(bmag) ? bmag : null);

  const majAx = parseFloat(row['MajAx']); // arcmin
  const size = !isNaN(majAx) ? majAx : null;

  const mNum = row['M'] ? parseInt(row['M'], 10) : null;
  const isMessier = mNum && mNum >= 1 && mNum <= 110;

  // Selection rule
  if (!isMessier) {
    if (mag == null || mag > 7) return null;
    if (size == null || size > 60) return null;
  }
  // Hard frame-fit cap: major axis > 0.95° = 57' won't fit the f/6.3 short FOV dim
  if (size != null && size > 57) return null;

  // Pretty name
  const common = row['Common names'] || '';
  const name = common.split(',')[0].trim() || row['Name'];

  return {
    id: row['Name'],
    ...(isMessier ? { m: mNum } : {}),
    name,
    type,
    ra: +ra.toFixed(4),
    dec: +dec.toFixed(4),
    mag: mag != null ? +mag.toFixed(2) : null,
    size: size != null ? +size.toFixed(1) : null,
  };
}

async function fetchCsv(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return await r.text();
}

function parseCatalog(csv) {
  const lines = csv.split('\n').filter(l => l.trim());
  const headers = lines[0].split(';');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(headers, lines[i]);
    if (row) out.push(row);
  }
  return out;
}

async function main() {
  console.log('Fetching OpenNGC catalogs...');
  const [ngc, add] = await Promise.all([
    fetchCsv(NGC_URL),
    fetchCsv(ADD_URL).catch(err => {
      console.warn(`addendum fetch failed (${err.message}) — proceeding without it`);
      return null;
    }),
  ]);

  const rows = parseCatalog(ngc);
  if (add) rows.push(...parseCatalog(add));

  // Dedupe by Messier number when present (addendum sometimes duplicates M45 etc.)
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.m != null ? `M${r.m}` : r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }

  // Sort: Messier first by number, then NGC by mag ascending
  out.sort((a, b) => {
    if (a.m != null && b.m != null) return a.m - b.m;
    if (a.m != null) return -1;
    if (b.m != null) return 1;
    return (a.mag ?? 99) - (b.mag ?? 99);
  });

  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const messier = out.filter(r => r.m != null).length;
  console.log(`Wrote ${out.length} objects (${messier} Messier, ${out.length - messier} NGC) → ${OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
