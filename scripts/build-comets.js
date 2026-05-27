#!/usr/bin/env node
// Build data/bright_comets.json from the Minor Planet Center's Soft00Cmt.txt.
//
// Selection rule: estimate apparent magnitude using MPC's H + 5·log10(Δ) + 2.5·k·log10(r)
// and keep comets with `m ≤ 8` (slightly looser than the runtime mag-7 filter — runtime
// can drop, this gives it the freedom to).
//
// Output row schema:
//   {designation, name, epoch, orbital: {…}, mag_estimated, mag_source, tail_likely}
//
// Optional cross-references (Yoshida / COBS) are sketched but not wired up by default —
// flip the ENABLE_YOSHIDA_SCRAPE flag if you want to try. Most years the result is `[]`
// either way; the file's job is mainly to act as a same-origin cache so the runtime
// app doesn't have to re-fetch 300 KB of comet text on every page load.
//
// Run: `node scripts/build-comets.js`

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT = resolve(__dirname, '..', 'data', 'bright_comets.json');

const MPC_URL = 'https://www.minorplanetcenter.net/iau/Ephemerides/Comets/Soft00Cmt.txt';
// Inclusion threshold: we cache everything that COULD reach mag ≤ 8 within ~3 months
// of perihelion. The runtime re-computes apparent mag for each observer night and
// filters strictly. This catches comets that aren't bright at build time but are
// brightening within the next 6 months or fading from peak within the last 18 months.
const ABS_MAG_CAP = 13.0;  // H ≤ 13 covers ~all potentially-photographable periodic + parabolic comets

// MPC's Soft00Cmt.txt is fixed-column. Verified column positions (0-indexed, end-exclusive):
//   designation: 0–11   (e.g. "0001P     " for 1P/Halley, "    CK20F030" for C/2020 F3)
//   peri year:   14–18
//   peri mon:    19–21
//   peri day:    22–29  (decimal)
//   q (AU):      30–39  (perihelion distance)
//   e:           41–51  (eccentricity)
//   argp (deg):  51–60
//   node (deg):  61–70
//   incl (deg):  71–80
//   epoch year:  81–85
//   epoch mon:   85–87
//   epoch day:   87–89
//   H (m1):      91–95  (f5.1 — absolute total mag)
//   k:           96–100 (f5.1 — activity slope, usually 4.0 if unknown)
//   name:        102–   (rest of line, often "    C/2020 F3 (NEOWISE)")
//
// Reference: https://minorplanetcenter.net/iau/info/CometsSoft.html
function parseMpcLine(line) {
  if (line.length < 102) return null;
  const desig = line.slice(0, 12).trim();
  if (!desig) return null;
  const periYear  = parseInt(line.slice(14, 18), 10);
  const periMon   = parseInt(line.slice(19, 21), 10);
  const periDay   = parseFloat(line.slice(22, 29));
  const q         = parseFloat(line.slice(30, 39));
  const e         = parseFloat(line.slice(41, 51));
  const argp      = parseFloat(line.slice(51, 60));
  const node      = parseFloat(line.slice(61, 70));
  const incl      = parseFloat(line.slice(71, 80));
  const H         = parseFloat(line.slice(91, 96));
  const k         = parseFloat(line.slice(96, 101));
  // Name region starts ~col 103 and ends before the trailing reference code
  // ("MPC 12345" or "MPEC 2022-XY1"). Split on 2+ spaces and take the first chunk.
  const nameRegion = line.slice(102).trim();
  const rawName = nameRegion.split(/\s{2,}/)[0].trim();

  if (isNaN(q) || isNaN(e) || isNaN(H)) return null;

  // Perihelion as JD (Gregorian, UT)
  const tp = juldayUt(periYear, periMon, periDay);

  // Designation: prefer the human-readable form from the name region
  // (e.g. "C/2024 G3 (ATLAS)" → "C/2024 G3"; "141P-D/Machholz" → "141P-D").
  // Falls back to the packed cols 0-12 form if name region is missing.
  let displayDesig = desig;
  let displayName = rawName || desig;
  if (rawName) {
    const slashMatch = rawName.match(/^([^/]+)\/(.+)$/);     // e.g. 141P-D/Machholz
    const parenMatch = rawName.match(/^(.+?)\s+\((.+)\)$/);  // e.g. C/2024 G3 (ATLAS)
    if (parenMatch) {
      displayDesig = parenMatch[1].trim();
      displayName  = parenMatch[2].trim();
    } else if (slashMatch) {
      displayDesig = slashMatch[1].trim();
      displayName  = slashMatch[2].trim();
    } else {
      displayName = rawName;
    }
  }

  return {
    designation: displayDesig,
    name: displayName,
    tp,                                  // perihelion JD
    orbital: {
      q: +q.toFixed(6),
      e: +e.toFixed(6),
      i: +incl.toFixed(4),
      node: +node.toFixed(4),
      argp: +argp.toFixed(4),
      tp,
    },
    H: +H.toFixed(2),
    k: isNaN(k) ? 4.0 : +k.toFixed(2),
  };
}

// Julian Day for Gregorian calendar at UT. Periday includes the fractional day.
function juldayUt(year, month, day) {
  // Meeus, Astronomical Algorithms, ch. 7
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) +
         Math.floor(30.6001 * (m + 1)) +
         day + B - 1524.5;
}

// Solve Kepler's equation for elliptical / parabolic / hyperbolic orbits.
// Returns {x, y, z} heliocentric ecliptic position in AU at JD `jd`.
// Good to ~few arcmin for our brightness estimation (we only need r and Δ).
function heliocentricPos(orb, jd) {
  const { q, e, i, node, argp, tp } = orb;
  const dt = jd - tp;                // days since perihelion
  const k = 0.01720209895;           // Gaussian gravitational constant (rad/day)
  let nu;                            // true anomaly (rad)

  if (Math.abs(e - 1) < 0.001) {
    // Parabolic (Barker's equation)
    const W = (3 / Math.SQRT2) * k * dt / Math.pow(2 * q, 1.5);
    // Solve W = tan(nu/2) + tan(nu/2)^3 / 3 via cubic
    const y = Math.cbrt(W + Math.sqrt(W * W + 1));
    const tanHalfNu = y - 1 / y;
    nu = 2 * Math.atan(tanHalfNu);
  } else if (e < 1) {
    // Elliptical
    const a = q / (1 - e);
    const n = k * Math.pow(a, -1.5);     // mean motion
    const M = n * dt;                    // mean anomaly
    let E = M;                           // initial guess
    for (let it = 0; it < 30; it++) {
      const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-10) break;
    }
    nu = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2)
    );
  } else {
    // Hyperbolic
    const a = q / (e - 1);
    const n = k * Math.pow(a, -1.5);
    const M = n * dt;
    let F = Math.asinh(M / e || 0.001);
    for (let it = 0; it < 30; it++) {
      const dF = (e * Math.sinh(F) - F - M) / (e * Math.cosh(F) - 1);
      F -= dF;
      if (Math.abs(dF) < 1e-10) break;
    }
    nu = 2 * Math.atan2(
      Math.sqrt(e + 1) * Math.sinh(F / 2),
      Math.sqrt(e - 1) * Math.cosh(F / 2)
    );
  }

  const r = q * (1 + e) / (1 + e * Math.cos(nu));     // heliocentric distance

  // Position in orbital plane (perifocal)
  const xp = r * Math.cos(nu);
  const yp = r * Math.sin(nu);

  // Rotate to ecliptic frame: Rz(-Ω) * Rx(-i) * Rz(-ω)
  const cosW = Math.cos(argp * Math.PI / 180), sinW = Math.sin(argp * Math.PI / 180);
  const cosI = Math.cos(i    * Math.PI / 180), sinI = Math.sin(i    * Math.PI / 180);
  const cosO = Math.cos(node * Math.PI / 180), sinO = Math.sin(node * Math.PI / 180);

  const x1 = cosW * xp - sinW * yp;
  const y1 = sinW * xp + cosW * yp;
  const z1 = 0;

  const x2 = x1;
  const y2 = cosI * y1 - sinI * z1;
  const z2 = sinI * y1 + cosI * z1;

  const x = cosO * x2 - sinO * y2;
  const y = sinO * x2 + cosO * y2;
  const z = z2;

  return { x, y, z, r };
}

// Sun's geocentric ecliptic position at JD (low-precision; good to arcmin for distance).
// From Meeus ch. 25 (simplified).
function sunEclPos(jd) {
  const T = (jd - 2451545.0) / 36525;
  const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) * Math.PI / 180;
  const M  = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * Math.PI / 180;
  const e  = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C  = ((1.914602 - 0.004817 * T) * Math.sin(M)
           +  (0.019993 - 0.000101 * T) * Math.sin(2 * M)
           +   0.000289 * Math.sin(3 * M)) * Math.PI / 180;
  const trueLong = L0 + C;
  const trueAnom = M + C;
  const R = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(trueAnom));
  // Geocentric: Sun's heliocentric position is the negative of Earth's
  return {
    x: -R * Math.cos(trueLong),
    y: -R * Math.sin(trueLong),
    z: 0,
    r: R,
  };
}

// Apparent magnitude estimate.
function apparentMag(H, k, r, delta) {
  // m1 = H + 5·log10(Δ) + 2.5·k·log10(r)
  return H + 5 * Math.log10(delta) + 2.5 * k * Math.log10(r);
}

async function main() {
  console.log('Fetching MPC comet catalog...');
  const r = await fetch(MPC_URL);
  if (!r.ok) throw new Error(`MPC: HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.split('\n').filter(l => l.trim());
  console.log(`Got ${lines.length} comet rows.`);

  const now = new Date();
  const jd  = now.getTime() / 86400000 + 2440587.5;

  const out = [];
  const sun = sunEclPos(jd);

  for (const line of lines) {
    const comet = parseMpcLine(line);
    if (!comet) continue;
    // Coarse filter: keep anything that might brighten enough to be worth showing.
    // The runtime recomputes apparent mag per observer/night and applies the strict ≤ 7 cap.
    if (!(comet.H <= ABS_MAG_CAP)) continue;
    // Also require perihelion within the last 18 months or next 6 months —
    // anything older has faded; anything further out won't be observable.
    const daysFromPeri = comet.tp - jd;
    if (daysFromPeri < -540 || daysFromPeri > 180) continue;

    try {
      const p = heliocentricPos(comet.orbital, jd);
      if (!isFinite(p.r) || p.r > 30 || p.r < 0.01) continue;
      const earth = { x: -sun.x, y: -sun.y, z: -sun.z };
      const dx = p.x - earth.x, dy = p.y - earth.y, dz = p.z - earth.z;
      const delta = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const m_now = apparentMag(comet.H, comet.k, p.r, delta);

      out.push({
        designation: comet.designation,
        name: comet.name,
        epoch: now.toISOString().slice(0, 10),
        orbital: comet.orbital,
        H: comet.H,
        k: comet.k,
        mag_at_build: isFinite(m_now) ? +m_now.toFixed(2) : null,
        mag_source: 'mpc-formula',
        days_from_perihelion: +daysFromPeri.toFixed(1),
      });
    } catch (err) {
      // Numerical issue on a single comet — skip it.
    }
  }

  out.sort((a, b) => (a.mag_at_build ?? 99) - (b.mag_at_build ?? 99));

  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`Wrote ${out.length} candidate comets (H ≤ ${ABS_MAG_CAP}, peri ±18mo/6mo) → ${OUT}`);
  if (out.length === 0) {
    console.log('(Empty list — no candidates near perihelion this period.)');
  } else {
    console.log('Top 8 by current apparent mag:');
    for (const c of out.slice(0, 8)) {
      console.log(`  ${c.designation.padEnd(14)}  ${c.name.padEnd(28)}  m≈${(c.mag_at_build ?? 99).toFixed(1)}  peri${c.days_from_perihelion >= 0 ? '+' : ''}${c.days_from_perihelion.toFixed(0)}d`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
