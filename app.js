const DATA_FILES = {
  current: "data/current-status.json",
  incidentsIndex: "data/incidents/index.json",
};

const REFRESH_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SEVERITY_RANK = {
  operational: 0,
  minor: 1,
  degraded: 1,
  major: 2,
  critical: 3,
};

const ui = {
  statusHeadline: document.getElementById("statusHeadline"),
  overallPill: document.getElementById("overallPill"),
  lastRefreshed: document.getElementById("lastRefreshed"),
  uptime24h: document.getElementById("uptime24h"),
  uptime30d: document.getElementById("uptime30d"),
  uptime90d: document.getElementById("uptime90d"),
  uptimeChart: document.getElementById("uptimeChart"),
  dayStrip: document.getElementById("dayStrip"),
  activeIncident: document.getElementById("activeIncident"),
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
  const byId = new Map();

  for (const file of seriesFiles) {
    const items = Array.isArray(file?.items)
      ? file.items
      : file?.incident && file.incident.id
        ? [file.incident]
        : file?.id
          ? [file]
          : [];

    for (const incident of items) {
      if (!incident || !incident.id) continue;
      const existing = byId.get(incident.id);
      const existingTs =
        existing?.version_created_at ||
        existing?.updated_at ||
        existing?.updates?.at?.(-1)?.timestamp ||
        existing?.started_at ||
        "";
      const nextTs =
        incident?.version_created_at ||
        incident?.updated_at ||
        incident?.updates?.at?.(-1)?.timestamp ||
        incident?.started_at ||
        "";
      if (!existing || new Date(nextTs) >= new Date(existingTs)) {
        byId.set(incident.id, incident);
      }
    }
  }

  return {
    items: Array.from(byId.values()).sort((a, b) => new Date(b.started_at) - new Date(a.started_at)),
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
  const normalized = ["operational", "degraded", "major", "critical"].includes(status)
    ? status
    : "loading";
  return `status-pill status-pill--${normalized}`;
}

function percent(value) {
  return `${Number(value).toFixed(2)}%`;
}

function severityForUptimePercent(value) {
  const n = Number(value);
  if (n >= 99.95) return "operational";
  if (n >= 99.0) return "degraded";
  if (n >= 97.0) return "major";
  return "critical";
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function buildOutageSegments(incidents, referenceNow) {
  const segments = [];

  for (const incident of incidents.items || []) {
    const startedAt = parseDate(incident.started_at);
    if (!startedAt) continue;

    const resolvedAt = parseDate(incident.resolved_at);
    const incidentEnd = resolvedAt || referenceNow;
    if (incidentEnd <= startedAt) continue;

    const updates = (incident.updates || [])
      .map((update) => ({
        ...update,
        timestampDate: parseDate(update.timestamp),
        stateSeverity: normalizeSeverity(update.state),
      }))
      .filter((update) => update.timestampDate)
      .sort((a, b) => a.timestampDate - b.timestampDate);

    if (!updates.length) {
      const severity = normalizeSeverity(incident.severity);
      if (severity !== "operational") {
        segments.push({ start: startedAt, end: incidentEnd, severity });
      }
      continue;
    }

    for (let i = 0; i < updates.length; i += 1) {
      const currentUpdate = updates[i];
      const nextUpdate = updates[i + 1];
      const segStart = new Date(Math.max(startedAt.getTime(), currentUpdate.timestampDate.getTime()));
      const segEnd = new Date(
        Math.min(
          incidentEnd.getTime(),
          nextUpdate ? nextUpdate.timestampDate.getTime() : incidentEnd.getTime()
        )
      );
      if (segEnd <= segStart) continue;
      if (currentUpdate.stateSeverity === "operational") continue;
      segments.push({ start: segStart, end: segEnd, severity: currentUpdate.stateSeverity });
    }
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

function mergedDowntimeMs(segments, windowStart, windowEnd) {
  const clipped = clippedSegments(segments, windowStart, windowEnd);
  if (!clipped.length) return 0;

  let total = 0;
  let currentStart = clipped[0].start;
  let currentEnd = clipped[0].end;

  for (let i = 1; i < clipped.length; i += 1) {
    const segment = clipped[i];
    if (segment.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, segment.end);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = segment.start;
    currentEnd = segment.end;
  }

  total += currentEnd - currentStart;
  return total;
}

function maxSeverityForWindow(segments, windowStart, windowEnd) {
  let max = "operational";
  for (const segment of segments) {
    if (segment.end <= windowStart || segment.start >= windowEnd) continue;
    if ((SEVERITY_RANK[segment.severity] || 0) > (SEVERITY_RANK[max] || 0)) {
      max = segment.severity;
    }
  }
  return max;
}

function uptimeForWindow(segments, windowStart, windowEnd) {
  const denominator = windowEnd.getTime() - windowStart.getTime();
  if (denominator <= 0) return 100;
  const downtime = mergedDowntimeMs(segments, windowStart, windowEnd);
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
  const referenceNow = parseDate(current.updated_at) || new Date();
  const segments = buildOutageSegments(incidents, referenceNow);

  const summary = {
    last24h: uptimeForWindow(segments, new Date(referenceNow.getTime() - DAY_MS), referenceNow),
    last30d: uptimeForWindow(segments, new Date(referenceNow.getTime() - 30 * DAY_MS), referenceNow),
    last90d: uptimeForWindow(segments, new Date(referenceNow.getTime() - 90 * DAY_MS), referenceNow),
  };

  const monthly = [];
  const currentMonthStart = startOfMonth(referenceNow);
  for (let offset = 0; offset >= -11; offset -= 1) {
    const monthStart = addMonths(currentMonthStart, offset);
    const monthEndCandidate = addMonths(monthStart, 1);
    const monthEnd = monthEndCandidate > referenceNow ? referenceNow : monthEndCandidate;
    monthly.push({
      month: formatMonthYearShort(monthStart),
      uptime_percent: uptimeForWindow(segments, monthStart, monthEnd),
    });
  }

  const recent_days = [];
  const todayStart = startOfDay(referenceNow);
  for (let offset = -29; offset <= 0; offset += 1) {
    const dayStart = addDays(todayStart, offset);
    const dayEndCandidate = addDays(dayStart, 1);
    const dayEnd = dayEndCandidate > referenceNow ? referenceNow : dayEndCandidate;
    const daySeverity = maxSeverityForWindow(segments, dayStart, dayEnd);
    recent_days.push({
      date: dayStart.toISOString().slice(0, 10),
      uptime_percent: uptimeForWindow(segments, dayStart, dayEnd),
      severity: daySeverity === "minor" ? "degraded" : daySeverity,
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
    fill.className = `chart-fill chart-fill--${severityForUptimePercent(row.uptime_percent)}`;
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
    cell.className = `day-cell day-${day.severity}`;
    cell.setAttribute(
      "data-label",
      `${day.date}: ${percent(day.uptime_percent)} (${statusLabel(day.severity)})`
    );
    cell.setAttribute(
      "aria-label",
      `${day.date}: ${percent(day.uptime_percent)} (${statusLabel(day.severity)})`
    );
    ui.dayStrip.appendChild(cell);
  });
}

function renderActiveIncident(current, incidents) {
  const activeIds = new Set(current.active_incident_ids || []);
  const active = incidents.items.find((i) => activeIds.has(i.id) && i.status !== "resolved");

  if (!active) {
    ui.activeIncident.classList.remove("loading");
    ui.activeIncident.innerHTML = `
      <p class="incident-summary">No active incidents. Trains are currently running under normal operations.</p>
      <div class="incident-badges">
        <span class="badge severity-operational">Operational</span>
      </div>
    `;
    return;
  }

  const updatesHtml = active.updates
    .slice()
    .reverse()
    .map(
      (update) => `
      <li>
        <p><strong>${statusLabel(update.state)}</strong> · ${escapeHtml(update.message)}</p>
        <time datetime="${update.timestamp}">${formatLocal(update.timestamp)}</time>
      </li>`
    )
    .join("");

  ui.activeIncident.classList.remove("loading");
  ui.activeIncident.innerHTML = `
    <p class="incident-summary"><strong>${escapeHtml(active.title)}</strong></p>
    <div class="incident-badges">
      <span class="badge severity-${active.severity}">${capitalize(active.severity)}</span>
      <span class="badge">${escapeHtml(active.status)}</span>
      <span class="badge">${escapeHtml((active.affected_segments || []).join(", ") || "System-wide")}</span>
    </div>
    <p class="incident-summary">${escapeHtml(active.summary)}</p>
    <ul class="updates-list">${updatesHtml}</ul>
  `;
}

function renderTimeline(incidents) {
  ui.incidentTimeline.innerHTML = "";

  const sorted = incidents.items
    .slice()
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  sorted.forEach((incident) => {
    const item = document.createElement("li");
    item.className = "timeline-item";
    const incidentStatus = String(incident.status || "").trim().toLowerCase();

    const resolvedText = incident.resolved_at
      ? `Resolved ${formatLocal(incident.resolved_at)}`
      : `Ongoing since ${formatLocal(incident.started_at)}`;
    const metaParts = [capitalize(incident.severity)];
    if (incidentStatus && incidentStatus !== "resolved") {
      metaParts.push(escapeHtml(incident.status));
    }
    metaParts.push(resolvedText);

    item.innerHTML = `
      <span class="timeline-dot severity-${incident.severity}" aria-hidden="true"></span>
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
    renderActiveIncident(current, incidents);
    renderTimeline(incidents);
    renderRefreshTime();
  } catch (error) {
    renderError(error);
  }
}

loadAndRender();
setInterval(loadAndRender, REFRESH_MS);
