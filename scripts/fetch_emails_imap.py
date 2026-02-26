#!/usr/bin/env python3

import email
import imaplib
import os
from email.header import decode_header
from email.message import Message
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_PATH = ROOT / ".env"


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


def decode_mime_header(value: str) -> str:
    if not value:
        return ""
    parts = []
    for chunk, encoding in decode_header(value):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(encoding or "utf-8", errors="replace"))
        else:
            parts.append(chunk)
    return "".join(parts)


def get_text_body(msg: Message) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition", "")).lower()
            if content_type == "text/plain" and "attachment" not in content_disposition:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                charset = part.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace")
        return ""

    payload = msg.get_payload(decode=True)
    if payload is None:
        return ""
    charset = msg.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace")


def main() -> None:
    load_dotenv(DEFAULT_ENV_PATH)

    user = os.environ.get("GMAIL_USER")
    app_password = os.environ.get("GMAIL_APP_PASSWORD")
    host = (os.environ.get("IMAP_HOST") or "imap.gmail.com").strip()
    mailbox = (os.environ.get("IMAP_MAILBOX") or "INBOX").strip()
    only_unseen = os.environ.get("IMAP_ONLY_UNSEEN", "true").lower() in {"1", "true", "yes", "on"}

    if not user or not app_password:
        raise SystemExit("Missing GMAIL_USER or GMAIL_APP_PASSWORD in environment/.env")

    client = imaplib.IMAP4_SSL(host)
    try:
        client.login(user, app_password)
        client.select(mailbox)

        status, data = client.search(None, "UNSEEN" if only_unseen else "ALL")
        if status != "OK":
            raise SystemExit(f"IMAP search failed: {status}")

        ids = [x for x in data[0].split() if x]
        print(f"Found {len(ids)} message(s) in {mailbox} ({'UNSEEN' if only_unseen else 'ALL'})")

        for msg_id in ids:
            fetch_status, msg_data = client.fetch(msg_id, "(RFC822)")
            if fetch_status != "OK":
                print(f"Skipping message {msg_id.decode()}: fetch failed")
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
            date = decode_mime_header(msg.get("Date", ""))
            message_id = decode_mime_header(msg.get("Message-ID", ""))
            body = get_text_body(msg).strip().replace("\r", "")

            print("-" * 80)
            print(f"IMAP ID: {msg_id.decode()}")
            print(f"Message-ID: {message_id}")
            print(f"Date: {date}")
            print(f"From: {from_addr}")
            print(f"Subject: {subject}")
            print(f"Body: {body}")

    finally:
        try:
            client.close()
        except Exception:
            pass
        client.logout()


if __name__ == "__main__":
    main()
