#!/usr/bin/env python3
"""Build timeline.json at the Firebase bucket root from folders.json.

Reads folders.json, and for each record with computed statistics appends a timeline
data event (schema: docs/schemas/schema-timeline_v1.0.1.json) with:
  - date: parsed from folder_name (YYYY.MM.DD)
  - name: "keyboard"
    - type: "data"
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

import firebase_admin
from firebase_admin import credentials, storage

FOLDERS_JSON = "folders.json"
TIMELINE_JSON = "timeline.json"
EVENT_NAME = "keyboard"
EVENT_TYPE = "data"
MIN_FOLDER_DATE = "20260601"

_FOLDER_DATE_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})")

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def _parse_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and ((value[0] == value[-1] == '"') or (value[0] == value[-1] == "'")):
        value = value[1:-1]
    return value.encode("utf-8").decode("unicode_escape")


def _load_env_file(env_file: str) -> dict[str, str]:
    env_file = os.path.abspath(env_file)
    if not os.path.isfile(env_file):
        return {}

    env_vars: dict[str, str] = {}
    with open(env_file, encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key:
                env_vars[key] = _parse_env_value(value)
    return env_vars


def _normalize_env_private_key(private_key: str | None) -> str | None:
    if not private_key:
        return private_key
    return private_key.replace("\\n", "\n")


def _build_firebase_service_account_info(env_vars: dict[str, str]) -> dict[str, Any] | None:
    project_id = (env_vars.get("FIREBASE_ADMIN_PROJECT_ID") or "").strip()
    if not project_id:
        return None

    private_key = _normalize_env_private_key(env_vars.get("FIREBASE_ADMIN_PRIVATE_KEY"))
    client_email = (env_vars.get("FIREBASE_ADMIN_CLIENT_EMAIL") or "").strip()
    if not private_key or not client_email:
        return None

    return {
        "type": env_vars.get("FIREBASE_ADMIN_TYPE", "service_account"),
        "project_id": project_id,
        "private_key_id": env_vars.get("FIREBASE_ADMIN_PRIVATE_KEY_ID"),
        "private_key": private_key,
        "client_email": client_email,
        "client_id": env_vars.get("FIREBASE_ADMIN_CLIENT_ID"),
        "auth_uri": env_vars.get("FIREBASE_ADMIN_AUTH_URI"),
        "token_uri": env_vars.get("FIREBASE_ADMIN_TOKEN_URI"),
        "auth_provider_x509_cert_url": env_vars.get("FIREBASE_ADMIN_AUTH_PROVIDER_X509_CERT_URL"),
        "client_x509_cert_url": env_vars.get("FIREBASE_ADMIN_CLIENT_X509_CERT_URL"),
        "universe_domain": env_vars.get("FIREBASE_ADMIN_UNIVERSE_DOMAIN", "googleapis.com"),
    }


def _resolve_bucket_name(env_vars: dict[str, str], override: str | None) -> str:
    if override:
        return override.strip()
    for key in (
        "TRAINER_FIREBASE_BUCKET",
        "FRONTEND_FIREBASE_BUCKET",
        "MODEL_SERVER_FIREBASE_BUCKET",
        "FIREBASE_CLIENT_STORAGE_BUCKET_DESTINATION",
    ):
        value = (env_vars.get(key) or os.environ.get(key) or "").strip()
        if value:
            return value
    raise SystemExit(
        "Firebase bucket not set. Pass --bucket or set TRAINER_FIREBASE_BUCKET "
        "(or FRONTEND_FIREBASE_BUCKET / MODEL_SERVER_FIREBASE_BUCKET) in the env file."
    )


def _init_firebase(bucket_name: str, env_vars: dict[str, str], credentials_path: str | None) -> storage.bucket:
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = None
        service_account_info = _build_firebase_service_account_info(env_vars)
        if service_account_info:
            cred = credentials.Certificate(service_account_info)
            logger.info("Firebase credentials loaded from env vars")
        elif credentials_path and os.path.isfile(credentials_path):
            cred = credentials.Certificate(credentials_path)
            logger.info("Firebase credentials loaded from %s", credentials_path)
        else:
            raise SystemExit(
                "Firebase credentials not found. Set FIREBASE_ADMIN_* in the env file "
                "or pass --credentials-path."
            )
        firebase_admin.initialize_app(cred, {"storageBucket": bucket_name})

    bucket = storage.bucket()
    logger.info("Connected to Firebase bucket: %s", bucket_name)
    return bucket


def _join_path(root: str, rel: str) -> str:
    if not root:
        return rel
    return f"{root.rstrip('/')}/{rel.lstrip('/')}"


def _read_json_blob(bucket: storage.bucket, path: str) -> Any:
    blob = bucket.get_blob(path)
    if blob is None:
        raise FileNotFoundError(path)
    return json.loads(blob.download_as_text(encoding="utf-8"))


def _write_json_blob(bucket: storage.bucket, path: str, obj: Any, *, dry_run: bool) -> None:
    payload = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    if dry_run:
        logger.info("[dry-run] Would write %s (%d bytes)", path, len(payload.encode("utf-8")))
        return
    blob = bucket.blob(path)
    blob.upload_from_string(payload, content_type="application/json; charset=utf-8")
    logger.info("Wrote %s", path)


def _backup_timeline_json(bucket: storage.bucket, root: str, *, dry_run: bool) -> str | None:
    source_path = _join_path(root, TIMELINE_JSON)
    source_blob = bucket.get_blob(source_path)
    if source_blob is None:
        logger.info("No existing %s — skipping backup", source_path)
        return None

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_name = f"{TIMELINE_JSON}.backup.{timestamp}"
    backup_path = _join_path(root, backup_name)

    if dry_run:
        logger.info(
            "[dry-run] Would back up %s -> %s (%d bytes)",
            source_path,
            backup_path,
            source_blob.size or 0,
        )
        return backup_path

    bucket.copy_blob(source_blob, bucket, backup_path)
    logger.info("Backed up %s -> %s", source_path, backup_path)
    return backup_path


def _read_folders_records(bucket: storage.bucket, root: str) -> list[dict[str, Any]]:
    path = _join_path(root, FOLDERS_JSON)
    try:
        data = _read_json_blob(bucket, path)
    except FileNotFoundError:
        raise SystemExit(f"{path} not found in bucket.") from None

    if not isinstance(data, list):
        raise SystemExit(f"{path} must be a JSON array.")

    records = [r for r in data if isinstance(r, dict) and r.get("folder_name")]
    logger.info("Loaded %d folder record(s) from %s", len(records), path)
    return records


def _date_from_folder_name(folder_name: str) -> str | None:
    """Return YYYY.MM.DD from a folder name whose prefix is YYYYMMDD."""
    match = _FOLDER_DATE_RE.match(folder_name)
    if not match:
        return None
    year, month, day = match.groups()
    try:
        datetime(int(year), int(month), int(day))
    except ValueError:
        return None
    return f"{year}.{month}.{day}"


def _coerce_float(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return 0.0
    return 0.0


def build_timeline_events(folder_records: list[dict[str, Any]]) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []

    for record in folder_records:
        pct_validated = _coerce_float(record.get("%_validated", 0))

        folder_name = str(record["folder_name"])
        if "dgx" not in folder_name.lower():
            continue
        date = _date_from_folder_name(folder_name)
        if date is None:
            logger.warning(
                "Skipping %s: cannot parse date from folder_name (expected YYYYMMDD prefix)",
                folder_name,
            )
            continue
        if date.replace(".", "") <= MIN_FOLDER_DATE:
            continue

        events.append(
            {
                "date": date,
                "name": EVENT_NAME,
                "type": EVENT_TYPE,
            }
        )
        logger.info("  %s (%%_validated=%s) -> date=%s", folder_name, pct_validated, date)

    events.sort(key=lambda e: e["date"])
    return events


def create_timeline_from_folders(
    bucket: storage.bucket,
    *,
    root: str = "",
    dry_run: bool = False,
) -> list[dict[str, str]]:
    """Read folders.json and write timeline.json; return the event list."""
    folder_records = _read_folders_records(bucket, root)
    events = build_timeline_events(folder_records)
    logger.info("Built %d timeline event(s)", len(events))

    timeline_path = _join_path(root, TIMELINE_JSON)
    _backup_timeline_json(bucket, root, dry_run=dry_run)
    _write_json_blob(bucket, timeline_path, events, dry_run=dry_run)
    return events


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create timeline.json from folders.json (computed statistics)."
    )
    parser.add_argument(
        "--env-file",
        required=True,
        help="Path to the .env file with FIREBASE_ADMIN_* and bucket settings.",
    )
    parser.add_argument(
        "--bucket",
        default=None,
        help="Firebase storage bucket name (overrides env vars).",
    )
    parser.add_argument(
        "--credentials-path",
        default=None,
        help="Path to Firebase service-account JSON (fallback if FIREBASE_ADMIN_* unset).",
    )
    parser.add_argument(
        "--prefix",
        default="",
        help="Optional root prefix inside the bucket (e.g. datasets/).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build timeline and log changes without writing timeline.json.",
    )
    args = parser.parse_args()

    env_vars = _load_env_file(args.env_file)
    for key, value in env_vars.items():
        os.environ.setdefault(key, value)

    bucket_name = _resolve_bucket_name(env_vars, args.bucket)
    bucket = _init_firebase(bucket_name, env_vars, args.credentials_path)

    create_timeline_from_folders(bucket, root=args.prefix.strip("/"), dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
