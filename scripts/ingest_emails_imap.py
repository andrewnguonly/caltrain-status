#!/usr/bin/env python3

import email
import imaplib
import json
import os
import re
from datetime import datetime
from email.header import decode_header
from email.message import Message
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DEFAULT_ENV_PATH = ROOT / ".env"
CURRENT_STATUS_PATH = DATA_DIR / "current-status.json"
INCIDENTS_INDEX_PATH = DATA_DIR / "incidents" / "index.json"
INGESTION_STATE_PATH = DATA_DIR / "ingestion-state.json"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def decode_mime_header(value: str) -> str:
    if not value:
        return ""
    parts: list[str] = []
    for chunk, encoding in decode_header(value):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(encoding or "utf-8", errors="replace"))
        else:
            parts.append(chunk)
    return "".join(parts)


def get_text_body(msg: Message) -> str:
    if msg.is_multipart():
        html_candidate = ""
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition", "")).lower()
            if "attachment" in content_disposition:
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            charset = part.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace")
            if content_type == "text/plain":
                return text
            if content_type == "text/html" and not html_candidate:
                html_candidate = text
        return html_candidate
    payload = msg.get_payload(decode=True)
    if payload is None:
        return ""
    charset = msg.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace")


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def to_iso(dt: datetime) -> str:
    return dt.astimezone().isoformat(timespec="seconds")


def htmlish_to_text(text: str) -> str:
    s = str(text or "")
    s = re.sub(r"=\r?\n", "", s)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p>\s*<p>", "\n", s, flags=re.I)
    s = re.sub(r"</?[^>]+>", " ", s)
    html_entities = {"nbsp": " ", "amp": "&", "lt": "<", "gt": ">", "#39": "'", "#x27": "'"}
    s = re.sub(r"&([A-Za-z0-9#]+);", lambda m: html_entities.get(m.group(1), " "), s)
    s = s.replace("\u00a0", " ").replace("\r", "")
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def first_non_empty_line(text: str) -> str:
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def summarize_body(text: str) -> str:
    one_line = re.sub(r"\s+", " ", str(text or "")).strip()
    if not one_line:
        return "Email alert received."
    return one_line[:300]


def normalize_subject(subject: str) -> str:
    s = str(subject or "")
    s = re.sub(r"^\s*(?:fwd?|fw|re)\s*:\s*", "", s, flags=re.I)
    s = re.sub(r"\bcaltrain\b", "", s, flags=re.I)
    s = re.sub(r"\b(alert|advisory|service update|notification)\b", "", s, flags=re.I)
    s = re.sub(r"[^\w\s-]", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")
    return (s[:60] if s else "email-alert")


def extract_caltrain_field(body_text: str, label: str) -> str | None:
    normalized = htmlish_to_text(body_text)
    escaped = re.escape(label)
    patterns = [
        re.compile(rf"\b{escaped}\b\s*[:\n]+\s*([^\n]+)", re.I),
        re.compile(rf"\*\s*{escaped}\s*\*\s*\n+([^\n]+(?:\n[^\n]+)?)", re.I),
    ]
    for pattern in patterns:
        match = pattern.search(normalized)
        if match:
            return re.sub(r"\s+", " ", match.group(1)).strip()
    return None


def parse_caltrain_datetime(raw: str | None) -> datetime | None:
    if not raw:
        return None
    cleaned = re.sub(r"\s+", " ", raw).strip()
    match = re.search(
        r"\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b(?:\s+|,\s*)(\d{1,2}):(\d{2})\s*(AM|PM)\b",
        cleaned,
        re.I,
    )
    if not match:
        return None
    mm, dd, yy_raw, hh, minute, ampm = match.groups()
    year = int(f"20{yy_raw}") if len(yy_raw) == 2 else int(yy_raw)
    hour = int(hh) % 12
    if ampm.lower() == "pm":
        hour += 12
    try:
        return datetime(year, int(mm), int(dd), hour, int(minute))
    except ValueError:
        return None


def parse_caltrain_alert_details(subject: str, body_text: str) -> dict[str, Any]:
    clean_body = htmlish_to_text(body_text)
    subject_text = (subject or "").strip()
    m = re.match(r"^\s*([^:]+):\s*(.+)\s*$", subject_text)
    alert_type = m.group(1).strip() if m else None
    subject_desc = m.group(2).strip() if m else subject_text

    alert_cause = extract_caltrain_field(clean_body, "Alert Cause")
    alert_effect = extract_caltrain_field(clean_body, "Alert Effect")
    start_raw = extract_caltrain_field(clean_body, "Start Date")
    end_raw = extract_caltrain_field(clean_body, "End Date")
    start_dt = parse_caltrain_datetime(start_raw)
    end_dt = parse_caltrain_datetime(end_raw)

    train_match = re.search(r"\bTrain\s+([A-Za-z0-9]+)\b", subject_desc, re.I)
    station_match = re.search(r"\bat\s+([A-Za-z][A-Za-z .'\-]+)$", subject_desc, re.I)

    return {
        "clean_body": clean_body,
        "alert_type": alert_type,
        "subject_description": subject_desc,
        "alert_cause": alert_cause,
        "alert_effect": alert_effect,
        "start_date_raw": start_raw,
        "end_date_raw": end_raw,
        "start_date": start_dt,
        "end_date": end_dt,
        "train_number": train_match.group(1) if train_match else None,
        "station": station_match.group(1).strip() if station_match else None,
    }


def infer_severity_and_status(subject: str, body_text: str, received_at_iso: str) -> dict[str, str]:
    details = parse_caltrain_alert_details(subject, body_text)
    haystack = f"{subject}\n{details['clean_body']}".lower()
    effect = str(details.get("alert_effect") or "").lower()
    alert_type = str(details.get("alert_type") or "").lower()
    received_dt = parse_iso(received_at_iso)

    end_dt = details.get("end_date")
    if isinstance(end_dt, datetime):
        if received_dt is None or end_dt <= received_dt.replace(tzinfo=None):
            return {"severity": "minor", "status": "resolved", "update_state": "operational"}

    if "platform change" in alert_type:
        return {"severity": "minor", "status": "investigating", "update_state": "degraded"}
    if "modified service" in effect:
        return {"severity": "minor", "status": "investigating", "update_state": "degraded"}
    if "reduced service" in effect:
        return {"severity": "major", "status": "investigating", "update_state": "major"}
    if "no service" in effect:
        return {"severity": "critical", "status": "investigating", "update_state": "critical"}

    if re.search(r"\b(resolved|restored|normal service|back to normal|cleared?)\b", haystack):
        return {"severity": "minor", "status": "resolved", "update_state": "operational"}
    if re.search(r"\b(no service|service suspended|all trains stopped|shutdown)\b", haystack):
        return {"severity": "critical", "status": "investigating", "update_state": "critical"}
    if re.search(r"\b(major disruption|disabled train|signal issue|police activity|single-track)\b", haystack):
        return {"severity": "major", "status": "investigating", "update_state": "major"}
    return {"severity": "minor", "status": "investigating", "update_state": "degraded"}


def infer_affected_segments(subject: str, body_text: str) -> list[str]:
    details = parse_caltrain_alert_details(subject, body_text)
    haystack = f"{subject}\n{details['clean_body']}".lower()
    segments: list[str] = []
    if "northbound" in haystack:
        segments.append("Northbound")
    if "southbound" in haystack:
        segments.append("Southbound")
    if "both directions" in haystack:
        if "Northbound" not in segments:
            segments.append("Northbound")
        if "Southbound" not in segments:
            segments.append("Southbound")
    if details.get("station"):
        segments.append(str(details["station"]))
    if not segments:
        segments.append("System-wide")
    # preserve order, remove dupes
    out: list[str] = []
    for s in segments:
        if s not in out:
            out.append(s)
    return out


def build_parsed_event(message_id: str, subject: str, body_text: str, received_at_iso: str) -> dict[str, Any]:
    details = parse_caltrain_alert_details(subject, body_text)
    normalized_subject = normalize_subject(
        " ".join(
            [x for x in [details.get("alert_type"), details.get("subject_description"), details.get("station")] if x]
        )
    )
    subject_key = slugify(normalized_subject or subject)
    headline = (
        (f"{details['alert_type']}: {details['subject_description']}" if details.get("alert_type") else "")
        or normalized_subject
        or first_non_empty_line(details["clean_body"])
        or "Caltrain service alert"
    )
    severity_info = infer_severity_and_status(subject, body_text, received_at_iso)

    summary_parts = [
        details.get("alert_type"),
        f"Effect: {details['alert_effect']}" if details.get("alert_effect") else None,
        f"Cause: {details['alert_cause']}" if details.get("alert_cause") else None,
        f"Location: {details['station']}" if details.get("station") else None,
        f"Start: {details['start_date_raw']}" if details.get("start_date_raw") else None,
        f"End: {details['end_date_raw']}" if details.get("end_date_raw") else None,
    ]
    summary = " | ".join([p for p in summary_parts if p]) or summarize_body(details["clean_body"])

    update_parts = [
        details.get("subject_description") or subject,
        f"Effect: {details['alert_effect']}" if details.get("alert_effect") else None,
        f"Cause: {details['alert_cause']}" if details.get("alert_cause") else None,
    ]
    update_message = " | ".join([p for p in update_parts if p]) or first_non_empty_line(details["clean_body"]) or subject

    return {
        "message_id": message_id,
        "received_at": received_at_iso,
        "subject": subject,
        "body_text": details["clean_body"],
        "subject_key": subject_key,
        "title": headline[:1].upper() + headline[1:] if headline else "Caltrain service alert",
        "summary": summary,
        "severity": severity_info["severity"],
        "incident_status": severity_info["status"],
        "update_state": severity_info["update_state"],
        "affected_segments": infer_affected_segments(subject, body_text),
        "update_message": update_message,
        "started_at": to_iso(details["start_date"]) if isinstance(details.get("start_date"), datetime) else None,
        "ended_at": to_iso(details["end_date"]) if isinstance(details.get("end_date"), datetime) else None,
    }


def load_state() -> dict[str, Any]:
    return read_json(INGESTION_STATE_PATH, {"processed_message_ids": [], "last_run_at": None})


def save_state(state: dict[str, Any]) -> None:
    ids = list(dict.fromkeys(state.get("processed_message_ids", [])))
    state["processed_message_ids"] = ids[-5000:]
    state["last_run_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    write_json(INGESTION_STATE_PATH, state)


def load_incidents_index() -> dict[str, Any]:
    return read_json(INCIDENTS_INDEX_PATH, {"files": []})


def save_incidents_index(index: dict[str, Any]) -> None:
    files = list(dict.fromkeys(index.get("files", [])))
    index["files"] = sorted(files, reverse=True)
    write_json(INCIDENTS_INDEX_PATH, index)

def load_current_status() -> dict[str, Any]:
    return read_json(
        CURRENT_STATUS_PATH,
        {
            "service_name": "Caltrain",
            "overall_status": "operational",
            "status_message": "No active incidents.",
            "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "active_incident_ids": [],
            "incident_file_paths": [],
        },
    )


def save_current_status(current: dict[str, Any]) -> None:
    current["incident_file_paths"] = list(dict.fromkeys(current.get("incident_file_paths", [])))
    write_json(CURRENT_STATUS_PATH, current)


def snapshot_repo_path_for_event(event: dict[str, Any]) -> str:
    event_dt = parse_iso(event["received_at"]) or datetime.now().astimezone()
    stamp = event_dt.strftime("%Y%m%dT%H%M%S")
    msg_suffix = slugify(event.get("message_id", ""))[:24]
    key_suffix = slugify(event.get("subject_key", ""))[:32]
    filename = f"{stamp}-{key_suffix}-{msg_suffix}.json"
    return f"data/incidents/events/{event_dt.year:04d}/{event_dt.month:02d}/{event_dt.day:02d}/{filename}"


def snapshot_abs_path_for_event(event: dict[str, Any]) -> Path:
    return ROOT / snapshot_repo_path_for_event(event)


def load_incident_records_from_paths(paths: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for repo_path in paths:
        payload = read_json(ROOT / repo_path, None)
        if not payload:
            continue
        if isinstance(payload, dict) and isinstance(payload.get("items"), list):
            records.extend([i for i in payload["items"] if isinstance(i, dict)])
            continue
        if isinstance(payload, dict) and isinstance(payload.get("incident"), dict):
            records.append(payload["incident"])
            continue
        if isinstance(payload, dict) and payload.get("id"):
            records.append(payload)
    return records


def severity_rank(severity: str | None) -> int:
    return {"operational": 0, "minor": 1, "degraded": 1, "major": 2, "critical": 3}.get(str(severity), 0)


def create_incident_id(started_at_iso: str, subject_key: str, existing_ids: set[str]) -> str:
    day = (started_at_iso or datetime.now().date().isoformat())[:10]
    base = f"inc-{day}-{subject_key}"
    if base not in existing_ids:
        return base
    counter = 2
    while f"{base}-{counter}" in existing_ids:
        counter += 1
    return f"{base}-{counter}"


def find_matching_incident(incidents: list[dict[str, Any]], event: dict[str, Any]) -> dict[str, Any] | None:
    candidates = []
    for incident in incidents:
        if incident.get("ingestion_key") == event["subject_key"] or normalize_subject(incident.get("title", "")) == normalize_subject(event["title"]):
            candidates.append(incident)
    if not candidates:
        return None
    candidates.sort(key=lambda i: i.get("started_at", ""), reverse=True)
    if event["incident_status"] == "resolved":
        for incident in candidates:
            if incident.get("status") != "resolved":
                return incident
    for incident in candidates:
        if incident.get("status") != "resolved":
            return incident
    return candidates[0]


def build_incident_snapshot(existing_incidents: list[dict[str, Any]], event: dict[str, Any]) -> dict[str, Any]:
    existing_ids = {str(i.get("id")) for i in existing_incidents if i.get("id")}
    source_incident = find_matching_incident(existing_incidents, event)
    timestamp = event["received_at"]
    effective_start = event.get("started_at") or timestamp
    effective_end = event.get("ended_at")

    if source_incident is None:
        incident = {
            "id": create_incident_id(effective_start, event["subject_key"], existing_ids),
            "title": event["title"],
            "severity": event["severity"],
            "status": event["incident_status"],
            "started_at": effective_start,
            "resolved_at": (effective_end or timestamp) if event["incident_status"] == "resolved" else None,
            "affected_segments": list(dict.fromkeys(event.get("affected_segments", []) or ["System-wide"])),
            "summary": event["summary"],
            "updates": [],
            "ingestion_key": event["subject_key"],
        }
    else:
        incident = json.loads(json.dumps(source_incident))
        if not incident.get("title"):
            incident["title"] = event["title"]
        merged_segments = list(incident.get("affected_segments", [])) + list(event.get("affected_segments", []))
        incident["affected_segments"] = list(dict.fromkeys([s for s in merged_segments if s]))
        if event.get("summary"):
            incident["summary"] = event["summary"]
        if severity_rank(event.get("severity")) > severity_rank(incident.get("severity")):
            incident["severity"] = event["severity"]
        if event["incident_status"] == "resolved":
            incident["status"] = "resolved"
            incident["resolved_at"] = effective_end or timestamp
        elif incident.get("status") == "resolved":
            incident["status"] = "investigating"
            incident["resolved_at"] = None
        else:
            incident["status"] = event.get("incident_status") or incident.get("status")
        if event.get("started_at"):
            existing_start = parse_iso(incident.get("started_at"))
            new_start = parse_iso(event["started_at"])
            if new_start and (existing_start is None or new_start < existing_start):
                incident["started_at"] = event["started_at"]

    incident.setdefault("updates", [])
    already = any(u.get("source_message_id") == event["message_id"] for u in incident["updates"])
    if not already:
        incident["updates"].append(
            {
                "timestamp": timestamp,
                "state": event["update_state"],
                "message": event["update_message"],
                "source_message_id": event["message_id"],
            }
        )
        incident["updates"].sort(key=lambda u: u.get("timestamp", ""))
    incident["version_created_at"] = timestamp
    return incident


def collect_all_incidents() -> list[dict[str, Any]]:
    current = load_current_status()
    current_paths = [p for p in current.get("incident_file_paths", []) if isinstance(p, str)]
    legacy_index = load_incidents_index()
    legacy_paths = [p for p in legacy_index.get("files", []) if isinstance(p, str)]
    all_records = load_incident_records_from_paths(list(dict.fromkeys(current_paths + legacy_paths)))

    by_id: dict[str, dict[str, Any]] = {}
    for incident in all_records:
        incident_id = str(incident.get("id") or "")
        if not incident_id:
            continue
        prev = by_id.get(incident_id)
        prev_ts = (
            (prev or {}).get("version_created_at")
            or ((prev or {}).get("updates") or [{}])[-1].get("timestamp")
            or (prev or {}).get("resolved_at")
            or (prev or {}).get("started_at")
            or ""
        )
        next_ts = (
            incident.get("version_created_at")
            or (incident.get("updates") or [{}])[-1].get("timestamp")
            or incident.get("resolved_at")
            or incident.get("started_at")
            or ""
        )
        if prev is None or next_ts >= prev_ts:
            by_id[incident_id] = incident

    items = sorted(by_id.values(), key=lambda i: i.get("started_at", ""), reverse=True)
    return items


def update_current_status_file(processed_at_iso: str) -> None:
    current = load_current_status()
    incidents = collect_all_incidents()
    active = [i for i in incidents if i.get("status") != "resolved"]
    active.sort(
        key=lambda i: (
            severity_rank(i.get("severity")),
            parse_iso(i.get("started_at")) or datetime.min,
        ),
        reverse=True,
    )

    if active:
        top = active[0]
        sev = str(top.get("severity"))
        if sev == "critical":
            overall = "critical"
        elif sev == "major":
            overall = "major"
        else:
            overall = "degraded"
        current["status_message"] = top.get("summary") or top.get("title") or "Active incident"
        current["active_incident_ids"] = [i.get("id") for i in active if i.get("id")]
    else:
        overall = "operational"
        current["status_message"] = "No active incidents. Trains are currently running under normal operations."
        current["active_incident_ids"] = []

    current["service_name"] = current.get("service_name") or "Caltrain"
    current["overall_status"] = overall
    current["updated_at"] = processed_at_iso
    save_current_status(current)


def apply_event_to_repo(event: dict[str, Any]) -> dict[str, Any]:
    existing_incidents = collect_all_incidents()
    incident = build_incident_snapshot(existing_incidents, event)

    repo_path = snapshot_repo_path_for_event(event)
    abs_path = ROOT / repo_path
    payload = {
        "schema": "incident-snapshot-v1",
        "version_created_at": event["received_at"],
        "source_message_id": event["message_id"],
        "incident": incident,
    }
    write_json(abs_path, payload)

    current = load_current_status()
    current["incident_file_paths"] = list(current.get("incident_file_paths", [])) + [repo_path]
    save_current_status(current)
    return incident


def passes_filters(from_addr: str, subject: str) -> bool:
    from_match = (os.environ.get("INGEST_FROM_MATCH") or "").strip().lower()
    subject_match = (os.environ.get("INGEST_SUBJECT_MATCH") or "").strip().lower()
    from_text = (from_addr or "").lower()
    subject_text = (subject or "").lower()
    if from_match and from_match not in from_text:
        return False
    if subject_match and subject_match not in subject_text:
        return False
    return True


def ingest_from_imap() -> None:
    user = os.environ.get("GMAIL_USER")
    app_password = os.environ.get("GMAIL_APP_PASSWORD")
    host = (os.environ.get("IMAP_HOST") or "imap.gmail.com").strip()
    mailbox = (os.environ.get("IMAP_MAILBOX") or "INBOX").strip()
    only_unseen = env_bool("IMAP_ONLY_UNSEEN", True)
    mark_seen = env_bool("IMAP_MARK_SEEN", True)
    save_local_state = env_bool("INGEST_SAVE_STATE", False)

    if not user or not app_password:
        raise SystemExit("Missing GMAIL_USER or GMAIL_APP_PASSWORD in environment/.env")

    state = load_state()
    processed_ids = set(state.get("processed_message_ids", []))
    changed = False
    processed_count = 0

    client = imaplib.IMAP4_SSL(host)
    try:
        client.login(user, app_password)
        client.select(mailbox)

        criteria = "UNSEEN" if only_unseen else "ALL"
        status, data = client.search(None, criteria)
        if status != "OK":
            raise SystemExit(f"IMAP search failed: {status}")
        ids = [x for x in data[0].split() if x]
        print(f"Found {len(ids)} message(s) in {mailbox} ({criteria})")

        for msg_id in ids:
            fetch_status, msg_data = client.fetch(msg_id, "(RFC822)")
            if fetch_status != "OK":
                print(f"Skipping {msg_id.decode(errors='ignore')}: fetch failed")
                continue

            raw_bytes = None
            for part in msg_data:
                if isinstance(part, tuple) and len(part) >= 2:
                    raw_bytes = part[1]
                    break
            if raw_bytes is None:
                continue

            msg = email.message_from_bytes(raw_bytes)
            subject = decode_mime_header(msg.get("Subject", ""))
            from_addr = decode_mime_header(msg.get("From", ""))
            message_id = decode_mime_header(msg.get("Message-ID", "")) or f"imap-{msg_id.decode(errors='ignore')}"
            date_hdr = decode_mime_header(msg.get("Date", ""))
            parsed_date = email.utils.parsedate_to_datetime(date_hdr) if date_hdr else None
            received_at_iso = to_iso(parsed_date) if isinstance(parsed_date, datetime) else to_iso(datetime.now().astimezone())
            body = get_text_body(msg).replace("\r", "")

            if message_id in processed_ids:
                if mark_seen:
                    client.store(msg_id, "+FLAGS", "\\Seen")
                continue

            if not passes_filters(from_addr, subject):
                print(f"Skipping email (filter): {subject or '(No subject)'}")
                processed_ids.add(message_id)
                state.setdefault("processed_message_ids", []).append(message_id)
                if mark_seen:
                    client.store(msg_id, "+FLAGS", "\\Seen")
                continue

            event = build_parsed_event(message_id=message_id, subject=subject, body_text=body, received_at_iso=received_at_iso)
            incident = apply_event_to_repo(event)
            print(f"Processed {message_id} -> {incident['id']}")

            processed_ids.add(message_id)
            state.setdefault("processed_message_ids", []).append(message_id)
            processed_count += 1
            changed = True

            if mark_seen:
                client.store(msg_id, "+FLAGS", "\\Seen")

        if changed:
            update_current_status_file(to_iso(datetime.now().astimezone()))
        if save_local_state:
            save_state(state)
        print(f"Done. processed={processed_count}")
    finally:
        try:
            client.close()
        except Exception:
            pass
        client.logout()


def main() -> None:
    load_dotenv(DEFAULT_ENV_PATH)
    ingest_from_imap()


if __name__ == "__main__":
    main()
