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
import requests

from flask import Flask, Response, jsonify, render_template, request
from datetime import datetime, timezone

try:
    import firebase_admin
    from firebase_admin import credentials, storage
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False


# -----------------------------
# environment variables
# -----------------------------
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
                env_vars[key] = _parse_env_value(value)
    return env_vars


_arg_parser = argparse.ArgumentParser(description="Chiara Speech-to-Text explorer frontend")
_arg_parser.add_argument(
    "--env-file",
    type=str,
    required=True,
    help="Path to the .env file to load environment variables from.",
)
_cli_args, _cli_unknown = _arg_parser.parse_known_args()

for _k, _v in _load_env_file(_cli_args.env_file).items():
    if _k:
        os.environ[_k] = _v
# -----------------------------


app = Flask(__name__)

_lock = threading.Lock()
_firebase_app = None


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
        p = self._resolve(path)
        if p is None or not p.is_dir():
            return []
        return sorted([item.name for item in p.iterdir()], key=lambda x: x.lower())
    
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
        
        if _firebase_app is None:
            if credentials_path:
                creds = credentials.Certificate(credentials_path)
                _firebase_app = firebase_admin.initialize_app(creds, {
                    'storageBucket': bucket_name
                })
            else:
                _firebase_app = firebase_admin.initialize_app(options={
                    'storageBucket': bucket_name
                })
        
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
    
    def list_dir(self, path: str) -> list[str]:
        """List direct children of a path."""
        try:
            path = path.rstrip("/")
            if path:
                path += "/"

            _explorer_log("FirebaseStorage.list_dir", f"listing prefix={path!r}")
            t0 = time.monotonic()
            blobs = self.bucket.list_blobs(prefix=path, delimiter="/")
            names = set()
            page_num = 0

            for page in blobs.pages:
                page_num += 1
                page_prefixes = 0
                page_blobs = 0
                for prefix in getattr(page, "prefixes", []):
                    page_prefixes += 1
                    name = prefix[len(path):].rstrip("/")
                    if name:
                        names.add(name)
                for blob in page:
                    page_blobs += 1
                    name = blob.name[len(path):] if path else blob.name
                    if name:
                        names.add(name)
                _explorer_log(
                    "FirebaseStorage.list_dir",
                    f"page {page_num}: +{page_prefixes} prefixes, +{page_blobs} blobs "
                    f"(unique names so far: {len(names)})",
                )

            elapsed = time.monotonic() - t0
            _explorer_log(
                "FirebaseStorage.list_dir",
                f"done prefix={path!r}: {len(names)} names in {page_num} page(s), {elapsed:.2f}s",
            )
            return sorted(names, key=lambda x: x.lower())
        except Exception as exc:
            _explorer_log("FirebaseStorage.list_dir", f"failed prefix={path!r}: {exc}")
            return []
    
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
        
        creds_path = (os.environ.get("EXPLORER_FIREBASE_CREDENTIALS") or "").strip()
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
    - `inference_model_version`: string (default "")
    - `inference_alternative_transcript`: list (default [])
    - `user_validated`: boolean (default False)
    - preserve existing `is_reviewed` if present, but do not automatically add it
    - `reviewer_corrected_transcript`: string (default "")
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
    e["inference_model_version"] = e.get("inference_model_version") or ""

    alt = e.get("inference_alternative_transcript")
    e["inference_alternative_transcript"] = alt if isinstance(alt, list) else []

    # review/user flags
    e["user_validated"] = _coerce_bool(e.get("user_validated", False))
    if "is_reviewed" in e:
        e["is_reviewed"] = _coerce_bool(e["is_reviewed"])
    e["reviewer_corrected_transcript"] = e.get("reviewer_corrected_transcript") or ""

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


def _build_folder_record(
    folder_name: str,
    n_audios: int,
    audios_duration: float,
    is_processed: bool,
) -> dict[str, Any]:
    return {
        "folder_name": folder_name,
        "is_processed": is_processed,
        "n_audios": n_audios,
        "audios_duration": round(audios_duration, 3),
    }


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
) -> None:
    sorted_records = sorted(records, key=lambda r: str(r.get("folder_name", "")).lower())
    _atomic_write_json(storage, _folders_json_path(root), sorted_records)


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


def _dataset_names_from_listing(
    storage: StorageBackend,
    root: str,
    entries: list[str],
) -> list[str]:
    """Derive dataset folder names from a single list_dir result."""
    names: list[str] = []
    if isinstance(storage, FirebaseStorageBackend):
        # list_dir uses delimiter="/"; prefixes are subfolders (no per-folder is_dir).
        for name in entries:
            if name.startswith(".") or name.endswith(".json"):
                continue
            names.append(name)
    else:
        for name in entries:
            if name.startswith("."):
                continue
            if storage.is_dir(_join_path(root, name)):
                names.append(name)
    return sorted(names, key=str.lower)


def _list_dataset_folder_names(storage: StorageBackend, root: str) -> list[str]:
    t0 = time.monotonic()
    entries = storage.list_dir(root)
    names = _dataset_names_from_listing(storage, root, entries)
    _explorer_log(
        "_list_dataset_folder_names",
        f"{len(names)} folder(s) from {len(entries)} listing(s) in {time.monotonic() - t0:.2f}s",
    )
    return names


def _compute_folder_audio_stats(
    storage: StorageBackend,
    root: str,
    folder: str,
    *,
    log: bool = True,
) -> tuple[int, float]:
    if log:
        _explorer_log("_compute_folder_audio_stats", f"start folder={folder!r}")
    t0 = time.monotonic()
    folder_path = _join_path(root, folder)
    data_path = _join_path(folder_path, "data.json")
    total_audios = 0
    total_duration = 0.0
    if storage.exists(data_path):
        try:
            if log:
                _explorer_log("_compute_folder_audio_stats", f"reading {data_path!r}")
            data = _read_json(storage, data_path)
            entries, _ = _extract_entries(data)
            total_audios = len(entries)
            for e in entries:
                if isinstance(e, dict):
                    total_duration += _entry_duration_seconds(e)
        except Exception as exc:
            if log:
                _explorer_log(
                    "_compute_folder_audio_stats",
                    f"failed folder={folder!r}: {exc}",
                )
    elif log:
        _explorer_log(
            "_compute_folder_audio_stats",
            f"no data.json for folder={folder!r}",
        )
    if log:
        _explorer_log(
            "_compute_folder_audio_stats",
            f"done folder={folder!r}: n_audios={total_audios}, "
            f"duration={total_duration:.3f}s, elapsed={time.monotonic() - t0:.2f}s",
        )
    return total_audios, total_duration


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


def _apply_folder_stats(record: dict[str, Any], n_audios: int, audios_duration: float) -> None:
    record["n_audios"] = n_audios
    record["audios_duration"] = round(audios_duration, 3)
    record.pop("is_reviewed", None)


def _sync_folders_json_manifest(
    storage: StorageBackend,
    root: str,
) -> tuple[list[str], list[str]]:
    """Ensure folders.json lists all dataset folders; keep cached stats (fast)."""
    t0 = time.monotonic()
    entries = storage.list_dir(root)
    folder_names = _dataset_names_from_listing(storage, root, entries)

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
        _explorer_log(
            "_sync_folders_json_manifest",
            f"created folders.json ({len(records)} records) in {time.monotonic() - t0:.2f}s",
        )
        return folder_names, entries

    existing_records = _read_folders_records(storage, root)
    index = _folders_index_by_name(existing_records)
    changed = False
    for name in folder_names:
        if name not in index:
            index[name] = _build_folder_record(name, 0, 0.0, False)
            changed = True
    if changed:
        _write_folders_records(storage, root, list(index.values()))
    _explorer_log(
        "_sync_folders_json_manifest",
        f"synced {len(folder_names)} folder(s), changed={changed}, "
        f"elapsed={time.monotonic() - t0:.2f}s",
    )
    return folder_names, entries


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
            n_audios, audios_duration = _compute_folder_audio_stats(storage, root, name)
            is_processed = name in legacy_processed
            records.append(_build_folder_record(name, n_audios, audios_duration, is_processed))

        legacy_only = sorted(legacy_processed - set(folder_names), key=str.lower)
        for i, name in enumerate(legacy_only, start=1):
            _explorer_log(
                "_refresh_folders_json",
                f"({i}/{len(legacy_only)}) legacy-only folder {name!r}",
            )
            records.append(_build_folder_record(name, 0, 0.0, True))

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
        n_audios, audios_duration = _compute_folder_audio_stats(storage, root, name)
        existing = index.get(name)
        if existing is not None:
            _apply_folder_stats(existing, n_audios, audios_duration)
            index[name] = existing
        else:
            index[name] = _build_folder_record(name, n_audios, audios_duration, False)
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
    n_audios, audios_duration = _compute_folder_audio_stats(storage, root, folder_name)
    records = _read_folders_records(storage, root)
    index = _folders_index_by_name(records)
    existing = index.get(folder_name)
    if existing is not None:
        _apply_folder_stats(existing, n_audios, audios_duration)
        index[folder_name] = existing
    else:
        index[folder_name] = _build_folder_record(
            folder_name, n_audios, audios_duration, False
        )
    _write_folders_records(storage, root, list(index.values()))


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
        n_audios, audios_duration = _compute_folder_audio_stats(storage, root, folder_name)
        index[folder_name] = _build_folder_record(
            folder_name, n_audios, audios_duration, is_processed
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


def _get_audio_duration_seconds(wav_bytes: bytes) -> float:
    try:
        with wave.open(io.BytesIO(wav_bytes), 'rb') as wf:
            return wf.getnframes() / wf.getframerate()
    except Exception:
        return 0.0


def _is_valid_recorder_folder(folder: str) -> bool:
    return bool(re.fullmatch(r"\d{8}_[A-Za-z0-9_-]+_frontend", folder))


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
            return jsonify({"error": "Invalid recorder folder name. Expected YYYYMMDD_username_frontend"}), 400
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
        model_version = ""
        alternatives = []

        folder_path = _join_path(cfg.root, folder)
        data_path = _join_path(folder_path, "data.json")
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
                "inference_confidence": whisper_conf,
                "inference_model_version": model_version,
                "inference_alternative_transcript": alternatives,
                "user_validated": False,
                "reviewer_is_reviewed": False,
                "reviewer_corrected_transcript": word,
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
            folder_names, root_entries = _sync_folders_json_manifest(
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

        root_json_files = [
            name
            for name in root_entries
            if name.endswith(".json")
            and cfg.storage.is_file(_join_path(cfg.root, name))
        ]

        return jsonify({
            "source": cfg.source,
            "root": cfg.root,
            "folders": folders,
            "processed": processed,
            "root_json_files": root_json_files,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


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
        if record is None or force_refresh:
            with _lock:
                _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)
            record = _get_folder_record(cfg.storage, cfg.root, folder)
        if record is None:
            n_audios, audios_duration = _compute_folder_audio_stats(
                cfg.storage, cfg.root, folder
            )
            is_processed = _folder_processed_status(cfg.storage, cfg.root, folder)
            record = _build_folder_record(folder, n_audios, audios_duration, is_processed)

        return jsonify({
            "folder": folder,
            "processed": _folder_is_processed(record),
            "total_audios": int(record.get("n_audios", 0)),
            "total_duration_str": _format_duration(float(record.get("audios_duration", 0))),
        })
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
        
        folder_path = _join_path(cfg.root, folder)
        if not cfg.storage.is_dir(folder_path):
            return jsonify({"error": f"Folder not found: {folder}"}), 404

        # Ensure folder has an entry in folders.json and refresh its stats on open
        with _lock:
            _update_folder_stats_in_folders_json(cfg.storage, cfg.root, folder)
        record = _get_folder_record(cfg.storage, cfg.root, folder)

        data_path = _join_path(folder_path, "data.json")
        entries: list[Any] = []
        if cfg.storage.exists(data_path):
            data = _read_json(cfg.storage, data_path)
            try:
                entries, _mode = _extract_entries(data)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
        
        json_files = [
            name
            for name in cfg.storage.list_dir(folder_path)
            if name.endswith(".json") and cfg.storage.is_file(_join_path(folder_path, name))
        ]
        
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
        
        allowed_fields = {"reviewer_corrected_transcript", "is_reviewed", "reviewer_is_reviewed"}
        filtered = {k: v for k, v in updates.items() if k in allowed_fields}
        if not filtered:
            return jsonify({"error": "No supported fields in updates"}), 400
        
        folder_path = _join_path(cfg.root, folder)
        data_path = _join_path(folder_path, "data.json")
        if not cfg.storage.exists(data_path):
            return jsonify({"error": "Folder has no data.json"}), 404
        
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
            
            if "reviewer_corrected_transcript" in filtered:
                entry["reviewer_corrected_transcript"] = str(filtered["reviewer_corrected_transcript"])
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
        data_path = _join_path(folder_path, "data.json")
        if not cfg.storage.exists(data_path):
            return jsonify({"error": "Folder has no data.json"}), 404
        
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
            if _coerce_bool(entry.get("user_validated", False)):
                return jsonify({
                    "error": "The transcript has been validated by the user. Further transcription (through Generate) is not allowed - to avoid losing the transcript validated by the user"
                }), 400
            
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
            url = f"http://{host}:{port}/transcribe?upload_to_firebase_server=false&process_with_llm=false&return_alternatives=true&json_response=true"
            
            try:
                audio_data = cfg.storage.read_bytes(audio_file_path)
                files = {"wav": (os.path.basename(audio_rel), io.BytesIO(audio_data), "audio/wav")}
                resp = requests.post(url, files=files, timeout=120)
                if resp.status_code != 200:
                    return jsonify({
                        "error": "Model server returned error",
                        "status_code": resp.status_code,
                        "text": resp.text
                    }), 502
                result = resp.json()
            except Exception as e:
                return jsonify({"error": str(e)}), 500
            
            # Map result fields into entry properties
            entry["inference_transcript"] = result.get("transcript") or ""
            try:
                entry["inference_confidence"] = float(result.get("whisper_confidence")) if result.get("whisper_confidence") is not None else 0.0
            except Exception:
                entry["inference_confidence"] = 0.0
            entry["inference_model_version"] = result.get("whisper_model") or ""
            entry["inference_alternative_transcript"] = result.get("alternatives") if isinstance(result.get("alternatives"), list) else []

            # Normalize entry prior to persisting/returning so it conforms to schema
            entry = _normalize_entry(entry)
            
            # Persist changes
            entries[index] = entry
            _persist_data_json(cfg.storage, data_path, data, entries, mode)
        
        return jsonify({"ok": True, "entry": entry})
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
        data_path = _join_path(folder_path, "data.json")
        if not cfg.storage.exists(data_path):
            return jsonify({"error": "Folder has no data.json"}), 404

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
        data_path = _join_path(folder_path, "data.json")
        if not cfg.storage.exists(data_path):
            return jsonify({"error": "Folder has no data.json"}), 404
        
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
