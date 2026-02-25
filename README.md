# Caltrain Status Page (Static Prototype)

Simple status-page style site for Caltrain service uptime and incidents.

## What this is

- Static frontend (`index.html`, `styles.css`, `app.js`)
- File-based "backend" (`data/*.json` and `data/alert-template.txt`)
- Designed to work on GitHub Pages (no server required)

## Current data model

- `data/current-status.json`
  - Current overall status (`operational`, `degraded`, `major`, `critical`)
  - Current banner message
  - Active incident IDs
- `data/incidents/index.json`
  - Manifest of incident time-series shard files
- `data/incidents/YYYY-MM/incidents.json`
  - Incident history for a month (append-only shard)
- `data/alert-template.txt`
  - Placeholder email alert format until real notification content is known

Uptime values shown on the page are computed dynamically in `app.js` from all incident shard files listed in `data/incidents/index.json`.

## How it works (simple architecture)

1. Browser loads the static page.
2. `app.js` fetches `data/current-status.json`, `data/incidents/index.json`, and the listed incident shard files.
3. The page renders:
   - current status
   - uptime percentages (computed from incidents)
   - incident details
   - incident history
   - email alert template placeholder
4. The page polls every 60 seconds to refresh.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. Enable GitHub Pages for the repository (branch deploy).
3. Serve from the repo root.

## Future upgrade path (when email details are available)

- Add a small parser script (or GitHub Action) that converts incoming alerts to:
  - `data/current-status.json`
  - `data/incidents/YYYY-MM/incidents.json` (append new records to the current month shard)
  - `data/incidents/index.json` (only when creating a new shard)
- Keep the frontend unchanged.

## IMAP/Gmail ingestion (implemented)

This repo includes a polling script that reads a dedicated Gmail inbox via IMAP and updates the data files.

- Script: `scripts/ingest_emails_imap.js`
- Command: `npm run ingest:imap`
- Dependencies: `imapflow`, `mailparser`

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

- `data/incidents/YYYY-MM/incidents.json` (append/update incident shards)
- `data/incidents/index.json` (adds new shard paths)
- `data/current-status.json` (recomputes active incident summary)
- `data/ingestion-state.json` (local dedupe state; gitignored)

### Notes

- The parser is intentionally heuristic because the Caltrain email format is not finalized yet.
- It stores one update per email and tries to match/update incidents by normalized subject.
- Once you have the exact email format, tighten `buildParsedEvent()` parsing rules in `scripts/ingest_emails_imap.js`.

### Local parser test mode (no IMAP)

Parse a raw email file and print the parsed event JSON without connecting to Gmail or writing repo data:

- Default example file: `data/alert-example.txt`
- Run: `npm run ingest:imap:test`

Optional custom file:

- `node scripts/ingest_emails_imap.js --local-test --test-file path/to/email.eml`

## Local preview

Because the page fetches JSON/text files, open it through a local web server (not `file://`).

Examples:

- `python3 -m http.server`
- `npx serve .`
