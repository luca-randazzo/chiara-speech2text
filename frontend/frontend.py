from __future__ import annotations

import argparse
import io
import json
import mimetypes
import os
import re
import threading
import time
import uuid
import wave
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO
from datetime import datetime, timezone

# -----------------------------
# environment variables
# -----------------------------
def _expand_env_value(value: str, env_vars: dict[str, str]) -> str:
    def _replace(match: re.Match[str]) -> str:
        key = match.group(1) or match.group(2)
        if key in env_vars:
            return env_vars[key]
        return os.environ.get(key, "")

    return re.sub(r"\$(\w+)|\$\{([^}]+)\}", _replace, value)


def _parse_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and ((value[0] == value[-1] == '"') or (value[0] == value[-1] == "'")):
        value = value[1:-1]
    return value.encode("utf-8").decode("unicode_escape")


def _load_env_file(env_file: str) -> dict:
    env_file = os.path.abspath(env_file)
    if not os.path.isfile(env_file):
        return {}
    env_vars = {}
    with open(env_file, encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key:
                env_vars[key] = _expand_env_value(_parse_env_value(value), env_vars)
    return env_vars


_arg_parser = argparse.ArgumentParser(description="Chiara Speech-to-Text explorer frontend")
_arg_parser.add_argument(
    "--env-file",
    type=str,
    required=True,
    help="Path to the .env file to load environment variables from.",
)
_cli_args, _cli_unknown = _arg_parser.parse_known_args()

if not os.path.isfile(_cli_args.env_file):
    _arg_parser.error(f"env file not found: {_cli_args.env_file}")

for _k, _v in _load_env_file(_cli_args.env_file).items():
    if _k and _k not in os.environ:
        os.environ[_k] = _v
# -----------------------------

import requests
from spellchecker import SpellChecker

from flask import Flask, Response, jsonify, render_template, request

import sys
import os

_FRONTEND_UTILS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend-utils")
if _FRONTEND_UTILS_PATH not in sys.path:
    sys.path.insert(0, _FRONTEND_UTILS_PATH)

from decoding_analysis import analyze_entries_for_model, collect_unique_inference_words
from firebase_credentials import build_firebase_service_account_info, resolve_firebase_credentials_path

try:
    import firebase_admin
    from firebase_admin import credentials, storage
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False


app = Flask(__name__)

_lock = threading.Lock()
_firebase_app = None


def _create_model_server_session() -> requests.Session:
    """Return a requests session that ignores proxy settings from the shell.

    The frontend calls the model server directly via the configured host/port in the
    .env file, so environment-level HTTP_PROXY values (for example 127.0.0.1:5001)
    must not override that target.
    """
    session = requests.Session()
    session.trust_env = False
    return session


def _explorer_log(component: str, message: str) -> None:
    """Timestamped progress log (flushed for terminal / systemd)."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{component}] {message}", flush=True)


class StorageBackend(ABC):
    """Abstract base class for storage backends."""
    
    @abstractmethod
    def exists(self, path: str) -> bool:
        """Check if a path exists."""
        pass
    
    @abstractmethod
    def is_dir(self, path: str) -> bool:
        """Check if path is a directory."""
        pass
    
    @abstractmethod
    def is_file(self, path: str) -> bool:
        """Check if path is a file."""
        pass
    
    @abstractmethod
    def read_bytes(self, path: str, max_bytes: int | None = None) -> bytes:
        """Read file as bytes."""
        pass
    
    @abstractmethod
    def write_bytes(self, path: str, data: bytes, content_type: str | None = None) -> None:
        """Write bytes to file."""
        pass
    
    @abstractmethod
    def list_dir(self, path: str) -> list[str]:
        """List directory contents (names only)."""
        pass

    @abstractmethod
    def list_children(self, path: str) -> tuple[list[str], list[str]]:
        """List direct child directories and files (one listing when possible)."""
        pass

    @abstractmethod
    def list_subdirs(self, path: str) -> list[str]:
        """List direct child directory names only (excludes files)."""
        pass
    
    @abstractmethod
    def delete(self, path: str) -> None:
        """Delete a file."""
        pass


class LocalStorageBackend(StorageBackend):
    """Local filesystem storage backend."""
    
    def __init__(self, root: Path):
        self.root = root.resolve()
    
    def exists(self, path: str) -> bool:
        p = self._resolve(path)
        if p is None:
            return False
        return p.exists()
    
    def is_dir(self, path: str) -> bool:
        p = self._resolve(path)
        if p is None:
            return False
        return p.is_dir()
    
    def is_file(self, path: str) -> bool:
        p = self._resolve(path)
        if p is None:
            return False
        return p.is_file()
    
    def read_bytes(self, path: str, max_bytes: int | None = None) -> bytes:
        p = self._resolve(path)
        if p is None:
            raise FileNotFoundError(f"Path not found: {path}")
        if max_bytes is None:
            return p.read_bytes()
        with open(p, "rb") as f:
            return f.read(max_bytes)
    
    def write_bytes(self, path: str, data: bytes, content_type: str | None = None) -> None:
        p = self._resolve(path)
        if p is None:
            raise ValueError(f"Invalid path: {path}")
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + f".tmp.{uuid.uuid4().hex}")
        tmp.write_bytes(data)
        tmp.replace(p)
    
    def list_dir(self, path: str) -> list[str]:
        subdirs, files = self.list_children(path)
        return sorted(subdirs + files, key=lambda x: x.lower())

    def list_children(self, path: str) -> tuple[list[str], list[str]]:
        p = self._resolve(path)
        if p is None or not p.is_dir():
            return [], []
        subdirs: list[str] = []
        files: list[str] = []
        for item in p.iterdir():
            if item.name.startswith("."):
                continue
            if item.is_dir():
                subdirs.append(item.name)
            elif item.is_file():
                files.append(item.name)
        sort_key = lambda x: x.lower()
        return sorted(subdirs, key=sort_key), sorted(files, key=sort_key)

    def list_subdirs(self, path: str) -> list[str]:
        return self.list_children(path)[0]
    
    def delete(self, path: str) -> None:
        p = self._resolve(path)
        if p is not None and p.exists():
            p.unlink()
    
    def _resolve(self, path: str) -> Path | None:
        """Safely resolve path within root."""
        if not path:
            return self.root
        
        # Handle absolute path (must be within or equal to root)
        if path.startswith("/"):
            resolved = Path(path).resolve()
            if resolved == self.root or self.root in resolved.parents:
                return resolved
            return None
        
        # Handle relative path
        parts = [p for p in path.split("/") if p]
        if any(p in (".", "..") for p in parts):
            return None
        resolved = (self.root / "/".join(parts)).resolve()
        if self.root not in resolved.parents and resolved != self.root:
            return None
        return resolved


class FirebaseStorageBackend(StorageBackend):
    """Firebase Cloud Storage backend."""
    
    def __init__(self, bucket_name: str, credentials_path: str | None = None):
        global _firebase_app
        if not FIREBASE_AVAILABLE:
            raise ImportError("firebase-admin is not installed. Install it with: pip install firebase-admin")
        
        service_account_info = build_firebase_service_account_info()
        if _firebase_app is None:
            if credentials_path:
                creds = credentials.Certificate(credentials_path)
                _firebase_app = firebase_admin.initialize_app(creds, {
                    'storageBucket': bucket_name
                })
                _explorer_log("FirebaseStorage", "Using Firebase credentials from explicit credentials file")
            elif service_account_info:
                creds = credentials.Certificate(service_account_info)
                _firebase_app = firebase_admin.initialize_app(creds, {
                    'storageBucket': bucket_name
                })
                _explorer_log("FirebaseStorage", "Using Firebase credentials from FIREBASE_ADMIN_* env vars")
            else:
                _firebase_app = firebase_admin.initialize_app(options={
                    'storageBucket': bucket_name
                })
                _explorer_log("FirebaseStorage", "Using default Firebase credentials / ADC")
        
        # Ensure google.auth.default() resolves to the explicit credentials
        # instead of falling back to gcloud (which hangs when gcloud is
        # not installed or not authenticated).
        if credentials_path and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
        self.bucket = storage.bucket()
    
    def exists(self, path: str) -> bool:
        try:
            blob = self.bucket.get_blob(path)
            return blob is not None
        except Exception:
            return False
    
    def is_dir(self, path: str) -> bool:
        """Check if path is a 'directory' (has children)."""
        try:
            path = path.rstrip("/") + "/"
            blobs = list(self.bucket.list_blobs(prefix=path, max_results=1))
            return len(blobs) > 0
        except Exception:
            return False
    
    def is_file(self, path: str) -> bool:
        """Check if path is a file (blob exists)."""
        try:
            blob = self.bucket.get_blob(path)
            return blob is not None
        except Exception:
            return False
    
    def read_bytes(self, path: str, max_bytes: int | None = None) -> bytes:
        blob = self.bucket.blob(path)
        if not blob.exists():
            raise FileNotFoundError(f"Path not found: {path}")
        if max_bytes is None:
            return blob.download_as_bytes()
        return blob.download_as_bytes(start=0, end=max_bytes - 1)
    
    def write_bytes(self, path: str, data: bytes, content_type: str | None = None) -> None:
        blob = self.bucket.blob(path)
        if not content_type:
            if path.endswith('.json'):
                content_type = 'application/json; charset=utf-8'
            elif path.endswith('.txt'):
                content_type = 'text/plain; charset=utf-8'
            elif path.endswith('.wav'):
                content_type = 'audio/wav'
            else:
                content_type = 'application/octet-stream'
        blob.upload_from_string(data, content_type=content_type)
    
    def _firebase_list_children(self, path: str) -> tuple[list[str], list[str]]:
        path = path.rstrip("/")
        if path:
            path += "/"
        blobs = self.bucket.list_blobs(prefix=path, delimiter="/")
        subdirs: set[str] = set()
        files: set[str] = set()
        for page in blobs.pages:
            for prefix in getattr(page, "prefixes", []):
                name = prefix[len(path):].rstrip("/")
                if name and not name.startswith("."):
                    subdirs.add(name)
            for blob in page:
                rel = blob.name[len(path):] if path else blob.name
                if not rel or "/" in rel or rel.startswith("."):
                    continue
                files.add(rel)
        sort_key = lambda x: x.lower()
        return sorted(subdirs, key=sort_key), sorted(files, key=sort_key)

    def list_dir(self, path: str) -> list[str]:
        subdirs, files = self.list_children(path)
        return sorted(subdirs + files, key=lambda x: x.lower())

    def list_children(self, path: str) -> tuple[list[str], list[str]]:
        try:
            return self._firebase_list_children(path)
        except Exception as exc:
            _explorer_log("FirebaseStorage.list_children", f"failed prefix={path!r}: {exc}")
            return [], []

    def list_subdirs(self, path: str) -> list[str]:
        return self.list_children(path)[0]
    
    def delete(self, path: str) -> None:
        try:
            blob = self.bucket.blob(path)
            blob.delete()
        except Exception:
            pass


@dataclass(frozen=True)
class ExplorerConfig:
    source: str  # "local" or "firebase"
    root: str  # Local path or Firebase path prefix
    storage: StorageBackend
    bucket: str | None = None


def _get_config() -> ExplorerConfig:
    source = (os.environ.get("FRONTEND_SOURCE") or "").strip().lower()
    if source not in ("local", "firebase"):
        source = "local"
    
    if source == "local":
        root = (os.environ.get("EXPLORER_LOCAL_ROOT") or "").strip()
        if not root:
            raise ValueError(
                "Missing EXPLORER_LOCAL_ROOT env var. "
                "Set it with: export EXPLORER_LOCAL_ROOT=/abs/path"
            )
        root_path = Path(root)
        if not root_path.is_absolute():
            raise ValueError("EXPLORER_LOCAL_ROOT must be an absolute path")
        if not root_path.exists():
            raise ValueError(f"EXPLORER_LOCAL_ROOT does not exist: {root}")
        if not root_path.is_dir():
            raise ValueError(f"EXPLORER_LOCAL_ROOT is not a directory: {root}")
        
        storage_backend = LocalStorageBackend(root_path)
        return ExplorerConfig(
            source="local",
            root=str(root_path.resolve()),
            storage=storage_backend,
            bucket=None
        )
    
    else:  # firebase
        bucket = (os.environ.get("FRONTEND_FIREBASE_BUCKET") or "").strip()
        if not bucket:
            raise ValueError(
                "Missing FRONTEND_FIREBASE_BUCKET env var for Firebase mode. "
                "Set it with: export FRONTEND_FIREBASE_BUCKET=your-bucket-name"
            )
        
        creds_path = resolve_firebase_credentials_path()
        creds_path = creds_path if creds_path else None
        
        prefix = (os.environ.get("EXPLORER_FIREBASE_PREFIX") or "").strip()
        prefix = prefix.rstrip("/") if prefix else ""
        
        try:
            storage_backend = FirebaseStorageBackend(bucket, creds_path)
        except ImportError as e:
            raise ImportError(f"Firebase mode requires firebase-admin: {e}")
        
        return ExplorerConfig(
            source="firebase",
            root=prefix,
            storage=storage_backend,
            bucket=bucket
        )


def _is_safe_relpath(rel: str) -> bool:
    if not rel:
        return False
    if rel.startswith("/"):
        return False
    parts = [p for p in rel.split("/") if p]
    if any(p in (".", "..") for p in parts):
        return False
    return True


def _join_path(root: str, rel: str) -> str:
    """Join root and relative paths, validating safety."""
    if not _is_safe_relpath(rel):
        raise ValueError("Invalid path")
    if not root:
        return rel
    root = root.rstrip("/")
    return f"{root}/{rel}"


def _read_json(storage: StorageBackend, path: str) -> Any:
    raw = storage.read_bytes(path)
    return json.loads(raw.decode("utf-8"))


DATA_JSON_SCHEMA_VERSION = "1.1.1"


def _extract_data(data: Any) -> tuple[list[Any], str]:
    """Return (records, mode) from parsed data.json.

    mode is either:
      - 'list' for a top-level JSON array (legacy)
      - 'dict_data' for an object containing a 'data' array (preferred)
      - 'dict_entries' for an object containing an 'entries' array (legacy)
    """
    if isinstance(data, list):
        return data, "list"
    if isinstance(data, dict):
        records = data.get("data")
        if isinstance(records, list):
            return records, "dict_data"
        records = data.get("entries")
        if isinstance(records, list):
            return records, "dict_entries"
    raise ValueError(
        "data.json must contain a JSON array (or an object with a 'data' array)"
    )


def _persist_data_json(
    storage: StorageBackend,
    path: str,
    original: Any,
    records: list[Any],
    mode: str,
) -> None:
    """Write records back to data.json using the canonical {schema_version, data} shape."""
    # Normalize entries to conform to schema before writing
    normalized = [_normalize_entry(r) for r in records]

    if mode == "list" or not isinstance(original, dict):
        payload = {
            "schema_version": DATA_JSON_SCHEMA_VERSION,
            "data": normalized,
        }
        _atomic_write_json(storage, path, payload)
        return

    original.pop("entries", None)
    original["data"] = normalized
    if "schema_version" not in original:
        original["schema_version"] = DATA_JSON_SCHEMA_VERSION
    _atomic_write_json(storage, path, original)


_extract_entries = _extract_data


def _atomic_write_json(storage: StorageBackend, path: str, obj: Any) -> None:
    data_str = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    storage.write_bytes(path, data_str.encode("utf-8"))


def _now_iso_z() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Ensure an entry has the expected keys/types according to schema v1.1.1.

    - `inference_transcript`: string (default "")
    - `inference_confidence`: number 0..100 (default 0)
    - preserve existing `is_reviewed` if present, but do not automatically add it
    - `audio_duration`: numeric (default 0.0)
    - `entry_id`, `entry_timestamp`: set if missing
    """
    if not isinstance(entry, dict):
        return entry
    e = dict(entry)

    # identifiers / timestamps
    if not e.get("entry_id"):
        e["entry_id"] = str(uuid.uuid4())
    if not e.get("entry_timestamp"):
        e["entry_timestamp"] = _now_iso_z()

    # audio fields
    e["audio_data"] = e.get("audio_data") or ""
    e["audio_source"] = e.get("audio_source") or ""

    # duration
    dur = e.get("audio_duration", 0)
    try:
        if isinstance(dur, str):
            dur = float(dur) if dur.strip() else 0.0
        elif not isinstance(dur, (int, float)):
            dur = 0.0
    except Exception:
        dur = 0.0
    e["audio_duration"] = round(float(dur), 3)

    # inference fields
    e["inference_transcript"] = e.get("inference_transcript") or ""
    conf = e.get("inference_confidence")
    try:
        if conf is None:
            conf_n = 0.0
        else:
            conf_n = float(conf)
    except Exception:
        conf_n = 0.0
    conf_n = max(0.0, min(100.0, conf_n))
    e["inference_confidence"] = conf_n
    # review/user flags
    if "user_is_validated" in e:
        if e["user_is_validated"] is not None:
            e["user_is_validated"] = _coerce_bool(e["user_is_validated"])
        else:
            e["user_is_validated"] = None
    else:
        e["user_is_validated"] = None

    if "is_reviewed" in e:
        e["is_reviewed"] = _coerce_bool(e["is_reviewed"])
    e["reviewer_transcript_corrected"] = (
        e.get("reviewer_transcript_corrected")
        or e.get("reviewer_corrected_transcript")
        or e.get("reviewer_trasncript_corrected")
        or ""
    )

    return e


def _coerce_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        return v.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def _entry_duration_seconds(entry: dict) -> float:
    for key in (
        "duration",
        "duration_seconds",
        "audio_duration",
        "audio_duration_seconds",
        "len_seconds",
        "length_seconds",
        "seconds",
    ):
        v = entry.get(key)
        if isinstance(v, (int, float)) and v >= 0:
            return float(v)
        if isinstance(v, str):
            try:
                x = float(v.strip())
                if x >= 0:
                    return x
            except Exception:
                pass
    return 0.0


def _format_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if h:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:d}:{s:02d}"


def _processed_path(root: str) -> str:
    if not root:
        return "metadata_processed-folders.json"
    return f"{root}/metadata_processed-folders.json"


def _folders_json_path(root: str) -> str:
    if not root:
        return "folders.json"
    return f"{root}/folders.json"


def _folder_is_processed(record: dict[str, Any]) -> bool:
    if "is_processed" in record:
        return _coerce_bool(record.get("is_processed"))
    return _coerce_bool(record.get("is_reviewed"))


def _folder_stats_are_computed(record: dict[str, Any]) -> bool:
    if "stats_computed" in record:
        return _coerce_bool(record.get("stats_computed"))
    return (
        _coerce_float(record.get("n_audios", 0)) > 0
        or _coerce_float(record.get("audios_duration", 0)) > 0
        or _coerce_float(record.get("%_validated", 0)) > 0
    )


def _build_folder_record(
    folder_name: str,
    n_audios: int,
    audios_duration: float,
    is_processed: bool,
    *,
    pct_validated: float = 0.0,
    n_audios_reviewed: int = 0,
    reviewed_audios_duration: float | None = None,
    stats_computed: bool = False,
) -> dict[str, Any]:
    record = {
        "folder_name": folder_name,
        "is_processed": is_processed,
        "n_audios": n_audios,
        "audios_duration": round(audios_duration, 3),
        "%_validated": round(pct_validated, 3),
        "n_audios_reviewed": n_audios_reviewed,
        "stats_computed": stats_computed,
    }
    if reviewed_audios_duration is not None:
        record["reviewed_audios_duration"] = round(reviewed_audios_duration, 3)
    return record


def _read_folders_records(storage: StorageBackend, root: str) -> list[dict[str, Any]]:
    path = _folders_json_path(root)
    if not storage.exists(path):
        return []
    try:
        data = _read_json(storage, path)
        if isinstance(data, list):
            return [r for r in data if isinstance(r, dict) and r.get("folder_name")]
    except Exception:
        pass
    return []


def _write_folders_records(
    storage: StorageBackend,
    root: str,
    records: list[dict[str, Any]],
    *,
    last_synced_at: str | None = None,
) -> None:
    timestamp = last_synced_at or next(
        (str(record["last_synced_at"]) for record in records if record.get("last_synced_at")),
        None,
    )
    if timestamp is None:
        path = _folders_json_path(root)
        if storage.exists(path):
            try:
                previous = _read_json(storage, path)
                if isinstance(previous, list):
                    timestamp = next(
                        (
                            str(record["last_synced_at"])
                            for record in previous
                            if isinstance(record, dict) and record.get("last_synced_at")
                        ),
                        None,
                    )
            except Exception:
                pass

    sorted_records = sorted(
        (dict(record) for record in records),
        key=lambda record: str(record.get("folder_name", "")).lower(),
    )
    if timestamp:
        for record in sorted_records:
            record["last_synced_at"] = timestamp
        if not sorted_records:
            sorted_records.append({"_metadata": True, "last_synced_at": timestamp})
    _atomic_write_json(storage, _folders_json_path(root), sorted_records)


def _read_folders_last_synced_at(storage: StorageBackend, root: str) -> str | None:
    path = _folders_json_path(root)
    if not storage.exists(path):
        return None
    try:
        data = _read_json(storage, path)
        if isinstance(data, list):
            return next(
                (
                    str(record["last_synced_at"])
                    for record in data
                    if isinstance(record, dict) and record.get("last_synced_at")
                ),
                None,
            )
    except Exception:
        pass
    return None


def _folders_index_by_name(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(r["folder_name"]): r for r in records}


def _read_legacy_processed(storage: StorageBackend, root: str) -> list[str]:
    path = _processed_path(root)
    if not storage.exists(path):
        return []
    try:
        data = _read_json(storage, path)
        if isinstance(data, list):
            return [str(x).rstrip("/") for x in data]
    except Exception:
        return []
    return []


def _read_processed(storage: StorageBackend, root: str) -> list[str]:
    if _folders_json_exists(storage, root):
        return sorted(
            str(r["folder_name"])
            for r in _read_folders_records(storage, root)
            if _folder_is_processed(r)
        )
    return _read_legacy_processed(storage, root)


def _folder_processed_status(
    storage: StorageBackend,
    root: str,
    folder_name: str,
    folders_index: dict[str, dict[str, Any]] | None = None,
) -> bool:
    """Return processed flag for a folder from folders.json, or legacy metadata."""
    if _folders_json_exists(storage, root):
        if folders_index is None:
            folders_index = _folders_index_by_name(_read_folders_records(storage, root))
        record = folders_index.get(folder_name)
        return _folder_is_processed(record) if record is not None else False
    return folder_name in set(_read_legacy_processed(storage, root))


def _list_dataset_folder_names(storage: StorageBackend, root: str) -> list[str]:
    return storage.list_subdirs(root)


def _compute_pct_validated_from_entries(entries: list[Any]) -> float:
    total = len(entries)
    if total == 0:
        return 0.0
    validated = sum(
        1
        for entry in entries
        if isinstance(entry, dict) and _coerce_bool(entry.get("user_is_validated", False))
    )
    return round((validated / total) * 100.0, 3)


def _find_folder_data_json(
    storage: StorageBackend,
    root: str,
    folder: str,
) -> str | None:
    folder_path = _join_path(root, folder)
    filenames = storage.list_dir(folder_path)
    dated_names = sorted(
        (
            name
            for name in filenames
            if re.fullmatch(r"(?:\d{6}|\d{8})_data\.json", name)
            and storage.is_file(_join_path(folder_path, name))
        ),
        reverse=True,
    )
    if dated_names:
        return _join_path(folder_path, dated_names[0])

    legacy_path = _join_path(folder_path, "data.json")
    return legacy_path if storage.exists(legacy_path) else None


def _load_folder_entries(
    storage: StorageBackend,
    root: str,
    folder: str,
) -> list[Any]:
    data_path = _find_folder_data_json(storage, root, folder)
    if data_path is None:
        return []
    data = _read_json(storage, data_path)
    entries, _ = _extract_entries(data)
    return entries


def _unique_inference_model_versions_from_entries(entries: list[Any]) -> list[str]:
    seen: set[str] = set()
    versions: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        version = str(
            entry.get("inference_model_version")
            or entry.get("inference_model")
            or ""
        ).strip()
        if not version or version in seen:
            continue
        seen.add(version)
        versions.append(version)
    return sorted(versions, key=str.lower)


def _is_aggregate_folder(folder: str) -> bool:
    return folder in ("*", "__all__", "all")


def _load_all_folder_entries(storage: StorageBackend, root: str) -> list[Any]:
    entries: list[Any] = []
    for folder in _list_dataset_folder_names(storage, root):
        entries.extend(_load_folder_entries(storage, root, folder))
    return entries


def _load_folder_entries_for_names(
    storage: StorageBackend,
    root: str,
    folder_names: set[str],
) -> list[Any]:
    entries: list[Any] = []
    for folder in sorted(folder_names):
        entries.extend(_read_folder_entries(storage, root, folder))
    return entries


def _compute_aggregate_stats(
    storage: StorageBackend,
    root: str,
    *,
    include_model_versions: bool = False,
    timeline_folder_names: set[str] | None = None,
) -> dict[str, Any]:
    with _lock:
        _sync_folders_json_manifest(storage, root)
    records = _read_folders_records(storage, root)

    if timeline_folder_names is None:
        events = _read_timeline_events(storage, root)
        timeline_folder_names = _folder_names_from_timeline_events(
            events,
            folder_records=records,
        )

    records = [
        record
        for record in records
        if str(record.get("folder_name", "")) in timeline_folder_names
    ]

    total_audios = 0
    validated_audios = 0
    total_duration = 0.0
    processed_folders = 0

    for record in records:
        n_audios = int(record.get("n_audios", 0))
        pct_validated = float(record.get("%_validated", 0))
        total_audios += n_audios
        if n_audios:
            validated_audios += round(n_audios * pct_validated / 100.0)
        total_duration += float(record.get("audios_duration", 0))
        if _folder_is_processed(record):
            processed_folders += 1

    inference_model_versions: list[str] | None = None
    if include_model_versions:
        inference_model_versions = _unique_inference_model_versions_from_entries(
            _load_folder_entries_for_names(storage, root, timeline_folder_names)
        )

    folder_count = len(records)
    pct_validated = (
        round(validated_audios / total_audios * 100.0, 3) if total_audios else 0.0
    )

    result: dict[str, Any] = {
        "folder": "*",
        "aggregate": True,
        "folder_count": folder_count,
        "processed_folders": processed_folders,
        "processed": processed_folders == folder_count and folder_count > 0,
        "total_audios": total_audios,
        "validated_audios": validated_audios,
        "pct_validated": pct_validated,
        "total_duration_str": _format_duration(total_duration),
    }
    if inference_model_versions is not None:
        result["inference_model_versions"] = inference_model_versions
    return result


def _collect_aggregate_model_versions(
    storage: StorageBackend,
    root: str,
) -> list[str]:
    with _lock:
        _sync_folders_json_manifest(storage, root)
    records = _read_folders_records(storage, root)
    events = _read_timeline_events(storage, root)
    folder_names = _folder_names_from_timeline_events(events, folder_records=records)
    return _unique_inference_model_versions_from_entries(
        _load_folder_entries_for_names(storage, root, folder_names)
    )


def _read_folder_entries(
    storage: StorageBackend,
    root: str,
    folder: str,
) -> list[Any]:
    try:
        return _load_folder_entries(storage, root, folder)
    except Exception as exc:
        _explorer_log(
            "_read_folder_entries",
            f"failed folder={folder!r}: {exc}",
        )
        return []


def _compute_folder_stats(
    storage: StorageBackend,
    root: str,
    folder: str,
    *,
    log: bool = True,
) -> tuple[int, float, float, int, float]:
    if log:
        _explorer_log("_compute_folder_audio_stats", f"start folder={folder!r}")
    t0 = time.monotonic()
    data_path = _find_folder_data_json(storage, root, folder)
    total_audios = 0
    total_duration = 0.0
    pct_validated = 0.0
    n_audios_reviewed = 0
    reviewed_audios_duration = 0.0
    if data_path is not None:
        try:
            if log:
                _explorer_log("_compute_folder_audio_stats", f"reading {data_path!r}")
            entries = _load_folder_entries(storage, root, folder)
            total_audios = len(entries)
            for entry in entries:
                if isinstance(entry, dict):
                    entry_duration = _entry_duration_seconds(entry)
                    total_duration += entry_duration
                    if _coerce_bool(entry.get("reviewer_is_reviewed", False)):
                        reviewed_audios_duration += entry_duration
            pct_validated = _compute_pct_validated_from_entries(entries)
            n_audios_reviewed = sum(
                1
                for entry in entries
                if isinstance(entry, dict)
                and _coerce_bool(entry.get("reviewer_is_reviewed", False))
            )
        except Exception as exc:
            if log:
                _explorer_log(
                    "_compute_folder_audio_stats",
                    f"failed folder={folder!r}: {exc}",
                )
    elif log:
        _explorer_log(
            "_compute_folder_audio_stats",
            f"no folder data JSON for folder={folder!r}",
        )
    if log:
        _explorer_log(
            "_compute_folder_audio_stats",
            f"done folder={folder!r}: n_audios={total_audios}, "
            f"duration={total_duration:.3f}s, %_validated={pct_validated:.3f}, "
            f"elapsed={time.monotonic() - t0:.2f}s",
        )
    return (
        total_audios,
        total_duration,
        pct_validated,
        n_audios_reviewed,
        reviewed_audios_duration,
    )


def _compute_folder_audio_stats(
    storage: StorageBackend,
    root: str,
    folder: str,
    *,
    log: bool = True,
) -> tuple[int, float]:
    n_audios, audios_duration, _, _, _ = _compute_folder_stats(storage, root, folder, log=log)
    return n_audios, audios_duration


def _folder_to_api_dict(
    storage: StorageBackend,
    root: str,
    name: str,
    record: dict[str, Any] | None,
    folders_index: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if record is None:
        record = folders_index.get(name)
    if record is not None:
        processed = _folder_is_processed(record)
    else:
        processed = _folder_processed_status(storage, root, name, folders_index)
    out: dict[str, Any] = {"name": name, "processed": processed}
    if record is not None:
        out["total_audios"] = int(record.get("n_audios", 0))
        out["audios_duration"] = float(record.get("audios_duration", 0))
        out["total_duration_str"] = _format_duration(out["audios_duration"])
    return out


def _get_folder_record(
    storage: StorageBackend,
    root: str,
    folder_name: str,
) -> dict[str, Any] | None:
    for record in _read_folders_records(storage, root):
        if record.get("folder_name") == folder_name:
            return record
    return None


def _folders_json_exists(storage: StorageBackend, root: str) -> bool:
    return storage.exists(_folders_json_path(root))


def _apply_folder_stats(
    record: dict[str, Any],
    n_audios: int,
    audios_duration: float,
    pct_validated: float,
    n_audios_reviewed: int,
    reviewed_audios_duration: float,
) -> None:
    record["n_audios"] = n_audios
    record["audios_duration"] = round(audios_duration, 3)
    record["%_validated"] = round(pct_validated, 3)
    record["n_audios_reviewed"] = n_audios_reviewed
    record["reviewed_audios_duration"] = round(reviewed_audios_duration, 3)
    record["stats_computed"] = True
    record.pop("is_reviewed", None)


def _sync_folders_json_manifest(
    storage: StorageBackend,
    root: str,
) -> tuple[list[str], list[str]]:
    """Ensure folders.json lists dataset folders only; append missing folders (fast)."""
    folder_names, root_files = storage.list_children(root)

    if not _folders_json_exists(storage, root):
        legacy_processed = set(_read_legacy_processed(storage, root))
        records = [
            _build_folder_record(name, 0, 0.0, name in legacy_processed)
            for name in folder_names
        ]
        for name in sorted(legacy_processed - set(folder_names), key=str.lower):
            records.append(_build_folder_record(name, 0, 0.0, True))
        if records:
            _write_folders_records(storage, root, records)
        return folder_names, root_files

    index = _folders_index_by_name(_read_folders_records(storage, root))
    changed = False
    for name in folder_names:
        if name not in index:
            index[name] = _build_folder_record(name, 0, 0.0, False)
            changed = True
    if changed:
        _write_folders_records(storage, root, list(index.values()))
    return folder_names, root_files


def _refresh_folders_json(storage: StorageBackend, root: str) -> None:
    """Recompute n_audios and audios_duration for every folder (slow; use sparingly)."""
    _explorer_log("_refresh_folders_json", f"full stats refresh start root={root!r}")
    t_refresh = time.monotonic()

    if not _folders_json_exists(storage, root):
        _explorer_log("_refresh_folders_json", "folders.json missing — building from dataset folders")
        folder_names = _list_dataset_folder_names(storage, root)
        _explorer_log(
            "_refresh_folders_json",
            f"listed {len(folder_names)} dataset folder(s), reading legacy processed metadata",
        )

        legacy_processed = set(_read_legacy_processed(storage, root))
        _explorer_log(
            "_refresh_folders_json",
            f"{len(legacy_processed)} legacy processed folder(s)",
        )

        records: list[dict[str, Any]] = []

        for i, name in enumerate(folder_names, start=1):
            _explorer_log(
                "_refresh_folders_json",
                f"({i}/{len(folder_names)}) stats for {name!r}",
            )
            n_audios, audios_duration, pct_validated, n_audios_reviewed, reviewed_audios_duration = _compute_folder_stats(
                storage, root, name
            )
            is_processed = name in legacy_processed
            records.append(
                _build_folder_record(
                    name,
                    n_audios,
                    audios_duration,
                    is_processed,
                    pct_validated=pct_validated,
                    n_audios_reviewed=n_audios_reviewed,
                    reviewed_audios_duration=reviewed_audios_duration,
                    stats_computed=True,
                )
            )

        legacy_only = sorted(legacy_processed - set(folder_names), key=str.lower)
        for i, name in enumerate(legacy_only, start=1):
            _explorer_log(
                "_refresh_folders_json",
                f"({i}/{len(legacy_only)}) legacy-only folder {name!r}",
            )
            records.append(_build_folder_record(name, 0, 0.0, True, stats_computed=False))

        if records:
            _explorer_log(
                "_refresh_folders_json",
                f"writing folders.json with {len(records)} record(s)",
            )
            _write_folders_records(storage, root, records)
        _explorer_log(
            "_refresh_folders_json",
            f"done (created) in {time.monotonic() - t_refresh:.2f}s",
        )
        return

    _explorer_log("_refresh_folders_json", "folders.json exists — refreshing stats in place")
    existing_records = _read_folders_records(storage, root)
    _explorer_log(
        "_refresh_folders_json",
        f"loaded {len(existing_records)} existing record(s) from folders.json",
    )
    index = _folders_index_by_name(existing_records)
    folder_names = _list_dataset_folder_names(storage, root)
    for i, name in enumerate(folder_names, start=1):
        _explorer_log(
            "_refresh_folders_json",
            f"({i}/{len(folder_names)}) update stats for {name!r}",
        )
        n_audios, audios_duration, pct_validated, n_audios_reviewed, reviewed_audios_duration = _compute_folder_stats(
            storage, root, name
        )
        existing = index.get(name)
        if existing is not None:
            _apply_folder_stats(
                existing, n_audios, audios_duration, pct_validated, n_audios_reviewed,
                reviewed_audios_duration,
            )
            index[name] = existing
        else:
            index[name] = _build_folder_record(
                name,
                n_audios,
                audios_duration,
                False,
                pct_validated=pct_validated,
                n_audios_reviewed=n_audios_reviewed,
                reviewed_audios_duration=reviewed_audios_duration,
                stats_computed=True,
            )
    _explorer_log(
        "_refresh_folders_json",
        f"writing folders.json with {len(index)} record(s)",
    )
    _write_folders_records(storage, root, list(index.values()))
    _explorer_log(
        "_refresh_folders_json",
        f"done (updated) in {time.monotonic() - t_refresh:.2f}s",
    )


def _update_folder_stats_in_folders_json(
    storage: StorageBackend,
    root: str,
    folder_name: str,
) -> None:
    n_audios, audios_duration, pct_validated, n_audios_reviewed, reviewed_audios_duration = _compute_folder_stats(
        storage, root, folder_name
    )
    records = _read_folders_records(storage, root)
    index = _folders_index_by_name(records)
    existing = index.get(folder_name)
    if existing is not None:
        _apply_folder_stats(
            existing, n_audios, audios_duration, pct_validated, n_audios_reviewed,
            reviewed_audios_duration,
        )
        index[folder_name] = existing
    else:
        index[folder_name] = _build_folder_record(
            folder_name,
            n_audios,
            audios_duration,
            False,
            pct_validated=pct_validated,
            n_audios_reviewed=n_audios_reviewed,
            reviewed_audios_duration=reviewed_audios_duration,
            stats_computed=True,
        )
    _write_folders_records(storage, root, list(index.values()))


def _refresh_missing_folders_json(
    storage: StorageBackend,
    root: str,
) -> tuple[int, int]:
    """Compute and persist statistics only for folders without cached stats."""
    folder_names = _list_dataset_folder_names(storage, root)
    records = _read_folders_records(storage, root)
    index = _folders_index_by_name(records)
    refreshed = 0

    for name in folder_names:
        existing = index.get(name)
        if (
            existing is not None
            and _folder_stats_are_computed(existing)
            and "reviewed_audios_duration" in existing
        ):
            continue
        n_audios, audios_duration, pct_validated, n_audios_reviewed, reviewed_audios_duration = _compute_folder_stats(
            storage, root, name
        )
        if existing is None:
            index[name] = _build_folder_record(
                name,
                n_audios,
                audios_duration,
                False,
                pct_validated=pct_validated,
                n_audios_reviewed=n_audios_reviewed,
                reviewed_audios_duration=reviewed_audios_duration,
                stats_computed=True,
            )
        else:
            _apply_folder_stats(
                existing, n_audios, audios_duration, pct_validated, n_audios_reviewed,
                reviewed_audios_duration,
            )
        refreshed += 1

    if refreshed:
        _write_folders_records(storage, root, list(index.values()))
    return refreshed, len(folder_names)


def _update_folder_processed_in_folders_json(
    storage: StorageBackend,
    root: str,
    folder_name: str,
    is_processed: bool,
) -> None:
    records = _read_folders_records(storage, root)
    index = _folders_index_by_name(records)
    existing = index.get(folder_name)
    if existing is not None:
        existing.pop("is_reviewed", None)
        existing["is_processed"] = is_processed
        index[folder_name] = existing
    else:
        n_audios, audios_duration, pct_validated, n_audios_reviewed, reviewed_audios_duration = _compute_folder_stats(
            storage, root, folder_name
        )
        index[folder_name] = _build_folder_record(
            folder_name,
            n_audios,
            audios_duration,
            is_processed,
            pct_validated=pct_validated,
            n_audios_reviewed=n_audios_reviewed,
            reviewed_audios_duration=reviewed_audios_duration,
        )
    _write_folders_records(storage, root, list(index.values()))


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/explorer")
def explorer_ui():
    return render_template("explorer.html")


@app.get("/recorder")
def recorder_ui():
    return render_template("recorder.html")


@app.get("/analyze")
def analyze_ui():
    return render_template("analyze.html")


_FOLDER_DATE_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})")
TIMELINE_JSON = "timeline.json"
TIMELINE_EVENT_NAME = "keyboard"
TIMELINE_EVENT_TYPE = "data"
TIMELINE_MIN_FOLDER_DATE = "20260601"


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


def _read_timeline_events(storage: StorageBackend, root: str) -> list[dict[str, Any]]:
    path = _join_path(root, "timeline.json")
    if not storage.exists(path):
        return []
    data = _read_json(storage, path)
    if not isinstance(data, list):
        raise ValueError("timeline.json must be a JSON array")
    events: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        date = item.get("date")
        name = item.get("name")
        event_type = item.get("type")
        if not date or not name or not event_type:
            continue
        events.append({
            "date": str(date),
            "name": str(name),
            "type": str(event_type),
        })
    return events


def _timeline_json_path(root: str) -> str:
    return _join_path(root, TIMELINE_JSON)


def _write_timeline_events(
    storage: StorageBackend,
    root: str,
    events: list[dict[str, Any]],
) -> None:
    payload = [
        {
            "date": str(e["date"]),
            "name": str(e["name"]),
            "type": str(e["type"]),
        }
        for e in events
        if e.get("date") and e.get("name") and e.get("type")
    ]
    payload.sort(key=lambda e: (str(e["date"]), 0 if e["type"] == TIMELINE_EVENT_TYPE else 1))
    _atomic_write_json(storage, _timeline_json_path(root), payload)


def _validated_folders_for_timeline(
    folder_records: list[dict[str, Any]],
) -> list[tuple[str, str]]:
    """Return eligible (date, folder_name) pairs, whether stats are cached or not."""
    folders: list[tuple[str, str]] = []
    for record in folder_records:
        folder_name = record.get("folder_name")
        if not folder_name:
            continue
        folder_name = str(folder_name)
        if "dgx" not in folder_name.lower():
            continue
        date = _date_from_folder_name(str(folder_name))
        if not date:
            continue
        if date.replace(".", "") <= TIMELINE_MIN_FOLDER_DATE:
            continue
        folders.append((date, folder_name))
    folders.sort(key=lambda item: (item[0], item[1]))
    return folders


def _find_missing_timeline_events(
    folder_records: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """Return data events to add for validated folders not yet in timeline.json."""
    folders = _validated_folders_for_timeline(folder_records)
    data_events = sorted(
        [e for e in events if e.get("type") == TIMELINE_EVENT_TYPE],
        key=lambda e: str(e.get("date", "")),
    )

    missing: list[dict[str, str]] = []
    event_idx = 0
    for date, _folder_name in folders:
        while event_idx < len(data_events) and data_events[event_idx]["date"] < date:
            event_idx += 1
        if event_idx < len(data_events) and data_events[event_idx]["date"] == date:
            event_idx += 1
            continue
        missing.append(
            {
                "date": date,
                "name": TIMELINE_EVENT_NAME,
                "type": TIMELINE_EVENT_TYPE,
            }
        )
    return missing


def _sync_timeline_json(storage: StorageBackend, root: str) -> bool:
    """Ensure timeline.json lists data events for validated folders. Returns True if updated."""
    _sync_folders_json_manifest(storage, root)
    folder_records = _read_folders_records(storage, root)
    timeline_path = _timeline_json_path(root)
    timeline_exists = storage.exists(timeline_path)
    events = _read_timeline_events(storage, root)
    missing = _find_missing_timeline_events(folder_records, events)
    if not missing and timeline_exists:
        return False
    merged = events + missing
    _write_timeline_events(storage, root, merged)
    return True


def _enrich_timeline_with_validated(
    events: list[dict[str, Any]],
    folder_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach pct_validated and folder_name by matching event date to folders.json."""
    folders_by_date: dict[str, list[tuple[str, float | None, bool]]] = {}
    for record in folder_records:
        folder_name = record.get("folder_name")
        if not folder_name:
            continue
        folder_name = str(folder_name)
        if "dgx" not in folder_name.lower():
            continue
        pct = (
            _coerce_float(record.get("%_validated", 0))
            if _folder_stats_are_computed(record)
            else None
        )
        date = _date_from_folder_name(folder_name)
        if not date:
            continue
        if date.replace(".", "") <= TIMELINE_MIN_FOLDER_DATE:
            continue
        folders_by_date.setdefault(date, []).append(
            (folder_name, pct, _folder_is_processed(record))
        )

    for date in folders_by_date:
        folders_by_date[date].sort(key=lambda item: item[0])

    date_counters: dict[str, int] = {}
    enriched: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != TIMELINE_EVENT_TYPE:
            enriched.append({
                **event,
                "folder_name": None,
                "pct_validated": None,
                "processed": False,
            })
            continue

        date = str(event["date"])
        idx = date_counters.get(date, 0)
        date_counters[date] = idx + 1
        folder_name = None
        pct_validated = None
        processed = False
        matches = folders_by_date.get(date, [])
        if idx < len(matches):
            folder_name, pct_validated, processed = matches[idx]
        enriched.append({
            **event,
            "folder_name": folder_name,
            "pct_validated": pct_validated,
            "processed": processed,
        })
    return enriched


def _folder_names_from_timeline_events(
    events: list[dict[str, Any]],
    *,
    folder_records: list[dict[str, Any]] | None = None,
) -> set[str]:
    """Return folder names linked to data events in timeline.json."""
    if folder_records is not None:
        events = _enrich_timeline_with_validated(events, folder_records)
    folders: set[str] = set()
    for event in events:
        if event.get("type") != TIMELINE_EVENT_TYPE:
            continue
        folder_name = event.get("folder_name")
        if folder_name:
            folders.add(str(folder_name))
    return folders


@app.get("/api/analyze_timeline")
def api_analyze_timeline():
    try:
        cfg = _get_config()
        with _lock:
            _sync_timeline_json(cfg.storage, cfg.root)
            _, root_files = _sync_folders_json_manifest(cfg.storage, cfg.root)
            events = _read_timeline_events(cfg.storage, cfg.root)
            folder_records = _read_folders_records(cfg.storage, cfg.root)
            enriched = _enrich_timeline_with_validated(events, folder_records)
            enriched = [
                event
                for event in enriched
                if event.get("type") != TIMELINE_EVENT_TYPE or event.get("folder_name")
            ]

        root_json_files = [name for name in root_files if name.endswith(".json")]
        enriched.sort(key=lambda e: (e.get("date", ""), 0 if e.get("type") == TIMELINE_EVENT_TYPE else 1))
        timeline_folder_names = _folder_names_from_timeline_events(enriched)
        aggregate_stats = _compute_aggregate_stats(
            cfg.storage,
            cfg.root,
            timeline_folder_names=timeline_folder_names,
        )
        return jsonify({
            "ok": True,
            "source": cfg.source,
            "root": cfg.root,
            "root_json_files": root_json_files,
            "events": enriched,
            "aggregate_stats": aggregate_stats,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


def _get_audio_duration_seconds(wav_bytes: bytes) -> float:
    try:
        with wave.open(io.BytesIO(wav_bytes), 'rb') as wf:
            return wf.getnframes() / wf.getframerate()
    except Exception:
        return 0.0


_AUDIO_PATH_KEYS = (
    "audio_data",
    "audio_file",
    "audio",
    "audio_filepath",
    "audio_path",
    "path",
    "file",
    "filename",
    "media",
)


def _entry_audio_rel(entry: dict) -> str | None:
    for key in _AUDIO_PATH_KEYS:
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _resolve_entry_audio_path(
    storage: StorageBackend,
    cfg: ExplorerConfig,
    folder_path: str,
    audio_rel: str,
) -> str | None:
    candidates: list[str] = []
    if _is_safe_relpath(audio_rel):
        candidates.append(_join_path(folder_path, audio_rel))
    basename = os.path.basename(audio_rel)
    if _is_safe_relpath(basename):
        candidates.append(_join_path(folder_path, basename))
    if cfg.source == "local" and _is_safe_relpath(audio_rel):
        candidates.append(_join_path(cfg.root, audio_rel))
    for candidate in candidates:
        if storage.exists(candidate) and storage.is_file(candidate):
            return candidate
    return None


def _trim_wav_bytes(wav_bytes: bytes, start_sec: float, end_sec: float) -> tuple[bytes, float]:
    """Trim a PCM WAV to [start_sec, end_sec) and return (bytes, duration_sec)."""
    if start_sec < 0 or end_sec <= start_sec:
        raise ValueError("Invalid trim range")

    with wave.open(io.BytesIO(wav_bytes), "rb") as src:
        n_channels = src.getnchannels()
        sampwidth = src.getsampwidth()
        framerate = src.getframerate()
        n_frames = src.getnframes()
        duration = n_frames / float(framerate) if framerate else 0.0

        if end_sec > duration + 1e-6:
            raise ValueError("end_sec exceeds audio duration")

        start_frame = max(0, min(n_frames, int(round(start_sec * framerate))))
        end_frame = max(0, min(n_frames, int(round(end_sec * framerate))))
        if end_frame <= start_frame:
            raise ValueError("Trim range produces empty audio")

        src.setpos(start_frame)
        frames = src.readframes(end_frame - start_frame)

    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setnchannels(n_channels)
        dst.setsampwidth(sampwidth)
        dst.setframerate(framerate)
        dst.writeframes(frames)

    trimmed = out.getvalue()
    return trimmed, _get_audio_duration_seconds(trimmed)


def _is_valid_recorder_folder(folder: str) -> bool:
    return bool(re.fullmatch(r"\d{8}_(?:[A-Za-z0-9_-]+_)?frontend", folder))


def _get_next_audio_number(storage: StorageBackend, folder_path: str) -> int:
    """Count .wav files in folder and return next sequential number (starting from 1).
    
    Args:
        storage: StorageBackend instance
        folder_path: Path to the folder in storage
        
    Returns:
        Next sequential number for audio file (1, 2, 3, ...)
    """
    try:
        # List all files in the folder
        files = storage.list_dir(folder_path)
        
        # Extract numeric parts from .wav files
        wav_numbers = []
        for filename in files:
            if filename.endswith('.wav'):
                # Try to extract the numeric part (e.g., "1.wav" -> 1)
                base_name = filename[:-4]  # Remove .wav extension
                try:
                    num = int(base_name)
                    wav_numbers.append(num)
                except ValueError:
                    # Skip files that don't have pure numeric names
                    pass
        
        # Return next number (max + 1), or 1 if no files exist
        return max(wav_numbers) + 1 if wav_numbers else 1
    except Exception as e:
        _explorer_log("_get_next_audio_number", f"error listing folder {folder_path}: {e}")
        # Default to 1 if error occurs
        return 1


@app.post("/api/recorder_upload")
def api_recorder_upload():
    try:
        cfg = _get_config()

        if 'wav' not in request.files:
            return jsonify({"error": "Missing WAV file"}), 400
        wav_file = request.files['wav']
        if wav_file.filename == '':
            return jsonify({"error": "Missing WAV filename"}), 400

        folder = (request.form.get('folder') or '').strip()
        word = (request.form.get('word') or '').strip()
        index = request.form.get('index')
        audio_source = (request.form.get('audio_source') or 'frontend').strip()

        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not _is_valid_recorder_folder(folder):
            return jsonify({"error": "Invalid recorder folder name. Expected YYYYMMDD_frontend or YYYYMMDD_username_frontend"}), 400
        try:
            index = int(index)
        except Exception:
            return jsonify({"error": "Missing/invalid field: index"}), 400

        if audio_source not in ("frontend", "whatsapp", "dgx"):
            audio_source = "frontend"

        wav_bytes = wav_file.read()
        if not wav_bytes:
            return jsonify({"error": "Empty WAV file"}), 400

        # Store uploaded audio directly without calling the model server.
        transcript = ""
        whisper_conf = 0.0
        folder_path = _join_path(cfg.root, folder)
        data_path = _find_folder_data_json(cfg.storage, cfg.root, folder) or _join_path(folder_path, "data.json")
        entry_audio_filename = _is_safe_relpath(wav_file.filename) and wav_file.filename or f"{index}.wav"
        audio_path = _join_path(folder_path, entry_audio_filename)

        with _lock:
            cfg.storage.write_bytes(audio_path, wav_bytes, content_type="audio/wav")

            original_data = []
            if cfg.storage.exists(data_path):
                original_data = _read_json(cfg.storage, data_path)
                try:
                    entries, mode = _extract_entries(original_data)
                except ValueError as exc:
                    return jsonify({"error": str(exc)}), 400
            else:
                entries = []
                mode = "list"

            entry = {
                "entry_id": str(uuid.uuid4()),
                "entry_timestamp": _now_iso_z(),
                "audio_data": entry_audio_filename,
                "audio_source": audio_source,
                "audio_duration": _get_audio_duration_seconds(wav_bytes),
                "inference_transcript": "",
                "inference_confidence": 0.0,
                "user_is_validated": None,
                "reviewer_is_reviewed": False,
                "reviewer_transcript_corrected": word,
            }
            entry = _normalize_entry(entry)
            entries.append(entry)
            _persist_data_json(cfg.storage, data_path, original_data, entries, mode)
            _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)

        return jsonify({"ok": True, "folder": folder, "entry": entry})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/config")
def api_config():
    try:
        cfg = _get_config()
        return jsonify({
            "ok": True,
            "source": cfg.source,
            "root": cfg.root,
            "bucket": cfg.bucket
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.get("/api/next_audio_number")
def api_next_audio_number():
    """Get the next sequential audio number for a recorder folder.
    
    Query parameters:
        folder: The folder name (e.g., "20260607_chiara_frontend")
    
    Returns:
        {"next_number": <int>}
    """
    try:
        cfg = _get_config()
        folder = (request.args.get('folder') or '').strip()
        
        if not folder:
            return jsonify({"error": "Missing query parameter: folder"}), 400
        if not _is_valid_recorder_folder(folder):
            return jsonify({"error": "Invalid recorder folder name. Expected YYYYMMDD_username_frontend"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        next_num = _get_next_audio_number(cfg.storage, folder_path)
        
        return jsonify({
            "ok": True,
            "folder": folder,
            "next_number": next_num,
            "filename": f"{next_num}.wav"
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.get("/api/folders")
def api_folders():
    try:
        cfg = _get_config()
        with _lock:
            folder_names, root_files = _sync_folders_json_manifest(
                cfg.storage, cfg.root
            )

        folders_index = _folders_index_by_name(
            _read_folders_records(cfg.storage, cfg.root)
        )
        processed = sorted(_read_processed(cfg.storage, cfg.root))

        folders = [
            _folder_to_api_dict(
                cfg.storage, cfg.root, name, folders_index.get(name), folders_index
            )
            for name in folder_names
        ]

        root_json_files = [name for name in root_files if name.endswith(".json")]

        return jsonify({
            "source": cfg.source,
            "root": cfg.root,
            "folders": folders,
            "processed": processed,
            "root_json_files": root_json_files,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/curate_stats")
def api_curate_stats():
    try:
        cfg = _get_config()
        records = _read_folders_records(cfg.storage, cfg.root)
        total_folders = len(records)
        stats_computed_folders = sum(
            1 for record in records if _folder_stats_are_computed(record)
        )
        reviewed_stats_folders = sum(
            1
            for record in records
            if _folder_stats_are_computed(record) and "n_audios_reviewed" in record
        )
        reviewed_duration_stats_folders = sum(
            1 for record in records if "reviewed_audios_duration" in record
        )
        return jsonify({
            "processed_folders": sum(
                1 for record in records if _folder_is_processed(record)
            ),
            "total_folders": total_folders,
            "reviewed_audios": sum(
                max(0, int(_coerce_float(record.get("n_audios_reviewed", 0))))
                for record in records
            ),
            "total_audios": sum(
                max(0, int(_coerce_float(record.get("n_audios", 0))))
                for record in records
            ),
            "reviewed_audios_duration": round(sum(
                max(0.0, _coerce_float(record.get("reviewed_audios_duration", 0)))
                for record in records
            ), 3),
            "total_audios_duration": round(sum(
                max(0.0, _coerce_float(record.get("audios_duration", 0)))
                for record in records
            ), 3),
            "stats_computed_folders": stats_computed_folders,
            "reviewed_stats_folders": reviewed_stats_folders,
            "reviewed_duration_stats_folders": reviewed_duration_stats_folders,
            "last_synced_at": _read_folders_last_synced_at(cfg.storage, cfg.root),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/curate_stats/sync")
def api_sync_curate_stats():
    try:
        cfg = _get_config()
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    def progress_stream():
        try:
            yield json.dumps({"event": "status", "stage": "listing_folders"}) + "\n"
            folder_names = _list_dataset_folder_names(cfg.storage, cfg.root)
            with _lock:
                existing_records = _read_folders_records(cfg.storage, cfg.root)
                folders_index = _folders_index_by_name(existing_records)
                legacy_processed = set(_read_legacy_processed(cfg.storage, cfg.root))

            total_folders = len(folder_names)
            processed_folders = sum(
                1
                for name in folder_names
                if _folder_is_processed(folders_index.get(name, {}))
                or name in legacy_processed
            )
            yield json.dumps({
                "event": "start",
                "processed_folders": processed_folders,
                "total_folders": total_folders,
            }) + "\n"

            total_audios = 0
            reviewed_audios = 0
            total_audios_duration = 0.0
            reviewed_audios_duration = 0.0
            synced_records: list[dict[str, Any]] = []
            for completed, folder in enumerate(folder_names, start=1):
                _explorer_log(
                    "api_sync_curate_stats",
                    f"scanning folder {completed}/{total_folders}: {folder}",
                )
                yield json.dumps({
                    "event": "folder_start",
                    "completed": completed,
                    "total_folders": total_folders,
                    "folder": folder,
                }, ensure_ascii=False) + "\n"

                n_audios, duration, pct_validated, n_audios_reviewed, reviewed_duration = _compute_folder_stats(
                    cfg.storage, cfg.root, folder
                )
                existing = folders_index.get(folder)
                if existing is None:
                    record = _build_folder_record(
                        folder,
                        n_audios,
                        duration,
                        folder in legacy_processed,
                        pct_validated=pct_validated,
                        n_audios_reviewed=n_audios_reviewed,
                        reviewed_audios_duration=reviewed_duration,
                        stats_computed=True,
                    )
                else:
                    record = dict(existing)
                    _apply_folder_stats(
                        record, n_audios, duration, pct_validated, n_audios_reviewed,
                        reviewed_duration,
                    )
                synced_records.append(record)
                total_audios += n_audios
                reviewed_audios += n_audios_reviewed
                total_audios_duration += duration
                reviewed_audios_duration += reviewed_duration
                yield json.dumps({
                    "event": "folder_done",
                    "completed": completed,
                    "total_folders": total_folders,
                    "folder": folder,
                    "total_audios": total_audios,
                    "reviewed_audios": reviewed_audios,
                }, ensure_ascii=False) + "\n"

            last_synced_at = _now_iso_z()
            with _lock:
                _write_folders_records(
                    cfg.storage,
                    cfg.root,
                    synced_records,
                    last_synced_at=last_synced_at,
                )
            yield json.dumps({
                "event": "complete",
                "processed_folders": processed_folders,
                "total_folders": total_folders,
                "reviewed_audios": reviewed_audios,
                "total_audios": total_audios,
                "reviewed_audios_duration": round(reviewed_audios_duration, 3),
                "total_audios_duration": round(total_audios_duration, 3),
                "stats_computed_folders": total_folders,
                "reviewed_stats_folders": total_folders,
                "reviewed_duration_stats_folders": total_folders,
                "last_synced_at": last_synced_at,
            }) + "\n"
        except Exception as exc:
            _explorer_log("api_sync_curate_stats", f"sync failed: {exc}")
            yield json.dumps({"event": "error", "error": str(exc)}) + "\n"

    return Response(progress_stream(), mimetype="application/x-ndjson")


@app.get("/api/inputs")
def api_inputs_list():
    """Return all input sets stored in inputs.json."""
    try:
        cfg = _get_config()
        storage_path = _join_path(cfg.root, "inputs.json")
        if not cfg.storage.exists(storage_path):
            return jsonify([])

        data = _read_json(cfg.storage, storage_path)
        if not isinstance(data, list):
            return jsonify([])
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.delete("/api/inputs/<inputs_id>")
def api_inputs_delete(inputs_id: str):
    """Delete an input set from inputs.json."""
    try:
        cfg = _get_config()
        storage_path = _join_path(cfg.root, "inputs.json")
        if not cfg.storage.exists(storage_path):
            return jsonify({"error": "inputs.json not found"}), 404

        data = _read_json(cfg.storage, storage_path)
        if not isinstance(data, list):
            return jsonify({"error": "Invalid inputs.json format"}), 400

        new_data = [item for item in data if item.get("inputs_id") != inputs_id]
        if len(new_data) == len(data):
            return jsonify({"error": "Input set not found"}), 404

        with _lock:
            cfg.storage.write_bytes(
                storage_path,
                json.dumps(new_data, indent=2, ensure_ascii=False).encode("utf-8")
            )

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.patch("/api/inputs/<inputs_id>")
def api_inputs_patch(inputs_id: str):
    """Update inputs_emoji and/or inputs_id for an input set in inputs.json."""
    try:
        cfg = _get_config()
        storage_path = _join_path(cfg.root, "inputs.json")
        if not cfg.storage.exists(storage_path):
            return jsonify({"error": "inputs.json not found"}), 404

        data = _read_json(cfg.storage, storage_path)
        if not isinstance(data, list):
            return jsonify({"error": "Invalid inputs.json format"}), 400

        body = request.get_json(silent=True) or {}
        new_emoji = body.get("inputs_emoji")
        new_id = body.get("inputs_id")

        if new_emoji is None and new_id is None:
            return jsonify({"error": "Nothing to update: provide inputs_emoji and/or inputs_id"}), 400

        target = next((item for item in data if item.get("inputs_id") == inputs_id), None)
        if target is None:
            return jsonify({"error": "Input set not found"}), 404

        # Validate new_id uniqueness if changing it
        if new_id is not None and new_id != inputs_id:
            if any(item.get("inputs_id") == new_id for item in data):
                return jsonify({"error": "inputs_id already in use"}), 409
            target["inputs_id"] = str(new_id)

        if new_emoji is not None:
            target["inputs_emoji"] = str(new_emoji)

        with _lock:
            cfg.storage.write_bytes(
                storage_path,
                json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
            )

        return jsonify({"ok": True, "inputs_set": target})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/folders/rebuild_stats")
def api_folders_rebuild_stats():
    """Recompute audio stats for all folders (slow; run manually when needed)."""
    try:
        cfg = _get_config()
        with _lock:
            _refresh_folders_json(cfg.storage, cfg.root)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.post("/api/folders/refresh_missing_stats")
def api_folders_refresh_missing_stats():
    """Compute folder stats that are not already cached."""
    try:
        cfg = _get_config()
        with _lock:
            refreshed, total = _refresh_missing_folders_json(cfg.storage, cfg.root)
        return jsonify({"ok": True, "refreshed": refreshed, "total": total})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.get("/api/folder_stats")
def api_folder_stats():
    try:
        cfg = _get_config()
        folder = (request.args.get("folder") or "").strip()
        force_refresh = request.args.get("refresh", "").lower() in ("1", "true", "yes")
        if not folder:
            return jsonify({"error": "Missing query param: folder"}), 400
        
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        if not cfg.storage.is_dir(folder_path):
            return jsonify({"error": f"Folder not found: {folder}"}), 404
        
        record = _get_folder_record(cfg.storage, cfg.root, folder)
        if record is None or not _folder_stats_are_computed(record) or force_refresh:
            with _lock:
                _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)
            record = _get_folder_record(cfg.storage, cfg.root, folder)
        if record is None:
            n_audios, audios_duration, pct_validated, n_audios_reviewed, reviewed_audios_duration = _compute_folder_stats(
                cfg.storage, cfg.root, folder
            )
            is_processed = _folder_processed_status(cfg.storage, cfg.root, folder)
            record = _build_folder_record(
                folder,
                n_audios,
                audios_duration,
                is_processed,
                pct_validated=pct_validated,
                n_audios_reviewed=n_audios_reviewed,
                reviewed_audios_duration=reviewed_audios_duration,
            )

        total_audios = int(record.get("n_audios", 0))
        pct_validated = float(record.get("%_validated", 0))
        validated_audios = (
            round(total_audios * pct_validated / 100.0) if total_audios else 0
        )
        entries = _load_folder_entries(cfg.storage, cfg.root, folder)
        inference_model_versions = _unique_inference_model_versions_from_entries(entries)
        inference_vocabulary = collect_unique_inference_words(entries)
        _explorer_log("api_folder", f"responding folder={folder!r} total_audios={len(entries)}")
        return jsonify({
            "folder": folder,
            "processed": _folder_is_processed(record),
            "total_audios": total_audios,
            "validated_audios": validated_audios,
            "pct_validated": pct_validated,
            "total_duration_str": _format_duration(float(record.get("audios_duration", 0))),
            "inference_model_versions": inference_model_versions,
            "inference_vocabulary": inference_vocabulary,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/aggregate_stats")
def api_aggregate_stats():
    try:
        cfg = _get_config()
        include_models = request.args.get("model_versions", "").lower() in (
            "1",
            "true",
            "yes",
        )
        stats = _compute_aggregate_stats(
            cfg.storage,
            cfg.root,
            include_model_versions=include_models,
        )
        return jsonify(stats)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/aggregate_model_versions")
def api_aggregate_model_versions():
    try:
        cfg = _get_config()
        versions = _collect_aggregate_model_versions(cfg.storage, cfg.root)
        return jsonify({
            "folder": "*",
            "aggregate": True,
            "inference_model_versions": versions,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/inference_vocabulary")
def api_inference_vocabulary():
    try:
        cfg = _get_config()
        folder = (request.args.get("folder") or "").strip()
        if not folder:
            return jsonify({"error": "Missing query param: folder"}), 400

        if _is_aggregate_folder(folder):
            folder_records = _read_folders_records(cfg.storage, cfg.root)
            events = _read_timeline_events(cfg.storage, cfg.root)
            timeline_folder_names = _folder_names_from_timeline_events(
                events,
                folder_records=folder_records,
            )
            entries = _load_folder_entries_for_names(
                cfg.storage,
                cfg.root,
                timeline_folder_names,
            )
            words = collect_unique_inference_words(entries)
            return jsonify({
                "folder": "*",
                "aggregate": True,
                "words": words,
                "word_count": len(words),
            })

        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400

        folder_path = _join_path(cfg.root, folder)
        if not cfg.storage.is_dir(folder_path):
            return jsonify({"error": f"Folder not found: {folder}"}), 404

        entries = _load_folder_entries(cfg.storage, cfg.root, folder)
        words = collect_unique_inference_words(entries)
        return jsonify({
            "folder": folder,
            "words": words,
            "word_count": len(words),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/decoding_performance")
def api_decoding_performance():
    try:
        cfg = _get_config()
        folder = (request.args.get("folder") or "").strip()
        model_version = (request.args.get("model_version") or "").strip()
        if not folder:
            return jsonify({"error": "Missing query param: folder"}), 400
        if not model_version:
            return jsonify({"error": "Missing query param: model_version"}), 400

        if _is_aggregate_folder(folder):
            folder_records = _read_folders_records(cfg.storage, cfg.root)
            events = _read_timeline_events(cfg.storage, cfg.root)
            timeline_folder_names = _folder_names_from_timeline_events(
                events,
                folder_records=folder_records,
            )
            entries = _load_folder_entries_for_names(
                cfg.storage,
                cfg.root,
                timeline_folder_names,
            )
            audio_base_path = cfg.root if cfg.source == "local" else None
            result = analyze_entries_for_model(
                entries,
                model_version,
                audio_base_path=audio_base_path,
            )
            result["folder"] = "*"
            result["aggregate"] = True
            return jsonify(result)

        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400

        folder_path = _join_path(cfg.root, folder)
        if not cfg.storage.is_dir(folder_path):
            return jsonify({"error": f"Folder not found: {folder}"}), 404

        entries = _load_folder_entries(cfg.storage, cfg.root, folder)
        audio_base_path = folder_path if cfg.source == "local" else None
        result = analyze_entries_for_model(
            entries,
            model_version,
            audio_base_path=audio_base_path,
        )
        result["folder"] = folder
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/folder")
def api_folder():
    try:
        cfg = _get_config()
        folder = (request.args.get("folder") or "").strip()
        if not folder:
            return jsonify({"error": "Missing query param: folder"}), 400
        
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400

        _explorer_log("api_folder", f"start folder={folder!r} source={cfg.source}")

        folder_path = _join_path(cfg.root, folder)
        _explorer_log("api_folder", f"checking folder path exists: {folder_path!r}")
        if not cfg.storage.is_dir(folder_path):
            _explorer_log("api_folder", f"folder not found: {folder_path!r}")
            return jsonify({"error": f"Folder not found: {folder}"}), 404

        # Ensure folder has an entry in folders.json and refresh its stats on open.
        # Spawn a background thread to refresh stats so this API returns quickly
        # (avoids blocking the UI when folders are large).
        threading.Thread(
            target=_update_folder_stats_in_folders_json,
            args=(cfg.storage, cfg.root, folder),
            daemon=True,
        ).start()
        _explorer_log("api_folder", f"spawned background stats-updater for {folder!r}")
        record = _get_folder_record(cfg.storage, cfg.root, folder)
        _explorer_log("api_folder", f"folder record fetched: {bool(record)}")

        data_path = _find_folder_data_json(cfg.storage, cfg.root, folder)
        _explorer_log("api_folder", f"data JSON path: {data_path!r}")
        entries: list[Any] = []
        if data_path is not None:
            try:
                _explorer_log("api_folder", f"data JSON exists, about to read {data_path!r}")
                entries = _load_folder_entries(cfg.storage, cfg.root, folder)
                _explorer_log("api_folder", f"read entries count={len(entries)} for folder={folder!r}")
            except ValueError as e:
                _explorer_log("api_folder", f"failed reading data JSON: {e}")
                return jsonify({"error": str(e)}), 400
        
        _explorer_log("api_folder", f"listing json files in {folder_path!r}")
        json_files = [
            name
            for name in cfg.storage.list_dir(folder_path)
            if name.endswith(".json") and cfg.storage.is_file(_join_path(folder_path, name))
        ]
        _explorer_log("api_folder", f"found json_files count={len(json_files)}")
        
        total_duration = 0.0
        for e in entries:
            if isinstance(e, dict):
                total_duration += _entry_duration_seconds(e)

        record = _get_folder_record(cfg.storage, cfg.root, folder)
        processed = (
            _folder_is_processed(record)
            if record is not None
            else _folder_processed_status(cfg.storage, cfg.root, folder)
        )
        return jsonify({
            "folder": folder,
            "processed": processed,
            "json_files": json_files,
            "data": entries,
            "stats": {
                "total_audios": len(entries),
                "total_duration_seconds": total_duration,
                "total_duration_str": _format_duration(total_duration),
            },
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/file_content")
def api_json_file():
    try:
        cfg = _get_config()
        folder = (request.args.get("folder") or "").strip()
        filename = (request.args.get("file") or "").strip()
        
        if not folder or not filename:
            return jsonify({"error": "Missing query params: folder, file"}), 400
        if not filename.lower().endswith(".json"):
            return jsonify({"error": "Only .json files supported"}), 400
        if "/" in filename or "\\" in filename or filename.startswith("."):
            return jsonify({"error": "Invalid file name"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        file_path = _join_path(folder_path, filename)
        
        if not cfg.storage.exists(file_path) or not cfg.storage.is_file(file_path):
            return jsonify({"error": f"File not found: {filename}"}), 404
        
        max_bytes = 5 * 1024 * 1024
        # Pass max_bytes + 1 to detect if the file was truncated
        raw = cfg.storage.read_bytes(file_path, max_bytes=max_bytes + 1)
        truncated = False
        if len(raw) > max_bytes:
            raw = raw[:max_bytes]
            truncated = True
        
        content = raw.decode("utf-8", errors="replace")
        if truncated:
            content += "\n\n… [truncated — showing first 5 MB]"
        
        return jsonify({"folder": folder, "file": filename, "content": content})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/file_content_root")
def api_json_root_file():
    try:
        cfg = _get_config()
        filename = (request.args.get("file") or "").strip()
        
        if not filename:
            return jsonify({"error": "Missing query param: file"}), 400
        if not filename.lower().endswith(".json"):
            return jsonify({"error": "Only .json files supported"}), 400
        if "/" in filename or "\\" in filename or filename.startswith("."):
            return jsonify({"error": "Invalid file name"}), 400
        
        file_path = _join_path(cfg.root, filename)
        
        if not cfg.storage.exists(file_path) or not cfg.storage.is_file(file_path):
            return jsonify({"error": f"File not found: {filename}"}), 404
        
        max_bytes = 5 * 1024 * 1024
        raw = cfg.storage.read_bytes(file_path, max_bytes=max_bytes + 1)
        truncated = False
        if len(raw) > max_bytes:
            raw = raw[:max_bytes]
            truncated = True
        
        content = raw.decode("utf-8", errors="replace")
        if truncated:
            content += "\n\n… [truncated — showing first 5 MB]"
        
        return jsonify({"file": filename, "content": content})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/save_json")
def api_save_json():
    try:
        cfg = _get_config()
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "Invalid JSON body"}), 400

        filename = (body.get("file") or "").strip()
        content = body.get("content")
        folder = (body.get("folder") or "").strip()

        if not filename:
            return jsonify({"error": "Missing file name"}), 400
        if not filename.lower().endswith(".json"):
            return jsonify({"error": "Only .json files supported"}), 400
        if "/" in filename or "\\" in filename or filename.startswith("."):
            return jsonify({"error": "Invalid file name"}), 400
        if not isinstance(content, str):
            return jsonify({"error": "Missing or invalid content"}), 400
        if folder and not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400

        try:
            json.loads(content)
        except json.JSONDecodeError as ex:
            return jsonify({"error": f"Invalid JSON content: {ex.msg} at line {ex.lineno} column {ex.colno}"}), 400

        if not folder:
            target_path = _join_path(cfg.root, filename)
        else:
            target_path = _join_path(_join_path(cfg.root, folder), filename)
        if not cfg.storage.exists(target_path) or not cfg.storage.is_file(target_path):
            return jsonify({"error": f"File not found: {filename}"}), 404

        cfg.storage.write_bytes(target_path, content.encode("utf-8"))
        return jsonify({"ok": True, "file": filename, "folder": folder})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/media")
def api_media():
    try:
        cfg = _get_config()
        folder = (request.args.get("folder") or "").strip()
        rel = (request.args.get("rel") or "").strip()
        
        if not folder or not rel:
            return jsonify({"error": "Missing query params: folder, rel"}), 400
        
        ext = os.path.splitext(rel)[1].lower().lstrip(".")
        allowed = {"wav", "mp3", "ogg", "flac", "m4a"}
        if ext not in allowed:
            return jsonify({"error": "Unsupported media type"}), 400
        
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        
        # Handle both relative and absolute paths for the file
        file_path = None
        candidates = []

        if rel.startswith("/"):
            # Absolute local path - validate it's within root
            rel_resolved = Path(rel).resolve()
            root_resolved = Path(cfg.root).resolve() if cfg.source == "local" else Path(cfg.root)
            if cfg.source == "local":
                if root_resolved in rel_resolved.parents or rel_resolved == root_resolved:
                    candidates.append(rel)
            else:
                # For Firebase, allow absolute paths as-is (they're storage paths)
                candidates.append(rel)
        elif rel.startswith("gs://"):
            if cfg.source == "firebase":
                parts = rel[5:].split("/", 1)
                if len(parts) > 1:
                    candidates.append(parts[1])
        else:
            # Relative path - join with folder
            if _is_safe_relpath(rel):
                candidates.append(_join_path(folder_path, rel))
        
        # Always try with basename in folder as a fallback (good for old absolute paths)
        basename = os.path.basename(rel)
        if _is_safe_relpath(basename):
            candidates.append(_join_path(folder_path, basename))
            
        # Try in root (for local)
        if cfg.source == "local" and _is_safe_relpath(rel):
            candidates.append(_join_path(cfg.root, rel))

        for candidate in candidates:
            if cfg.storage.exists(candidate) and cfg.storage.is_file(candidate):
                file_path = candidate
                break

        if not file_path:
            return jsonify({"error": f"Audio not found: {rel}", "tried": candidates}), 404
        
        mime, _ = mimetypes.guess_type(rel)
        if not mime:
            mime = {
                "wav": "audio/wav",
                "mp3": "audio/mpeg",
                "ogg": "audio/ogg",
                "flac": "audio/flac",
                "m4a": "audio/mp4",
            }.get(ext, "application/octet-stream")
        
        data = cfg.storage.read_bytes(file_path)
        headers = {
            "Content-Disposition": f'inline; filename="{os.path.basename(rel)}"',
            "Accept-Ranges": "bytes",
        }
        return Response(data, mimetype=mime, headers=headers)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/trim_audio")
def api_trim_audio():
    """Trim an entry's WAV audio in place and update audio_duration."""
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}

        folder = (payload.get("folder") or "").strip()
        index = payload.get("index")
        start_sec = payload.get("start_sec")
        end_sec = payload.get("end_sec")

        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not isinstance(index, int):
            return jsonify({"error": "Missing/invalid field: index (int)"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400

        try:
            start_sec = float(start_sec)
            end_sec = float(end_sec)
        except (TypeError, ValueError):
            return jsonify({"error": "Missing/invalid fields: start_sec, end_sec"}), 400

        folder_path = _join_path(cfg.root, folder)
        data_path = _find_folder_data_json(cfg.storage, cfg.root, folder)
        if data_path is None:
            return jsonify({"error": "Folder has no data JSON"}), 404

        with _lock:
            data = _read_json(cfg.storage, data_path)
            try:
                entries, mode = _extract_entries(data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400

            if index < 0 or index >= len(entries):
                return jsonify({"error": "Entry index out of range"}), 400

            entry = entries[index]
            if not isinstance(entry, dict):
                return jsonify({"error": "Entry is not an object"}), 400

            audio_rel = _entry_audio_rel(entry)
            if not audio_rel:
                return jsonify({"error": "No audio file reference found in entry"}), 400

            audio_path = _resolve_entry_audio_path(
                cfg.storage, cfg, folder_path, audio_rel
            )
            if audio_path is None:
                return jsonify({"error": f"Audio not found: {audio_rel}"}), 404

            ext = os.path.splitext(audio_path)[1].lower()
            if ext != ".wav":
                return jsonify({"error": "Only WAV audio can be trimmed"}), 400

            original = cfg.storage.read_bytes(audio_path)
            try:
                trimmed, duration = _trim_wav_bytes(original, start_sec, end_sec)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            except wave.Error as e:
                return jsonify({"error": f"Invalid WAV file: {e}"}), 400

            cfg.storage.write_bytes(audio_path, trimmed, content_type="audio/wav")
            entry["audio_duration"] = round(duration, 3)
            entries[index] = entry
            _persist_data_json(cfg.storage, data_path, data, entries, mode)
            if "reviewer_is_reviewed" in filtered:
                _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)
            _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)

        return jsonify({
            "ok": True,
            "audio_duration": round(duration, 3),
            "entry": entry,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/entry")
def api_update_entry():
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        
        folder = (payload.get("folder") or "").strip()
        index = payload.get("index")
        updates = payload.get("updates") or {}
        
        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not isinstance(index, int):
            return jsonify({"error": "Missing/invalid field: index (int)"}), 400
        if not isinstance(updates, dict) or not updates:
            return jsonify({"error": "Missing/invalid field: updates (object)"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        allowed_fields = {
            "reviewer_transcript_corrected",
            "reviewer_corrected_transcript",
            "is_reviewed",
            "reviewer_is_reviewed",
        }
        filtered = {k: v for k, v in updates.items() if k in allowed_fields}
        if not filtered:
            return jsonify({"error": "No supported fields in updates"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        data_path = _find_folder_data_json(cfg.storage, cfg.root, folder)
        if data_path is None:
            return jsonify({"error": "Folder has no data JSON"}), 404
        
        with _lock:
            data = _read_json(cfg.storage, data_path)
            try:
                entries, mode = _extract_entries(data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            if index < 0 or index >= len(entries):
                return jsonify({"error": "Entry index out of range"}), 400
            
            entry = entries[index]
            if not isinstance(entry, dict):
                return jsonify({"error": "Entry is not an object"}), 400
            
            if "reviewer_transcript_corrected" in filtered:
                entry["reviewer_transcript_corrected"] = str(
                    filtered["reviewer_transcript_corrected"]
                )
            elif "reviewer_corrected_transcript" in filtered:
                entry["reviewer_transcript_corrected"] = str(
                    filtered["reviewer_corrected_transcript"]
                )
            if "is_reviewed" in filtered:
                entry["is_reviewed"] = _coerce_bool(filtered["is_reviewed"])
            if "reviewer_is_reviewed" in filtered:
                entry["reviewer_is_reviewed"] = _coerce_bool(filtered["reviewer_is_reviewed"])
            
            entries[index] = entry
            _persist_data_json(cfg.storage, data_path, data, entries, mode)
        
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/generate")
def api_generate():
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        
        folder = (payload.get("folder") or "").strip()
        index = payload.get("index")
        
        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not isinstance(index, int):
            return jsonify({"error": "Missing/invalid field: index (int)"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        data_path = _find_folder_data_json(cfg.storage, cfg.root, folder)
        if data_path is None:
            return jsonify({"error": "Folder has no data JSON"}), 404
        
        with _lock:
            data = _read_json(cfg.storage, data_path)
            try:
                entries, mode = _extract_entries(data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            if index < 0 or index >= len(entries):
                return jsonify({"error": "Entry index out of range"}), 400
            
            entry = entries[index]
            if not isinstance(entry, dict):
                return jsonify({"error": "Entry is not an object"}), 400
            
            # Locate audio file path from common keys
            candidate_keys = [
                "audio_data",
                "audio_file",
                "audio",
                "audio_filepath",
                "audio_path",
                "path",
                "file",
                "filename",
                "media",
            ]
            audio_rel = None
            for k in candidate_keys:
                v = entry.get(k)
                if isinstance(v, str) and v.strip():
                    audio_rel = v.strip()
                    break
            
            if not audio_rel:
                return jsonify({"error": "No audio file reference found in entry"}), 400
            
            # Try to find audio file
            audio_file_path = None
            candidates = []
            
            # Try as relative path within folder
            if _is_safe_relpath(audio_rel):
                candidate = _join_path(folder_path, audio_rel)
                candidates.append(candidate)
                if cfg.storage.exists(candidate):
                    audio_file_path = candidate
            
            # Try with basename in folder
            if not audio_file_path:
                basename = os.path.basename(audio_rel)
                if _is_safe_relpath(basename):
                    candidate = _join_path(folder_path, basename)
                    candidates.append(candidate)
                    if cfg.storage.exists(candidate):
                        audio_file_path = candidate
            
            # Try in root (for local)
            if not audio_file_path and cfg.source == "local":
                if _is_safe_relpath(audio_rel):
                    candidate = _join_path(cfg.root, audio_rel)
                    candidates.append(candidate)
                    if cfg.storage.exists(candidate):
                        audio_file_path = candidate
            
            if audio_file_path is None:
                return jsonify({"error": "Audio file not found", "tried": candidates}), 404
            
            # Build model-server URL from environment
            host = os.environ.get("MODEL_SERVER_HOST", "127.0.0.1")
            port = os.environ.get("MODEL_SERVER_PORT", "9000")
            url = f"http://{host}:{port}/transcribe?upload_to_firebase_server=false&process_with_llm=false&return_alternatives=false&json_response=true"
            
            try:
                audio_data = cfg.storage.read_bytes(audio_file_path)
                files = {"wav": (os.path.basename(audio_rel), io.BytesIO(audio_data), "audio/wav")}
                session = _create_model_server_session()
                resp = session.post(url, files=files, timeout=120)
                if resp.status_code != 200:
                    return jsonify({
                        "error": "Model server returned error",
                        "status_code": resp.status_code,
                        "text": resp.text
                    }), 502
                result = resp.json()
            except Exception as e:
                return jsonify({"error": str(e)}), 500
            
            # Return the generated transcript separately. It is temporary until the
            # user explicitly accepts it through the regular entry update endpoint.
            generated_entry = dict(entry)
            generated_entry["generated_transcript"] = result.get("transcript") or ""
        
        return jsonify({"ok": True, "entry": generated_entry})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/processed")
def api_mark_processed():
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        folder = (payload.get("folder") or "").strip()
        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        if not cfg.storage.is_dir(folder_path):
            return jsonify({"error": f"Folder not found: {folder}"}), 404
        
        with _lock:
            _update_folder_processed_in_folders_json(cfg.storage, cfg.root, folder, True)
        
        return jsonify({"ok": True, "folder": folder})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/processed_toggle")
def api_toggle_processed():
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        folder = (payload.get("folder") or "").strip()
        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        with _lock:
            record = _get_folder_record(cfg.storage, cfg.root, folder)
            processed_now = not _folder_is_processed(record) if record else True
            _update_folder_processed_in_folders_json(
                cfg.storage, cfg.root, folder, processed_now
            )
        
        return jsonify({"ok": True, "folder": folder, "processed": processed_now})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/reviewed_all")
def api_set_reviewed_all():
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        folder = (payload.get("folder") or "").strip()
        reviewed = payload.get("reviewed")

        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not isinstance(reviewed, bool):
            return jsonify({"error": "Missing/invalid field: reviewed (boolean)"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400

        folder_path = _join_path(cfg.root, folder)
        data_path = _find_folder_data_json(cfg.storage, cfg.root, folder)
        if data_path is None:
            return jsonify({"error": "Folder has no data JSON"}), 404

        with _lock:
            data = _read_json(cfg.storage, data_path)
            try:
                entries, mode = _extract_entries(data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400

            for entry in entries:
                if isinstance(entry, dict):
                    entry["reviewer_is_reviewed"] = _coerce_bool(reviewed)

            _persist_data_json(cfg.storage, data_path, data, entries, mode)
            _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)

        return jsonify({"ok": True, "reviewed": reviewed, "count": len(entries)})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/delete_entry")
def api_delete_entry():
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        
        folder = (payload.get("folder") or "").strip()
        index = payload.get("index")
        
        if not folder:
            return jsonify({"error": "Missing field: folder"}), 400
        if not isinstance(index, int):
            return jsonify({"error": "Missing/invalid field: index (int)"}), 400
        if not _is_safe_relpath(folder):
            return jsonify({"error": "Invalid folder name"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        data_path = _find_folder_data_json(cfg.storage, cfg.root, folder)
        if data_path is None:
            return jsonify({"error": "Folder has no data JSON"}), 404
        
        with _lock:
            data = _read_json(cfg.storage, data_path)
            try:
                entries, mode = _extract_entries(data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            if index < 0 or index >= len(entries):
                return jsonify({"error": "Entry index out of range"}), 400
            
            entry = entries[index]
            if not isinstance(entry, dict):
                return jsonify({"error": "Entry is not an object"}), 400
            
            # Locate audio file path from common keys
            candidate_keys = [
                "audio_data",
                "audio_file",
                "audio",
                "audio_filepath",
                "audio_path",
                "path",
                "file",
                "filename",
                "media",
            ]
            audio_rel = None
            for k in candidate_keys:
                v = entry.get(k)
                if isinstance(v, str) and v.strip():
                    audio_rel = v.strip()
                    break
            
            # Delete audio file if found
            if audio_rel:
                candidates = []
                
                # Try as relative path within folder
                if _is_safe_relpath(audio_rel):
                    candidate = _join_path(folder_path, audio_rel)
                    candidates.append(candidate)
                
                # Try with basename in folder
                basename = os.path.basename(audio_rel)
                if _is_safe_relpath(basename):
                    candidate = _join_path(folder_path, basename)
                    candidates.append(candidate)
                
                # Try in root (for local)
                if cfg.source == "local" and _is_safe_relpath(audio_rel):
                    candidate = _join_path(cfg.root, audio_rel)
                    candidates.append(candidate)
                
                for candidate in candidates:
                    if cfg.storage.exists(candidate):
                        try:
                            cfg.storage.delete(candidate)
                        except Exception:
                            pass
                        break
            
            # Remove entry from data.json
            entries.pop(index)
            
            # Persist changes
            _persist_data_json(cfg.storage, data_path, data, entries, mode)
            _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)
        
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/inputs")
def api_inputs_create():
    """
    Create and store a new inputs set as inputs.json.
    Expects JSON: { "name": "...", "words": [...] }
    Creates JSON according to schema-inputs_v1.0.0.json and stores to storage.
    """
    try:
        cfg = _get_config()
        payload = request.get_json() or {}
        
        name = (payload.get("name") or "").strip()
        words = payload.get("words")
        
        if not name:
            return jsonify({"error": "Missing field: name"}), 400
        if not isinstance(words, list) or len(words) == 0:
            return jsonify({"error": "Invalid field: words (must be non-empty list)"}), 400
        
        # Validate that all words are strings
        if not all(isinstance(w, str) for w in words):
            return jsonify({"error": "All words must be strings"}), 400
        
        # Create inputs object according to schema
        emojis = ["📝", "📚", "🗣️", "🎤", "🧠", "💡", "🔥", "✨", "🚀", "🎯"]
        inputs_emoji = emojis[hash(name) % len(emojis)]
        
        inputs_set = {
            "inputs_id": str(uuid.uuid4()),
            "inputs_emoji": inputs_emoji,
            "inputs": [{"input": w.strip()} for w in words if w.strip()]
        }
        
        # Determine storage path for inputs.json
        storage_path = _join_path(cfg.root, "inputs.json")        
        # Read existing inputs (if any) or create new collection
        try:
            if cfg.storage.exists(storage_path):
                existing_data = _read_json(cfg.storage, storage_path)
            else:
                existing_data = []
        except:
            existing_data = []
        
        if not isinstance(existing_data, list):
            existing_data = []
        
        # Add new inputs set to collection
        existing_data.append(inputs_set)
        
        # Write back to storage
        with _lock:
            cfg.storage.write_bytes(
                storage_path,
                json.dumps(existing_data, indent=2, ensure_ascii=False).encode("utf-8")
            )
        
        _explorer_log(
            "api_inputs_create",
            f"Created inputs set '{name}' with {len(words)} words, stored to {storage_path}"
        )
        
        return jsonify({
            "ok": True,
            "inputs_set": inputs_set,
            "storage_path": storage_path
        })
    except Exception as e:
        _explorer_log("api_inputs_create", f"Error: {e}")
        return jsonify({"error": str(e)}), 400


def _load_custom_dictionary(storage: StorageBackend, root: str) -> set[str]:
    """Load custom dictionary from dictionary.json in the bucket root."""
    try:
        dict_path = "dictionary.json" if not root else f"{root}/dictionary.json"
        if not storage.exists(dict_path):
            return set()
        
        data = _read_json(storage, dict_path)
        if isinstance(data, dict) and "words" in data:
            words = data["words"]
            if isinstance(words, list):
                return set(str(w).lower() for w in words if w)
        elif isinstance(data, list):
            return set(str(w).lower() for w in data if w)
        return set()
    except Exception as e:
        _explorer_log("_load_custom_dictionary", f"Error loading custom dictionary: {e}")
        return set()


def _spellcheck_italian_text(text: str, storage: StorageBackend, root: str) -> list[dict[str, Any]]:
    """Spellcheck Italian text and return list of misspellings with suggestions.
    
    Returns:
        List of dicts with keys: word, start_pos, end_pos, suggestions (list of up to 5)
    """
    try:
        # Load Italian dictionary and custom words
        spell = SpellChecker(language='it')
        custom_words = _load_custom_dictionary(storage, root)
        
        misspellings = []
        
        # First, highlight specified punctuation marks
        punctuation_marks = {'?', '!', ',', '.'}
        for i, char in enumerate(text):
            if char in punctuation_marks:
                misspellings.append({
                    "word": char,
                    "start_pos": i,
                    "end_pos": i + 1,
                    "suggestions": []
                })
        
        # Highlight apostrophe patterns: vowel' (e.g., a', e', i', o', u')
        vowel_apostrophe_pattern = re.compile(r"[aeiouAEIOU]'", re.UNICODE)
        for match in vowel_apostrophe_pattern.finditer(text):
            misspellings.append({
                "word": match.group(),
                "start_pos": match.start(),
                "end_pos": match.end(),
                "suggestions": []
            })
        
        # Highlight apostrophe patterns: letter'letter (e.g., l'a, d'è)
        letter_apostrophe_pattern = re.compile(r"[a-zA-Z]'[a-zA-Z]", re.UNICODE)
        for match in letter_apostrophe_pattern.finditer(text):
            misspellings.append({
                "word": "'",
                "start_pos": match.start() + 1,
                "end_pos": match.start() + 2,
                "suggestions": []
            })
        
        # Split text into words while preserving positions
        # We'll search for word boundaries
        word_pattern = re.compile(r'\b[\w\'-]+\b', re.UNICODE)
        
        for match in word_pattern.finditer(text):
            word = match.group()
            start_pos = match.start()
            end_pos = match.end()
            
            # Check if word is misspelled (lowercase for comparison)
            # Word is misspelled if it's not in spell checker AND not in custom words
            word_lower = word.lower()
            if word_lower not in spell and word_lower not in custom_words:
                # Get up to 5 suggestions
                candidates = spell.candidates(word_lower) or []
                suggestions = sorted(list(candidates))[:5]
                
                misspellings.append({
                    "word": word,
                    "start_pos": start_pos,
                    "end_pos": end_pos,
                    "suggestions": suggestions
                })
        
        # Sort misspellings by position for consistent ordering
        misspellings.sort(key=lambda m: m["start_pos"])
        
        return misspellings
    except Exception as e:
        _explorer_log("_spellcheck_italian_text", f"Error during spellcheck: {e}")
        raise


def _save_word_to_custom_dictionary(storage: StorageBackend, root: str, word: str) -> None:
    """Add a word to the custom dictionary."""
    try:
        dict_path = "dictionary.json" if not root else f"{root}/dictionary.json"
        
        # Load existing dictionary
        if storage.exists(dict_path):
            try:
                data = _read_json(storage, dict_path)
            except Exception:
                data = {}
        else:
            data = {}
        
        # Ensure we have a "words" array
        if "words" not in data or not isinstance(data["words"], list):
            data["words"] = []
        
        # Add word if not already present
        word_lower = word.lower()
        if word_lower not in (w.lower() for w in data["words"]):
            data["words"].append(word_lower)
            data["words"] = sorted(list(set(w.lower() for w in data["words"])))
        
        # Save back
        _atomic_write_json(storage, dict_path, data)
    except Exception as e:
        _explorer_log("_save_word_to_custom_dictionary", f"Error saving word to dictionary: {e}")
        raise


@app.post("/api/spellcheck")
def api_spellcheck():
    """Spellcheck Italian text and return misspellings with suggestions.
    
    Request JSON: { "text": "..." }
    Response JSON: { "misspellings": [ { "word": "...", "start_pos": 0, "end_pos": 1, "suggestions": [...] }, ... ] }
    """
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        
        text = (payload.get("text") or "").strip()
        if not text:
            return jsonify({"misspellings": []})
        
        misspellings = _spellcheck_italian_text(text, cfg.storage, cfg.root)
        return jsonify({"misspellings": misspellings})
    except Exception as e:
        _explorer_log("api_spellcheck", f"Error: {e}")
        return jsonify({"error": str(e)}), 400


@app.post("/api/spellcheck_add_word")
def api_spellcheck_add_word():
    """Add a word to the custom dictionary.
    
    Request JSON: { "word": "..." }
    Response JSON: { "ok": true }
    """
    try:
        cfg = _get_config()
        payload = request.get_json(silent=True) or {}
        
        word = (payload.get("word") or "").strip()
        if not word:
            return jsonify({"error": "Missing field: word"}), 400
        
        _save_word_to_custom_dictionary(cfg.storage, cfg.root, word)
        return jsonify({"ok": True})
    except Exception as e:
        _explorer_log("api_spellcheck_add_word", f"Error: {e}")
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    try:
        cfg = _get_config()
        _explorer_log(
            "startup",
            f"source={cfg.source} root={cfg.root!r} bucket={cfg.bucket!r}",
        )

        startup_sync = os.environ.get("EXPLORER_STARTUP_FOLDER_SYNC", "manifest").lower()
        with _lock:
            if startup_sync == "full":
                _refresh_folders_json(cfg.storage, cfg.root)
            elif startup_sync != "off":
                _sync_folders_json_manifest(cfg.storage, cfg.root)

        _explorer_log(
            "startup",
            f"sync={startup_sync!r} path={_folders_json_path(cfg.root)}",
        )

    except Exception as exc:
        _explorer_log("startup", f"folders.json sync failed: {exc}")
    app.run(host="0.0.0.0", port=int(os.environ.get("FRONTEND_PORT", "5020")), debug=True)
