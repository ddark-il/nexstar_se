# NexStar SE Companion

A static, mobile-first web app that plans one observing/imaging session with a Celestron NexStar SE telescope, end-to-end. Two screens, no backend, no login, no tracking.

**Setup screen** collects everything the scope and second camera need:
- Location (GPS, decimal lat/lon, or city via Nominatim)
- NexStar+ HC entry block — Lon/Lat in DMS, Date/Time, Time Zone (integer GMT band), DST flag — formatted exactly as the controller wants it
- 5 SkyAlign star suggestions (the controller uses 3; we hand you 2 spares for trees/buildings)
- **Primary telescope** — pick the model (4SE 102 mm / 5SE 125 mm / **6SE 150 mm** default / 8SE 203 mm), the sensor (APS-C / Full Frame), and the focal config (native f-ratio or with the 0.63× reducer where applicable)
- **Secondary camera** — for the off-scope wide-field shot. Sensor (APS-C / Full Frame), aperture, focal length. Defaults to a 28 mm f/1.7 full-frame fixed-lens body.

**Tonight screen** computes everything for the next astronomical-dark window:
- Sunset → sunrise span, with astronomical dusk/dawn boundaries
- Cloud cover bar across the night + min/median/max + temperature trend + dew-point spread (Open-Meteo)
- Light pollution zone at your coordinates (D. Lorenz / VIIRS 2024)
- Target list grouped by **Planets · Moon · Comets · Clusters · Nebulae** sub-tabs
- Each target gets:
  - An altitude graph spanning the night, with twilight gradient zones (purple at the edges, dark navy in the middle of full astronomical dark)
  - Hour-of-night ticks inside the plot
  - Peak altitude + compass direction + best-shot time in the meta line
  - **Dual exposure recipes**: a **SCOPE** chip (through the telescope) and a **LENS** chip (off-scope on the secondary camera). Either may be omitted when not meaningful (Milky Way has only a LENS recipe; planets only a SCOPE recipe; etc.)
  - 🎨 marker on the ~25 visually-striking targets (M42, M45, Veil, Pillars, Trifid, M27, M57, Double Cluster, etc.)
  - "Twilight only" badge on planets that peak during civil/nautical twilight
  - "Tail likely" badge on comets at apparent mag ≤ 5

### What the recipe math accounts for

Every single-shot exposure recommendation is *brightness-aware* and *site-aware* — not a fixed cheat-sheet:

| Factor | Effect |
|---|---|
| Target magnitude | Pogson 2.512× scaling per mag step (per type baseline) |
| f-ratio | (fRatio/f-ref)² light-gathering scaling |
| Sensor pixel pitch | Field-rotation tolerance derived from corner-pixel count |
| Alt-az field rotation | Per-sample cap; algorithm finds the best altitude where rotation allows the ideal exposure |
| Light pollution | Per-type magnitude caps tighten; sky-saturation shutter ceiling |
| Moon brightness | Phase × avg(sin(alt)) penalty subtracted from effective SQM |
| Atmospheric extinction | Kasten-Young airmass × 0.20 mag/airmass at the best alt |
| ISO bump on clamp | When rotation forces a shorter shutter, ISO climbs (capped at 2 stops / ISO 6400) |
| 500-rule (wide lens) | Trackless max exposure derived from lens focal length + sensor crop factor |

So the same target — say M42 — gets very different recipes at Mitzpe Ramon (Bortle 1) vs. Tel Aviv (Bortle 6), and the wide-lens recipe scales correctly between f/2 and f/4.

### What gets filtered out

A target appears only if it can plausibly be captured in **one single sub-exposure** (no stacking, no mosaic, no wedge):
- Fits the chosen sensor's frame at the chosen f-ratio
- Bright enough that single-shot detail beats sky noise (per-type mag cap, LP-tightened)
- Reaches a viable altitude during the dark window
- Field-rotation cap at that altitude allows ≥ 20% of the ideal exposure

Wide-field targets that don't fit the scope frame (M31, M33, M42, M44, M45) appear with a `WIDE-FIELD` chip and the **lens** recipe as primary + a **scope reference** recipe showing what you'd get pointed at just the core / brightest portion.

---

## Run locally

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/>. Geolocation requires a secure context — `http://localhost` qualifies; `file://` does not.

## Deploy

It's a static site — drop the repo root onto GitHub Pages, Cloudflare Pages, Netlify, Vercel, S3, or any HTTP server. The runtime fetches the two JSON files from `data/` (relative URL) and pulls live data from:
- `astronomy.browser.min.js` from jsDelivr CDN
- `api.open-meteo.com` for weather
- `djlorenz.github.io` for the LP world map (single 99 KB PNG, cached for the session)
- `nominatim.openstreetmap.org` for city geocoding
- `www.minorplanetcenter.net` for live comet orbital elements (fallback if the cached `data/bright_comets.json` is older than 14 days)

No API keys needed.

## Refresh the cached data

Either run the build scripts by hand:

```bash
node scripts/build-dso.js       # → data/dso.json   (OpenNGC, filtered for single-frame use)
node scripts/build-comets.js    # → data/bright_comets.json   (MPC orbital elements)
```

Or rely on the GitHub Actions workflows that run them automatically:

| Workflow | Schedule | What it does |
|---|---|---|
| `.github/workflows/refresh-comets.yml` | Weekly, Sun 06:00 UTC | Rebuilds `data/bright_comets.json` from MPC's `Soft00Cmt.txt` |
| `.github/workflows/refresh-dso.yml` | Monthly, 1st 06:00 UTC | Rebuilds `data/dso.json` from OpenNGC |

Both workflows need `contents: write` on the repo (declared in the YAML).

## Project layout

```
.
├── index.html                       Single-file app (HTML + CSS + JS, ~70 KB)
├── data/
│   ├── dso.json                     Curated single-frame-friendly catalog (~27 KB)
│   └── bright_comets.json           ~120 comet candidates (H ≤ 13, peri ±18 mo / + 6 mo)
├── scripts/
│   ├── build-dso.js                 Rebuilds dso.json from OpenNGC CSV
│   └── build-comets.js              Rebuilds bright_comets.json from MPC Soft00Cmt.txt
├── .github/workflows/
│   ├── refresh-dso.yml              Monthly DSO catalog refresh
│   └── refresh-comets.yml           Weekly comet cache refresh
├── package.json                     (Empty — no npm deps; scripts use Node 20+ globals)
├── LICENSE                          CC BY-SA 4.0
└── README.md
```

## Tech stack

- **Vanilla HTML/CSS/JS** — no build step, no framework, no bundler.
- **[astronomy-engine](https://github.com/cosinekitty/astronomy)** (one CDN script tag) for Sun/Moon/planet positions, twilight times, alt/az transforms, and rise/set/transit search.
- **Custom Kepler propagator** (in `index.html` and mirrored in `scripts/build-comets.js`) for comets — solves elliptical (Newton-Raphson), parabolic (Barker), and hyperbolic branches from MPC orbital elements.
- **No build/bundling tooling required.** Node 20+ for the data-refresh scripts (uses built-in `fetch`).

## Design choices worth knowing

- **Single-frame, no-stacking workflow.** This is the realistic ceiling for any Celestron SE on its native alt-az fork. Targets that need stacking, longer integrations, or mosaics are deliberately excluded — the list you see is the list that actually works in one sub.
- **"No bright dot" filter.** A target with a useful single-shot photograph beats a target that's just barely detectable. Per-type magnitude caps drop entries that would render as featureless dots through a 6" SCT.
- **5 SkyAlign stars instead of 3.** SkyAlign needs 3; we list 5 in geometric-spread order so you have spares when one is blocked.
- **NexStar+ HC firmware quirks honored.** Integer GMT offsets only (no IANA, no half-hour zones — those get a warning). US zones named; everything else shown as `±N`. DST flag matches the controller's prompt strings exactly. Coordinates in `DDD MM SS` with no `°`/`'` glyphs (the LCD can't display them) and longitude *before* latitude (the order the HC asks for them).
- **Pre-session, not real-time.** The app is for planning a session and transcribing to the controller — not for tracking the scope or capturing images live.
- **No persistence.** Re-pick the focal reducer each session (it's a physical swap, not a setting to remember).

## Attributions

| Used for | Source | License |
|---|---|---|
| Sun/Moon/planet/star ephemeris | [cosinekitty/astronomy-engine](https://github.com/cosinekitty/astronomy) | MIT |
| Deep-sky object catalog | [mattiaverga/OpenNGC](https://github.com/mattiaverga/OpenNGC) | CC BY-SA 4.0 |
| Comet orbital elements | [Minor Planet Center](https://minorplanetcenter.net/) `Soft00Cmt.txt` | Public, with attribution |
| Weather data | [Open-Meteo](https://open-meteo.com/) | CC BY 4.0 |
| Light pollution atlas | [D. Lorenz VIIRS 2024](https://djlorenz.github.io/astronomy/lp/) | Free reuse with attribution |
| Geocoding | [Nominatim / OpenStreetMap](https://nominatim.org/) | ODbL |

## License

Released under the **Creative Commons Attribution-ShareAlike 4.0 International** license — see [`LICENSE`](LICENSE).

Choice of CC BY-SA matches OpenNGC's license (the largest single data dependency) so derivatives stay openly remixable. You're free to fork, modify, deploy, and redistribute — the only requirements are attribution and that derivatives carry the same license.
