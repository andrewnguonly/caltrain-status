const DATA_FILES = {
  current: "data/current-status.json",
  incidentsIndex: "data/incidents/index.json",
};

const REFRESH_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ui = {
  statusHeadline: document.getElementById("statusHeadline"),
  overallPill: document.getElementById("overallPill"),
  lastRefreshed: document.getElementById("lastRefreshed"),
  uptime24h: document.getElementById("uptime24h"),
  uptime30d: document.getElementById("uptime30d"),
  uptime90d: document.getElementById("uptime90d"),
  uptimeChart: document.getElementById("uptimeChart"),
  dayStrip: document.getElementById("dayStrip"),
  incidentTimeline: document.getElementById("incidentTimeline"),
};

function cacheBust(url) {
  return `${url}?t=${Date.now()}`;
}

async function fetchJson(url) {
  const response = await fetch(cacheBust(url), { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch ${url}`);
  return response.json();
}

function mergeIncidentSeries(seriesFiles) {
  const items = [];

  for (const file of seriesFiles) {
    const fileItems = Array.isArray(file?.items)
      ? file.items
      : file?.incident && file.incident.id
        ? [file.incident]
        : file?.id
          ? [file]
          : [];

    items.push(...fileItems.filter(Boolean));
  }

  return {
    items: items.sort((a, b) => new Date(incidentSortTimestamp(b)) - new Date(incidentSortTimestamp(a))),
  };
}

async function fetchIncidentSeries(current) {
  const currentPaths = (current.incident_file_paths || [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter(Boolean);

  let manifestPaths = [];
  try {
    const manifest = await fetchJson(DATA_FILES.incidentsIndex);
    manifestPaths = (manifest.files || [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.path))
      .filter(Boolean);
  } catch {
    // Optional legacy manifest; current-status append-only file list is preferred.
  }

  const files = Array.from(new Set([...currentPaths, ...manifestPaths]));
  if (!files.length) return { items: [] };

  const loaded = await Promise.all(
    files.map(async (path) => {
      try {
        return await fetchJson(path);
      } catch (error) {
        console.warn(`Failed to load incident file: ${path}`, error);
        return null;
      }
    })
  );
  return mergeIncidentSeries(loaded.filter(Boolean));
}

function formatLocal(iso, options = {}) {
  if (!iso) return "--";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  });
}

function statusLabel(status) {
  const map = {
    operational: "Operational",
    minor: "Minor Delays",
    degraded: "Degraded Service",
    major: "Major Disruption",
    critical: "Service Outage",
  };
  return map[status] || "Unknown";
}

function pillClass(status) {
  const normalized = ["operational", "minor", "degraded", "major", "critical"].includes(status)
    ? status
    : "loading";
  return `status-pill status-pill--${normalized}`;
}

function percent(value) {
  return `${Number(value).toFixed(2)}%`;
}

function uptimeBandForPercent(value) {
  const n = Number(value);
  if (n >= 98) return "operational";
  if (n >= 95) return "degraded";
  return "major";
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function incidentSortTimestamp(incident) {
  return (
    incident?.version_created_at ||
    incident?.updated_at ||
    incident?.updates?.at?.(-1)?.timestamp ||
    incident?.started_at ||
    ""
  );
}

function normalizeSeverity(value) {
  if (!value) return "operational";
  if (value === "degraded") return "degraded";
  if (value === "minor") return "minor";
  if (value === "major") return "major";
  if (value === "critical") return "critical";
  if (value === "identified" || value === "investigating" || value === "monitoring") return "degraded";
  if (value === "resolved") return "operational";
  return "degraded";
}

function parseDelayMinutes(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+)\s*(?:min|mins|minute|minutes)\b/i);
  return match ? Number(match[1]) : null;
}

function severityForIncident(incident) {
  const title = String(incident?.title || "").toLowerCase();
  const summary = String(incident?.summary || "").toLowerCase();
  const updateMessages = (incident?.updates || [])
    .map((update) => String(update?.message || "").toLowerCase())
    .join(" ");
  const haystack = `${title} ${summary} ${updateMessages}`;

  if (/\bcancel(?:ed|led|lation)?\b/i.test(haystack)) return "critical";
  if (haystack.includes("platform change")) return "operational";

  const delayMinutes =
    parseDelayMinutes(title) ?? parseDelayMinutes(summary) ?? parseDelayMinutes(updateMessages);
  if (delayMinutes !== null) {
    if (delayMinutes >= 30) return "major";
    return "minor";
  }

  return normalizeSeverity(incident?.severity);
}

function buildOutageSegments(incidents, referenceNow) {
  const segments = [];

  for (const incident of incidents.items || []) {
    const incidentSeverity = severityForIncident(incident);
    if (incidentSeverity === "operational") continue;

    const startedAt = parseDate(incident.started_at);
    if (!startedAt) continue;

    const resolvedAt = parseDate(incident.resolved_at);
    const incidentEnd = resolvedAt || referenceNow;
    if (incidentEnd <= startedAt) continue;

    segments.push({ start: startedAt, end: incidentEnd, severity: incidentSeverity });
  }

  return segments;
}

function clippedSegments(segments, windowStart, windowEnd) {
  return segments
    .map((segment) => {
      const start = Math.max(segment.start.getTime(), windowStart.getTime());
      const end = Math.min(segment.end.getTime(), windowEnd.getTime());
      if (end <= start) return null;
      return { start, end, severity: segment.severity };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function mergedDowntimeBuckets(segments, windowStart, windowEnd) {
  const clipped = clippedSegments(segments, windowStart, windowEnd);
  if (!clipped.length) return 0;

  const occupiedBuckets = new Set();
  for (const segment of clipped) {
    const startBucket = Math.floor(segment.start / 60_000);
    const endExclusiveBucket = Math.ceil(segment.end / 60_000);
    for (let bucket = startBucket; bucket < endExclusiveBucket; bucket += 1) {
      occupiedBuckets.add(bucket);
    }
  }

  return occupiedBuckets.size;
}

function uptimeForWindow(segments, windowStart, windowEnd) {
  const denominator =
    Math.ceil(windowEnd.getTime() / 60_000) - Math.floor(windowStart.getTime() / 60_000);
  if (denominator <= 0) return 100;
  const downtime = mergedDowntimeBuckets(segments, windowStart, windowEnd);
  return Math.max(0, Math.min(100, ((denominator - downtime) / denominator) * 100));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function formatMonthYearShort(date) {
  const month = date.toLocaleString([], { month: "short" });
  const year = String(date.getFullYear()).slice(-2);
  return `${month} '${year}`;
}

function computeUptimeFromIncidents(incidents, current) {
  const referenceNow = new Date();
  const segments = buildOutageSegments(incidents, referenceNow);
  const completedDayBoundary = startOfDay(referenceNow);

  const summary = {
    last24h: uptimeForWindow(segments, new Date(referenceNow.getTime() - DAY_MS), referenceNow),
    last30d: uptimeForWindow(segments, new Date(referenceNow.getTime() - 30 * DAY_MS), referenceNow),
    last90d: uptimeForWindow(segments, new Date(referenceNow.getTime() - 90 * DAY_MS), referenceNow),
  };

  const monthly = [];
  const currentMonthStart = startOfMonth(referenceNow);
  for (let offset = 0; offset >= -11; offset -= 1) {
    const monthStart = addMonths(currentMonthStart, offset);
    const monthEnd = addMonths(monthStart, 1);
    const effectiveMonthEnd = monthEnd > completedDayBoundary ? completedDayBoundary : monthEnd;
    monthly.push({
      month: formatMonthYearShort(monthStart),
      uptime_percent: uptimeForWindow(segments, monthStart, effectiveMonthEnd),
    });
  }

  const recent_days = [];
  for (let offset = -29; offset <= 0; offset += 1) {
    const dayStart = addDays(completedDayBoundary, offset);
    const dayEnd = addDays(dayStart, 1);
    const dayUptime = uptimeForWindow(segments, dayStart, dayEnd);
    recent_days.push({
      date: dayStart.toISOString().slice(0, 10),
      uptime_percent: dayUptime,
      uptime_band: uptimeBandForPercent(dayUptime),
    });
  }

  return {
    generated_at: referenceNow.toISOString(),
    summary,
    monthly,
    recent_days,
  };
}

function renderCurrentStatus(current) {
  ui.statusHeadline.classList.remove("loading");
  ui.statusHeadline.textContent = current.status_message || "No status message";

  ui.overallPill.className = pillClass(current.overall_status);
  ui.overallPill.textContent = statusLabel(current.overall_status);
}

function renderUptime(uptime) {
  ui.uptime24h.textContent = percent(uptime.summary.last24h);
  ui.uptime30d.textContent = percent(uptime.summary.last30d);
  ui.uptime90d.textContent = percent(uptime.summary.last90d);

  ui.uptimeChart.classList.remove("loading-chart");
  ui.uptimeChart.innerHTML = "";
  uptime.monthly.forEach((row) => {
    const wrapper = document.createElement("div");
    wrapper.className = "chart-row";

    const label = document.createElement("span");
    label.className = "chart-label mono";
    label.textContent = row.month;

    const track = document.createElement("div");
    track.className = "chart-track";

    const fill = document.createElement("div");
    fill.className = `chart-fill chart-fill--${uptimeBandForPercent(row.uptime_percent)}`;
    fill.style.width = `${Math.max(0, Math.min(100, Number(row.uptime_percent)))}%`;
    fill.title = `${row.month}: ${percent(row.uptime_percent)}`;
    track.appendChild(fill);

    const value = document.createElement("span");
    value.className = "chart-value mono";
    value.textContent = percent(row.uptime_percent);

    wrapper.append(label, track, value);
    ui.uptimeChart.appendChild(wrapper);
  });

  ui.dayStrip.innerHTML = "";
  uptime.recent_days.forEach((day) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `day-cell day-${day.uptime_band}`;
    cell.setAttribute(
      "data-label",
      `${day.date}: ${percent(day.uptime_percent)}`
    );
    cell.setAttribute(
      "aria-label",
      `${day.date}: ${percent(day.uptime_percent)}`
    );
    ui.dayStrip.appendChild(cell);
  });
}

function timelineIncidentsForDisplay(incidents, current) {
  const referenceDate = parseDate(current?.as_of) || new Date();
  const base = (incidents.items || [])
    .filter((incident) => {
      const timestamp = parseDate(incidentSortTimestamp(incident)) || parseDate(incident?.started_at);
      return timestamp ? isSameLocalDay(timestamp, referenceDate) : false;
    })
    .slice()
    .sort((a, b) => new Date(incidentSortTimestamp(b)) - new Date(incidentSortTimestamp(a)));
  const activeIds = Array.isArray(current?.active_incident_ids) ? current.active_incident_ids : [];
  if (!activeIds.length) return base;

  const byId = new Map();
  for (const incident of base) {
    if (!incident?.id) continue;
    if (!byId.has(incident.id)) byId.set(incident.id, []);
    byId.get(incident.id).push(incident);
  }

  const latestById = new Map();
  for (const incident of base) {
    if (!incident?.id) continue;
    if (!latestById.has(incident.id)) latestById.set(incident.id, incident);
  }

  const expanded = [];
  for (const id of activeIds) {
    const queue = byId.get(id);
    if (queue?.length) {
      expanded.push(queue.shift());
      continue;
    }
    const fallback = latestById.get(id);
    if (fallback) expanded.push(fallback);
  }

  return (expanded.length ? expanded : base).sort(
    (a, b) => new Date(incidentSortTimestamp(b)) - new Date(incidentSortTimestamp(a))
  );
}

function renderTimeline(incidents, current) {
  ui.incidentTimeline.innerHTML = "";

  const sorted = timelineIncidentsForDisplay(incidents, current);

  sorted.forEach((incident) => {
    const item = document.createElement("li");
    item.className = "timeline-item";
    const displaySeverity = severityForIncident(incident);
    const incidentStatus = String(incident.status || "").trim().toLowerCase();

    const resolvedText = incident.resolved_at
      ? `Resolved ${formatLocal(incident.resolved_at)}`
      : `Ongoing since ${formatLocal(incident.started_at)}`;
    const metaParts = [capitalize(displaySeverity)];
    if (incidentStatus && incidentStatus !== "resolved") {
      metaParts.push(escapeHtml(incident.status));
    }
    metaParts.push(resolvedText);

    item.innerHTML = `
      <span class="timeline-dot severity-${displaySeverity}" aria-hidden="true"></span>
      <div>
        <p class="timeline-title">${escapeHtml(incident.title)}</p>
        <p class="timeline-meta">${metaParts.join(" · ")}</p>
        <p class="timeline-desc">${escapeHtml(incident.summary)}</p>
      </div>
    `;
    ui.incidentTimeline.appendChild(item);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function capitalize(value) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderRefreshTime() {
  ui.lastRefreshed.textContent = `Last refresh: ${new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

function renderError(error) {
  console.error(error);
  ui.statusHeadline.classList.remove("loading");
  ui.statusHeadline.textContent =
    "Unable to load status data. Check data files or local server configuration.";
  ui.overallPill.className = "status-pill status-pill--major";
  ui.overallPill.textContent = "Data Error";
}

async function loadAndRender() {
  try {
    const current = await fetchJson(DATA_FILES.current);
    const incidents = await fetchIncidentSeries(current);
    const uptime = computeUptimeFromIncidents(incidents, current);

    renderCurrentStatus(current);
    renderUptime(uptime);
    renderTimeline(incidents, current);
    renderRefreshTime();
  } catch (error) {
    renderError(error);
  }
}

loadAndRender();
setInterval(loadAndRender, REFRESH_MS);
