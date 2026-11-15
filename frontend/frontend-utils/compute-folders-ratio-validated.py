#!/usr/bin/env python3
"""Compute and store %_validated for dgx folders in Firebase bucket folders.json.

For each top-level folder whose name contains "dgx", reads {folder}/data.json,
counts entries with user_is_validated=true, and writes the percentage to folders.json
at the bucket root (schema: docs/schemas/schema-folders_v1.1.0.json).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

import firebase_admin
from firebase_admin import credentials, storage

FOLDERS_JSON = "folders.json"
FOLDER_NAME_FILTER = "dgx"

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


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def _extract_entries(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        records = data.get("data")
        if isinstance(records, list):
            return records
        records = data.get("entries")
        if isinstance(records, list):
            return records
    raise ValueError("data.json must be a JSON array or an object with a 'data' array")


def _list_top_level_folders(bucket: storage.bucket, root: str) -> list[str]:
    prefix = root.rstrip("/")
    if prefix:
        prefix += "/"

    names: set[str] = set()
    iterator = bucket.list_blobs(prefix=prefix, delimiter="/")
    for page in iterator.pages:
        for child_prefix in getattr(page, "prefixes", []):
            name = child_prefix[len(prefix) :].rstrip("/")
            if name:
                names.add(name)

    return sorted(names, key=str.lower)


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


def _backup_folders_json(bucket: storage.bucket, root: str, *, dry_run: bool) -> str | None:
    """Copy folders.json to a timestamped backup in the bucket before overwriting."""
    source_path = _join_path(root, FOLDERS_JSON)
    source_blob = bucket.get_blob(source_path)
    if source_blob is None:
        logger.info("No existing %s — skipping backup", source_path)
        return None

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_name = f"{FOLDERS_JSON}.backup.{timestamp}"
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


def _compute_pct_validated(bucket: storage.bucket, root: str, folder_name: str) -> tuple[float, int, int]:
    data_path = _join_path(_join_path(root, folder_name), "data.json")
    blob = bucket.get_blob(data_path)
    if blob is None:
        logger.warning("  %s: no data.json — setting %%_validated=0", folder_name)
        return 0.0, 0, 0

    try:
        entries = _extract_entries(_read_json_blob(bucket, data_path))
    except Exception as exc:
        logger.warning("  %s: failed to read data.json (%s) — setting %%_validated=0", folder_name, exc)
        return 0.0, 0, 0

    total = len(entries)
    if total == 0:
        return 0.0, 0, 0

    validated = sum(
        1
        for entry in entries
        if isinstance(entry, dict) and _coerce_bool(entry.get("user_is_validated", False))
    )
    pct = round((validated / total) * 100.0, 3)
    return pct, validated, total


def _default_folder_record(folder_name: str) -> dict[str, Any]:
    return {
        "folder_name": folder_name,
        "is_processed": False,
        "n_audios": 0,
        "audios_duration": 0.0,
        "%_validated": 0.0,
    }


def _read_folders_records(bucket: storage.bucket, root: str) -> list[dict[str, Any]]:
    path = _join_path(root, FOLDERS_JSON)
    blob = bucket.get_blob(path)
    if blob is None:
        return []
    try:
        data = json.loads(blob.download_as_text(encoding="utf-8"))
        if isinstance(data, list):
            return [r for r in data if isinstance(r, dict) and r.get("folder_name")]
    except Exception as exc:
        logger.warning("Could not parse %s: %s", path, exc)
    return []


def _folders_index(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(r["folder_name"]): r for r in records}


def update_folders_validated(
    bucket: storage.bucket,
    *,
    root: str = "",
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """Update %_validated for dgx folders; return the full folders.json record list."""
    folder_names = _list_top_level_folders(bucket, root)
    dgx_folders = [name for name in folder_names if FOLDER_NAME_FILTER in name.lower()]
    logger.info("Found %d folder(s), %d matching %r", len(folder_names), len(dgx_folders), FOLDER_NAME_FILTER)

    records = _read_folders_records(bucket, root)
    index = _folders_index(records)

    for folder_name in dgx_folders:
        pct, validated, total = _compute_pct_validated(bucket, root, folder_name)
        logger.info("  %s: %d/%d validated -> %%_validated=%.3f", folder_name, validated, total, pct)

        record = index.get(folder_name)
        if record is None:
            record = _default_folder_record(folder_name)
            records.append(record)
            index[folder_name] = record

        record["%_validated"] = pct

    if not dgx_folders:
        logger.info("No dgx folders to update.")
        return records

    sorted_records = sorted(records, key=lambda r: str(r.get("folder_name", "")).lower())
    _backup_folders_json(bucket, root, dry_run=dry_run)
    _write_json_blob(bucket, _join_path(root, FOLDERS_JSON), sorted_records, dry_run=dry_run)
    return sorted_records


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compute %%_validated for dgx folders and store in folders.json."
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
        help="Compute metrics and log changes without writing folders.json.",
    )
    args = parser.parse_args()

    env_vars = _load_env_file(args.env_file)
    for key, value in env_vars.items():
        os.environ.setdefault(key, value)

    bucket_name = _resolve_bucket_name(env_vars, args.bucket)
    bucket = _init_firebase(bucket_name, env_vars, args.credentials_path)

    update_folders_validated(bucket, root=args.prefix.strip("/"), dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
