#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const CURRENT_STATUS_PATH = path.join(DATA_DIR, "current-status.json");
const INCIDENTS_INDEX_PATH = path.join(DATA_DIR, "incidents", "index.json");
const INGESTION_STATE_PATH = path.join(DATA_DIR, "ingestion-state.json");

function parseDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

parseDotEnvFile(path.join(ROOT, ".env"));

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function loadState() {
  return readJson(INGESTION_STATE_PATH, {
    processed_message_ids: [],
    last_run_at: null,
  });
}

function saveState(state) {
  state.last_run_at = new Date().toISOString();
  state.processed_message_ids = Array.from(new Set(state.processed_message_ids)).slice(-5000);
  writeJson(INGESTION_STATE_PATH, state);
}

function normalizeSubject(subject) {
  return String(subject || "")
    .replace(/^\s*(fwd?|fw|re)\s*:\s*/i, "")
    .replace(/\bcaltrain\b/gi, "")
    .replace(/\b(alert|advisory|service update|notification)\b/gi, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "email-alert";
}

function firstNonEmptyLine(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function summarizeBody(text) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "Email alert received; parser placeholder used.";
  return oneLine.slice(0, 300);
}

function inferSeverityAndStatus(subject, bodyText) {
  const haystack = `${subject}\n${bodyText}`.toLowerCase();
  const has = (pattern) => pattern.test(haystack);

  const resolved = has(/\b(resolved|restored|normal service|back to normal|clear(ed)?)\b/);
  if (resolved) {
    return { severity: "minor", status: "resolved", updateState: "operational" };
  }
  if (has(/\b(no service|service suspended|all trains stopped|shutdown)\b/)) {
    return { severity: "critical", status: "investigating", updateState: "critical" };
  }
  if (has(/\b(major disruption|disabled train|signal issue|police activity|single-track)\b/)) {
    return { severity: "major", status: "investigating", updateState: "major" };
  }
  if (has(/\b(delay|delays|late|reduced speed|inspection|holding)\b/)) {
    return { severity: "minor", status: "investigating", updateState: "degraded" };
  }
  return { severity: "minor", status: "investigating", updateState: "degraded" };
}

function inferAffectedSegments(subject, bodyText) {
  const haystack = `${subject}\n${bodyText}`.toLowerCase();
  const segments = [];
  if (haystack.includes("northbound")) segments.push("Northbound");
  if (haystack.includes("southbound")) segments.push("Southbound");
  if (haystack.includes("both directions")) {
    if (!segments.includes("Northbound")) segments.push("Northbound");
    if (!segments.includes("Southbound")) segments.push("Southbound");
  }
  if (!segments.length) segments.push("System-wide");
  return segments;
}

function buildParsedEvent(message) {
  const subject = message.subject || "(No subject)";
  const bodyText = message.bodyText || "";
  const receivedAt = message.receivedAt || new Date().toISOString();
  const normalizedSubject = normalizeSubject(subject);
  const subjectKey = slugify(normalizedSubject || subject);
  const headline = normalizedSubject || firstNonEmptyLine(bodyText) || "Caltrain service alert";
  const severityInfo = inferSeverityAndStatus(subject, bodyText);
  const summary = summarizeBody(bodyText);

  return {
    messageId: message.messageId,
    receivedAt,
    subject,
    bodyText,
    subjectKey,
    title: headline.charAt(0).toUpperCase() + headline.slice(1),
    summary,
    severity: severityInfo.severity,
    incidentStatus: severityInfo.status,
    updateState: severityInfo.updateState,
    affectedSegments: inferAffectedSegments(subject, bodyText),
    updateMessage: firstNonEmptyLine(bodyText) || subject,
  };
}

function loadIncidentsIndex() {
  return readJson(INCIDENTS_INDEX_PATH, { files: [] });
}

function saveIncidentsIndex(index) {
  const unique = Array.from(new Set(index.files || []));
  index.files = unique.sort().reverse();
  writeJson(INCIDENTS_INDEX_PATH, index);
}

function getShardPathForDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return path.join(DATA_DIR, "incidents", `${year}-${month}`, "incidents.json");
}

function getShardRepoPathForDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `data/incidents/${year}-${month}/incidents.json`;
}

function loadShard(filePath, period) {
  return readJson(filePath, { period, items: [] });
}

function saveShard(filePath, shard) {
  shard.items = (shard.items || []).sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  writeJson(filePath, shard);
}

function createIncidentId(date, subjectKey, existingIds) {
  const day = date.toISOString().slice(0, 10);
  let base = `inc-${day}-${subjectKey}`;
  if (!existingIds.has(base)) return base;
  let counter = 2;
  while (existingIds.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

function severityRank(severity) {
  return { operational: 0, minor: 1, degraded: 1, major: 2, critical: 3 }[severity] ?? 0;
}

function findMatchingIncident(shard, event) {
  const candidates = (shard.items || []).filter(
    (incident) =>
      incident.ingestion_key === event.subjectKey ||
      normalizeSubject(incident.title) === normalizeSubject(event.title)
  );

  if (!candidates.length) return null;

  candidates.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  if (event.incidentStatus === "resolved") {
    return candidates.find((i) => i.status !== "resolved") || candidates[0];
  }

  return candidates.find((i) => i.status !== "resolved") || candidates[0];
}

function upsertIncidentInShard(shard, event) {
  shard.items = shard.items || [];

  const existingIds = new Set(shard.items.map((i) => i.id));
  let incident = findMatchingIncident(shard, event);
  const timestamp = new Date(event.receivedAt).toISOString();

  if (!incident) {
    const startedDate = new Date(event.receivedAt);
    incident = {
      id: createIncidentId(startedDate, event.subjectKey, existingIds),
      title: event.title,
      severity: event.severity,
      status: event.incidentStatus,
      started_at: timestamp,
      resolved_at: event.incidentStatus === "resolved" ? timestamp : null,
      affected_segments: event.affectedSegments,
      summary: event.summary,
      updates: [],
      ingestion_key: event.subjectKey
    };
    shard.items.push(incident);
  } else {
    incident.title = incident.title || event.title;
    incident.affected_segments = Array.from(
      new Set([...(incident.affected_segments || []), ...event.affectedSegments])
    );
    incident.summary = event.summary || incident.summary;
    if (severityRank(event.severity) > severityRank(incident.severity)) {
      incident.severity = event.severity;
    }
    if (event.incidentStatus === "resolved") {
      incident.status = "resolved";
      incident.resolved_at = timestamp;
    } else if (incident.status === "resolved") {
      incident.status = "investigating";
      incident.resolved_at = null;
    } else {
      incident.status = event.incidentStatus || incident.status;
    }
  }

  incident.updates = incident.updates || [];
  const alreadyHasMessage = incident.updates.some((u) => u.source_message_id === event.messageId);
  if (!alreadyHasMessage) {
    incident.updates.push({
      timestamp,
      state: event.updateState,
      message: event.updateMessage,
      source_message_id: event.messageId
    });
    incident.updates.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  return incident;
}

function collectAllIncidents(index) {
  const items = [];
  for (const repoPath of index.files || []) {
    const absPath = path.join(ROOT, repoPath);
    const shard = readJson(absPath, { items: [] });
    for (const incident of shard.items || []) items.push(incident);
  }
  items.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  return { items };
}

function updateCurrentStatusFile(processedAtIso) {
  const current = readJson(CURRENT_STATUS_PATH, {
    service_name: "Caltrain",
    overall_status: "operational",
    status_message: "No active incidents.",
    updated_at: processedAtIso,
    active_incident_ids: []
  });
  const index = loadIncidentsIndex();
  const incidents = collectAllIncidents(index);
  const active = incidents.items.filter((i) => i.status !== "resolved");

  active.sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    return new Date(b.started_at) - new Date(a.started_at);
  });

  let overallStatus = "operational";
  if (active.length) {
    const top = active[0];
    if (top.severity === "critical") overallStatus = "critical";
    else if (top.severity === "major") overallStatus = "major";
    else overallStatus = "degraded";
    current.status_message = top.summary || top.title;
  } else {
    current.status_message = "No active incidents. Trains are currently running under normal operations.";
  }

  current.service_name = current.service_name || "Caltrain";
  current.overall_status = overallStatus;
  current.updated_at = processedAtIso;
  current.active_incident_ids = active.map((i) => i.id);

  writeJson(CURRENT_STATUS_PATH, current);
}

function applyEventToRepo(event) {
  const eventDate = new Date(event.receivedAt);
  const period = eventDate.toISOString().slice(0, 7);
  const shardAbsPath = getShardPathForDate(eventDate);
  const shardRepoPath = getShardRepoPathForDate(eventDate);

  const index = loadIncidentsIndex();
  if (!(index.files || []).includes(shardRepoPath)) {
    index.files = [...(index.files || []), shardRepoPath];
    saveIncidentsIndex(index);
  }

  const shard = loadShard(shardAbsPath, period);
  shard.period = period;
  const incident = upsertIncidentInShard(shard, event);
  saveShard(shardAbsPath, shard);
  return incident;
}

function envBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function passesFilters(parsed) {
  const fromMatch = (process.env.INGEST_FROM_MATCH || "").trim().toLowerCase();
  const subjectMatch = (process.env.INGEST_SUBJECT_MATCH || "").trim().toLowerCase();
  const from = String(parsed.from?.text || "").toLowerCase();
  const subject = String(parsed.subject || "").toLowerCase();

  if (fromMatch && !from.includes(fromMatch)) return false;
  if (subjectMatch && !subject.includes(subjectMatch)) return false;
  return true;
}

async function main() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD. Set them in env or .env.");
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  const state = loadState();
  const processedIds = new Set(state.processed_message_ids || []);
  const markSeen = envBool("IMAP_MARK_SEEN", true);

  let processedCount = 0;
  let changed = false;

  await client.connect();
  try {
    await client.mailboxOpen(process.env.IMAP_MAILBOX || "INBOX");
    const uids = await client.search({ seen: false });
    if (!uids.length) {
      console.log("No unseen emails.");
      saveState(state);
      return;
    }

    for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true, internalDate: true })) {
      const parsed = await simpleParser(msg.source);
      const messageId = parsed.messageId || `uid-${msg.uid}`;
      if (processedIds.has(messageId)) {
        if (markSeen) await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
        continue;
      }

      if (!passesFilters(parsed)) {
        console.log(`Skipping email (filter): ${parsed.subject || "(No subject)"}`);
        processedIds.add(messageId);
        state.processed_message_ids.push(messageId);
        if (markSeen) await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
        continue;
      }

      const event = buildParsedEvent({
        messageId,
        subject: parsed.subject || "",
        bodyText: parsed.text || parsed.html || "",
        receivedAt: parsed.date ? new Date(parsed.date).toISOString() : new Date(msg.internalDate).toISOString()
      });

      const incident = applyEventToRepo(event);
      console.log(`Processed ${messageId} -> ${incident.id}`);

      processedIds.add(messageId);
      state.processed_message_ids.push(messageId);
      processedCount += 1;
      changed = true;

      if (markSeen) {
        await client.messageFlagsAdd(msg.uid, ["\\Seen"]);
      }
    }

    if (changed) {
      updateCurrentStatusFile(new Date().toISOString());
    }
    saveState(state);
    console.log(`Done. processed=${processedCount}`);
  } finally {
    await client.logout();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
