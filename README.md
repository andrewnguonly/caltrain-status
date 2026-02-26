# Caltrain Status Page

Simple status-page style site for [Caltrain](https://www.caltrain.com/) service uptime and incidents. Alerts and notifications are received from Caltrain real-time email alerts.

This project is inspired by...
- [The Missing GitHub Status Page](https://mrshu.github.io/github-statuses/)
- My own experience taking the Caltrain
- And the current era of "vibe coding"

This codebase is completely vibe coded using GPT-5.3-Codex with small modifications from me.

## What this is

- Static frontend (`index.html`, `styles.css`, `app.js`)
- File-based "backend" (`data/*.json`)
- Designed to work on GitHub Pages (no server required)

## Current data model

- `data/current-status.json`
  - Current overall status (`operational`, `degraded`, `major`, `critical`)
  - Current banner message
  - Active incident IDs
  - `incident_file_paths` list (append-only incident snapshot files to load)
- `data/incidents/index.json`
  - Legacy manifest of incident files (still supported as fallback)
- `data/incidents/YYYY-MM/incidents.json`
  - Legacy incident history shard format (still supported)
- `data/incidents/events/YYYY/MM/DD/*.json`
  - Append-only incident snapshot files (new production ingestion format)

Uptime values shown on the page are computed dynamically in `app.js` from incident files referenced by `data/current-status.json` (`incident_file_paths`), with fallback support for `data/incidents/index.json`.

## How it works

1. Browser loads the static page.
2. `app.js` fetches `data/current-status.json`.
3. It loads incident data files from `current-status.json.incident_file_paths` (append-only snapshots).
4. It also supports legacy files from `data/incidents/index.json` (fallback/compatibility).
5. The page renders:
   - current status
   - uptime percentages (computed from incidents)
   - incident details
   - incident history
   - email alert template placeholder
6. The page polls every 60 seconds to refresh.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. Enable GitHub Pages for the repository (branch deploy).
3. Serve from the repo root.

## Production ingestion (Python, IMAP/Gmail)

Production ingestion is handled by:

- `scripts/ingest_emails_imap.py`

This script:

- Connects to Gmail via IMAP
- Reads alert emails
- Parses Caltrain alert fields (subject type, cause/effect, start/end dates)
- Writes a new append-only incident snapshot file per processed email
- Updates `data/current-status.json` (the only file intentionally overwritten)
- Marks processed emails as `\Seen` (when enabled)

### Append-only pipeline design

- Append-only:
  - `data/incidents/events/YYYY/MM/DD/*.json`
- Overwritten current state:
  - `data/current-status.json`

Each new email produces a new immutable incident snapshot file. The current status file maintains `incident_file_paths`, which acts as the list of snapshot files the frontend should load.

This avoids rewriting historical incident files while still allowing the site to compute the latest incident state and uptime.

## IMAP/Gmail ingestion (Python)

This repo includes Python scripts for Gmail IMAP access:

- Production ingester: `scripts/ingest_emails_imap.py`
- Fetch/debug helper: `scripts/fetch_emails_imap.py`

### Setup (Gmail)

1. Create a dedicated Gmail inbox (recommended).
2. Enable 2-Step Verification on that Google account.
3. Create a Gmail App Password.
4. Copy `.env.example` to `.env` and fill in:
   - `GMAIL_USER`
   - `GMAIL_APP_PASSWORD`
5. (Recommended) Set filters:
   - `INGEST_FROM_MATCH`
   - `INGEST_SUBJECT_MATCH`

### What the script updates

- `data/incidents/events/YYYY/MM/DD/*.json` (append-only incident snapshots)
- `data/current-status.json` (recomputes active incident summary and updates `incident_file_paths`)
- `data/ingestion-state.json` (optional local dedupe state; gitignored)

### Commands

- Production ingest (writes JSON files): `python3 scripts/ingest_emails_imap.py`
- Fetch/debug only (prints emails): `python3 scripts/fetch_emails_imap.py`

### Notes

- The parser is heuristic and tuned to the sample Caltrain alert format currently in the repo.
- The workflow uses IMAP `UNSEEN` + marking messages `\Seen` as the primary dedupe mechanism in GitHub Actions.
- `data/incidents/index.json` and monthly shard files remain supported as a legacy fallback source.

## Local preview

Because the page fetches JSON/text files, open it through a local web server (not `file://`).

Examples:

- `python3 -m http.server`
- `npx serve .`
