"""General utility functions for the project.

This module currently exposes text-normalization utilities (previously in
`utils/text_normalizer.py`) and is intended as a single import target for
future helpers.
"""
import math
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

try:
    from transformers.models.whisper.english_normalizer import BasicTextNormalizer
except Exception:  # pragma: no cover - optional dependency
    BasicTextNormalizer = None

try:
    from spellchecker import SpellChecker
except Exception:  # pragma: no cover - optional dependency
    SpellChecker = None

import atexit
import copy
import json
import os
import shutil
import tempfile
import random
import uuid
import urllib.error
import urllib.parse
import urllib.request

try:
    from google.cloud import storage as google_storage
    from google.oauth2 import service_account as google_service_account
except Exception:
    google_storage = None
    google_service_account = None

try:
    import librosa  # noqa: F401
except Exception:  # pragma: no cover - optional dependency
    librosa = None

# Initialize spell checker and normalizer
spell = SpellChecker(language="it") if SpellChecker is not None else None
normalizer = BasicTextNormalizer() if BasicTextNormalizer is not None else None

# Substitutions log file path (can be set by callers)
substitutions_log_path: Optional[str] = None


def load_env_file(env_file: Path) -> dict[str, str]:
    """Load simple KEY=VALUE settings into the process environment."""
    env_file = env_file.expanduser().resolve()
    if not env_file.is_file():
        raise FileNotFoundError(f"Env file not found: {env_file}")

    env_vars: dict[str, str] = {}
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        env_vars[key.strip()] = value.encode("utf-8").decode("unicode_escape")

    os.environ.update(env_vars)
    return env_vars


def _normalize_env_private_key(private_key: str | None) -> str | None:
    if not private_key:
        return private_key
    return private_key.replace("\\n", "\n")


def _build_google_service_account_info_from_env() -> dict[str, Any] | None:
    project_id = (os.environ.get("FIREBASE_ADMIN_PROJECT_ID") or "").strip()
    if not project_id:
        return None

    private_key = _normalize_env_private_key(os.environ.get("FIREBASE_ADMIN_PRIVATE_KEY"))
    client_email = (os.environ.get("FIREBASE_ADMIN_CLIENT_EMAIL") or "").strip()
    if not private_key or not client_email:
        return None

    return {
        "type": os.environ.get("FIREBASE_ADMIN_TYPE", "service_account"),
        "project_id": project_id,
        "private_key_id": os.environ.get("FIREBASE_ADMIN_PRIVATE_KEY_ID"),
        "private_key": private_key,
        "client_email": client_email,
        "client_id": os.environ.get("FIREBASE_ADMIN_CLIENT_ID"),
        "auth_uri": os.environ.get("FIREBASE_ADMIN_AUTH_URI"),
        "token_uri": os.environ.get("FIREBASE_ADMIN_TOKEN_URI"),
        "auth_provider_x509_cert_url": os.environ.get("FIREBASE_ADMIN_AUTH_PROVIDER_X509_CERT_URL"),
        "client_x509_cert_url": os.environ.get("FIREBASE_ADMIN_CLIENT_X509_CERT_URL"),
        "universe_domain": os.environ.get("FIREBASE_ADMIN_UNIVERSE_DOMAIN", "googleapis.com"),
    }


def _ensure_google_application_credentials_from_env(env: dict[str, str]) -> None:
    if env.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return

    service_account_info = _build_google_service_account_info_from_env()
    if not service_account_info:
        return

    tmp_file = tempfile.NamedTemporaryFile("w", delete=False, suffix=".json", encoding="utf-8")
    json.dump(service_account_info, tmp_file, ensure_ascii=False, indent=2)
    tmp_file.close()

    credentials_path = tmp_file.name
    env["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
    atexit.register(lambda path=credentials_path: os.remove(path) if os.path.exists(path) else None)


def _build_google_service_account_credentials() -> Any | None:
    if google_service_account is None:
        return None

    service_account_info = _build_google_service_account_info_from_env()
    if not service_account_info:
        return None

    return google_service_account.Credentials.from_service_account_info(service_account_info)


def _download_folder_with_storage_client(
    bucket_name: str,
    folder: str,
    destination_folder: str,
    only_download_json: bool,
    force_download_data_json: bool,
    download_txt: bool = False,
    force_download_wav: bool = False,
):
    if google_storage is None:
        raise EnvironmentError(
            "google-cloud-storage is required for Python storage client fallback. "
            "Install it in the notebook environment."
        )

    creds = _build_google_service_account_credentials()
    if creds is None:
        raise EnvironmentError(
            "Unable to build service account credentials from FIREBASE_ADMIN_* env vars. "
            "Set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_PRIVATE_KEY, and FIREBASE_ADMIN_CLIENT_EMAIL."
        )

    client = google_storage.Client(project=creds.project_id, credentials=creds)
    bucket = client.bucket(bucket_name)
    prefix = folder.rstrip("/") + "/"

    blobs = list(bucket.list_blobs(prefix=prefix))
    if not blobs:
        print(f"   Warning: no objects found under gs://{bucket_name}/{prefix}")

    os.makedirs(destination_folder, exist_ok=True)

    for blob in blobs:
        name = blob.name
        if not name.startswith(prefix) or name.endswith("/"):
            continue

        if only_download_json and not name.endswith(".json"):
            continue

        allowed_extensions = [".json", ".wav"]
        if download_txt:
            allowed_extensions.append(".txt")

        if not only_download_json and not any(name.endswith(ext) for ext in allowed_extensions):
            continue

        local_path = os.path.join(destination_folder, os.path.relpath(name, prefix))
        os.makedirs(os.path.dirname(local_path), exist_ok=True)

        is_data_json = name == prefix + "data.json" or name.endswith("_data.json")
        is_wav = name.endswith(".wav")
        force_redownload = (force_download_data_json and is_data_json) or (force_download_wav and is_wav)
        if os.path.exists(local_path) and not force_redownload:
            print(f"   Skipping {name} (already exists locally)")
        else:
            print(f"   Downloading {name} -> {local_path}")
            blob.download_to_filename(local_path)


def upload_folder_with_storage_client(
    local_path: str,
    bucket_name: str,
    bucket_path: str = "",
    text_only: bool = False,
    overwrite: bool = False,
) -> int:
    """Recursively upload a local folder to a Google Cloud Storage bucket."""
    if google_storage is None:
        raise EnvironmentError("google-cloud-storage is required for the storage client.")

    credentials = _build_google_service_account_credentials()
    if credentials is None:
        raise EnvironmentError(
            "Unable to build service account credentials from FIREBASE_ADMIN_* env vars. "
            "Set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_PRIVATE_KEY, and "
            "FIREBASE_ADMIN_CLIENT_EMAIL."
        )

    local_root = Path(local_path)
    if not local_root.is_dir():
        raise NotADirectoryError(f"Local path is not a directory: {local_root}")

    client = google_storage.Client(project=credentials.project_id, credentials=credentials)
    bucket = client.bucket(bucket_name)
    remote_root = bucket_path.strip("/")
    text_extensions = {".txt", ".json", ".csv", ".md", ".html"}
    files_uploaded = 0

    for file_path in sorted(path for path in local_root.rglob("*") if path.is_file()):
        if text_only and file_path.suffix.lower() not in text_extensions:
            print(f"Skipping non-text file: {file_path.relative_to(local_root)}")
            continue

        relative_path = file_path.relative_to(local_root).as_posix()
        remote_path = f"{remote_root}/{relative_path}" if remote_root else relative_path
        blob = bucket.blob(remote_path)
        exists = bool(blob.exists())
        if exists and not overwrite:
            print(f"Skipping existing: {remote_path}")
            continue
        if exists:
            print(f"Overwriting: {remote_path}")
        blob.upload_from_filename(str(file_path))
        files_uploaded += 1
        print(f"Uploaded: {remote_path}")

    return files_uploaded


def _load_metadata_entries(folder_path: Path) -> List[Dict[str, Any]]:
    """Load metadata entries from one folder, supporting list payloads and common dict wrappers."""
    entries: List[Dict[str, Any]] = []
    for json_file in sorted(folder_path.glob("*.json")):
        try:
            with open(json_file, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (TypeError, ValueError, OSError):
            continue

        if isinstance(payload, list):
            entries.extend([entry for entry in payload if isinstance(entry, dict)])
            continue

        if isinstance(payload, dict):
            for candidate_key in ["data", "entries", "results"]:
                candidate = payload.get(candidate_key)
                if isinstance(candidate, list):
                    entries.extend([entry for entry in candidate if isinstance(entry, dict)])
                    break
            else:
                if any(key in payload for key in ["audio_data", "inference_transcript", "reviewer_transcript_corrected", "user_is_validated"]):
                    entries.append(payload)
                else:
                    for value in payload.values():
                        if isinstance(value, dict):
                            entries.append(value)
                        elif isinstance(value, list):
                            entries.extend([entry for entry in value if isinstance(entry, dict)])
    return entries


def _load_excluded_entries(
    exclude_entries: Optional[Iterable[Dict[str, Any]] | str | Path],
) -> List[Dict[str, Any]]:
    """Load excluded metadata entries provided directly or in a JSON file."""
    if exclude_entries is None:
        return []

    entries: Iterable[Any]
    if isinstance(exclude_entries, (str, Path)):
        try:
            payload = json.loads(Path(exclude_entries).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Unable to load excluded entries from {exclude_entries}") from exc

        if isinstance(payload, dict):
            entries = payload.get("selected_entries", [])
        else:
            entries = payload
        if not isinstance(entries, list):
            raise ValueError("Exclusion JSON must be a list of entries or contain a 'selected_entries' list")
    else:
        entries = exclude_entries

    return [entry for entry in entries if isinstance(entry, dict)]


def _load_excluded_entry_signatures(
    exclude_entries: Optional[Iterable[Dict[str, Any]] | str | Path],
) -> set[str]:
    """Return canonical signatures for excluded metadata entries."""
    return {
        json.dumps(entry, sort_keys=True, ensure_ascii=False)
        for entry in _load_excluded_entries(exclude_entries)
    }


def _load_excluded_audio_paths(
    exclude_entries: Optional[Iterable[Dict[str, Any]] | str | Path],
    input_root: Path,
) -> set[str]:
    """Return normalized audio paths for excluded metadata entries."""
    audio_paths = set()
    for entry in _load_excluded_entries(exclude_entries):
        audio_data = entry.get("audio_data")
        if not isinstance(audio_data, str) or not audio_data.strip():
            continue
        audio_path = Path(audio_data.strip()).expanduser()
        if not audio_path.is_absolute():
            audio_path = input_root / audio_path
        audio_paths.add(os.path.normcase(str(audio_path.resolve())))
    return audio_paths


def _prefix_entry_audio_path(entry: Dict[str, Any], folder_name: str) -> Dict[str, Any]:
    """Return an entry copy with its audio path relative to the input root."""
    prefixed_entry = copy.deepcopy(entry)
    audio_data = prefixed_entry.get("audio_data")
    if isinstance(audio_data, str) and audio_data:
        folder_prefix = f"{folder_name}/"
        relative_audio_path = audio_data.lstrip("/")
        if not relative_audio_path.startswith(folder_prefix):
            prefixed_entry["audio_data"] = f"{folder_prefix}{relative_audio_path}"
    return prefixed_entry


def _entry_is_excluded(
    entry: Dict[str, Any],
    folder_name: str,
    excluded_entry_signatures: set[str],
) -> bool:
    """Check source and folder-prefixed forms against excluded metadata entries."""
    entry_signatures = {
        json.dumps(entry, sort_keys=True, ensure_ascii=False),
        json.dumps(_prefix_entry_audio_path(entry, folder_name), sort_keys=True, ensure_ascii=False),
    }
    return not entry_signatures.isdisjoint(excluded_entry_signatures)


def _resolve_audio_path(folder_path: Path, entry: Dict[str, Any], dir_input: Path) -> Optional[Path]:
    """Locate an audio file referenced by metadata, supporting relative paths from the folder or input root."""
    audio_data = entry.get("audio_data")
    if not isinstance(audio_data, str) or not audio_data.strip():
        return None

    potential_paths = []
    candidate = audio_data.strip()
    if os.path.isabs(candidate):
        potential_paths.append(Path(candidate))
    else:
        potential_paths.extend([
            folder_path / candidate,
            dir_input / candidate,
            folder_path / Path(candidate).name,
            dir_input / Path(candidate).name,
        ])

    for path in potential_paths:
        if path.exists() and path.is_file():
            return path
    return None


def _copy_audio_to_output(audio_path: Path, output_dir: Path, sample_id: str) -> Path:
    """Copy a source audio file to the output folder, preserving a single audio suffix."""
    output_dir.mkdir(parents=True, exist_ok=True)
    destination_name = f"{sample_id}{audio_path.suffix}"
    destination_path = output_dir / destination_name
    shutil.copy2(audio_path, destination_path)
    return destination_path


def _build_dataset_row(entry: Dict[str, Any], output_path: Path, extra_fields: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Clone a metadata entry and replace the audio reference with the copied local path."""
    row = copy.deepcopy(entry)
    row["audio_data"] = str(output_path.resolve())
    if extra_fields:
        row.update(extra_fields)
    return row


def remove_duplicate_dataset_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remove exact duplicate dataset entries while preserving their original order."""
    unique_entries = []
    seen_signatures = set()
    for entry in entries:
        signature = json.dumps(entry, sort_keys=True, ensure_ascii=False)
        if signature not in seen_signatures:
            seen_signatures.add(signature)
            unique_entries.append(entry)

    duplicates_removed = len(entries) - len(unique_entries)
    if duplicates_removed:
        print(f"Removed {duplicates_removed} duplicate dataset entr{'y' if duplicates_removed == 1 else 'ies'}.")
    return unique_entries


def compare_dataset_overlaps(
    dataset_a_path: str | Path,
    dataset_b_path: str | Path,
) -> Dict[str, Any]:
    """Find entries in two JSON datasets that reference the same audio file.

    Audio paths are normalized to absolute paths before comparison. The result
    contains every matching entry pair.
    """
    def load_entries(dataset_path: str | Path) -> List[Dict[str, Any]]:
        path = Path(dataset_path)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Unable to load dataset from {path}") from exc

        if isinstance(payload, dict):
            for key in ("selected_entries", "data", "entries", "results"):
                if isinstance(payload.get(key), list):
                    payload = payload[key]
                    break
        if not isinstance(payload, list):
            raise ValueError(f"Dataset JSON must be a list of entries: {path}")
        return [entry for entry in payload if isinstance(entry, dict)]

    def normalize_audio_path(entry: Dict[str, Any]) -> Optional[str]:
        audio_path = entry.get("audio_data")
        if not isinstance(audio_path, str) or not audio_path.strip():
            return None
        return os.path.normcase(os.path.abspath(os.path.expanduser(audio_path.strip())))

    dataset_a_entries = load_entries(dataset_a_path)
    dataset_b_entries = load_entries(dataset_b_path)
    dataset_b_by_audio_path: Dict[str, List[Dict[str, Any]]] = {}
    for entry in dataset_b_entries:
        audio_path = normalize_audio_path(entry)
        if audio_path:
            dataset_b_by_audio_path.setdefault(audio_path, []).append(entry)

    overlaps = []
    for entry_a in dataset_a_entries:
        audio_path_a = normalize_audio_path(entry_a)
        if not audio_path_a:
            continue
        for entry_b in dataset_b_by_audio_path.get(audio_path_a, []):
            overlaps.append({
                "dataset_a_entry": entry_a,
                "dataset_b_entry": entry_b,
            })

    return {
        "dataset_a_path": str(dataset_a_path),
        "dataset_b_path": str(dataset_b_path),
        "dataset_a_entry_count": len(dataset_a_entries),
        "dataset_b_entry_count": len(dataset_b_entries),
        "has_overlaps": bool(overlaps),
        "overlap_count": len(overlaps),
        "overlaps": overlaps,
    }


def _coerce_confidence(value: Any) -> Optional[float]:
    """Convert a numeric or numeric-like field into a float when possible."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def _validate_inference_confidence_threshold(threshold: float) -> None:
    if isinstance(threshold, bool) or not 0 <= threshold <= 100:
        raise ValueError("inference_confidence_threshold_pct must be between 0 and 100")


def _compute_ipo_confidence_gap(winner_confidence: Any, loser_confidence: Any) -> Optional[float]:
    """Return the confidence gap between winner and loser confidences, if both can be parsed."""
    winner_value    = _coerce_confidence(winner_confidence)
    loser_value     = _coerce_confidence(loser_confidence)
    if winner_value is None or loser_value is None:
        return None
    return round(winner_value - loser_value, 2)


def _write_dataset_artifacts(
    rows: List[Dict[str, Any]],
    output_dir: Path,
    dataset_name: str,
    json_filename: Optional[str] = None,
) -> Dict[str, str]:
    """Write a JSON artifact for one dataset without generating CSV files."""
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / (json_filename or f"{dataset_name}.json")
    csv_path = output_dir / f"{dataset_name}.csv"
    if csv_path.exists():
        csv_path.unlink()

    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(rows, handle, ensure_ascii=False, indent=2)

    return {"json_path": str(json_path)}


def _build_transcribe_endpoint_url(endpoint_url: str) -> str:
    """Normalize a model-server address into a `/transcribe` URL with dataset-safe query params."""
    parsed = urllib.parse.urlparse(endpoint_url.strip())
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(
            "transcribe_endpoint must be a full URL, for example 'http://127.0.0.1:8000' "
            "or 'http://127.0.0.1:8000/transcribe'"
        )

    path = parsed.path.rstrip("/")
    if not path.endswith("/transcribe"):
        path = f"{path}/transcribe" if path else "/transcribe"

    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("upload_to_firebase_server", "false")
    query.setdefault("process_with_llm", "false")
    query.setdefault("return_alternatives", "false")
    query.setdefault("json_response", "true")
    return urllib.parse.urlunparse(parsed._replace(path=path, query=urllib.parse.urlencode(query)))


def _transcribe_audio_via_endpoint(
    audio_path: Path,
    endpoint_url: str,
    timeout: int = 120,
) -> Dict[str, Any]:
    """POST a WAV file to a model-server `/transcribe` endpoint and return transcript fields."""
    url = _build_transcribe_endpoint_url(endpoint_url)
    boundary = f"----chiara-dataset-ipo-{uuid.uuid4().hex}"
    file_bytes = audio_path.read_bytes()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="wav"; filename="{audio_path.name}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw_body = response.read().decode("utf-8", errors="ignore")
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="ignore") if exc.fp else ""
        raise RuntimeError(
            f"Transcribe endpoint returned HTTP {exc.code} for {audio_path}: {error_body or exc.reason}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Unable to reach transcribe endpoint {url}: {exc}") from exc

    transcript = ""
    confidence: Any = None
    stripped = raw_body.strip()
    if "json" in content_type.lower() or stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Transcribe endpoint returned invalid JSON for {audio_path}") from exc
        if isinstance(payload, dict):
            if payload.get("error"):
                raise RuntimeError(f"Transcribe endpoint error for {audio_path}: {payload.get('error')}")
            transcript = str(payload.get("transcript") or "").strip()
            confidence = payload.get("whisper_confidence")
        else:
            transcript = stripped
    else:
        transcript = stripped

    return {
        "transcript": transcript,
        "whisper_confidence": confidence,
    }


def create_dataset_eval(
    folders: Optional[Iterable[str]],
    dir_input: Optional[str],
    dir_output: Optional[str],
    inference_confidence_threshold_pct: float = 85.0,
    ground_truth_source: str = "only_reviewer",
    ratio: float = 0.1,
    seed: int = 42,
    existing_eval_dataset_path: Optional[str | Path] = None,
    output_filename: str = "dataset-eval.json",
) -> Dict[str, Any]:
    """Create an evaluation dataset from reviewer-reviewed or user-validated entries.

    if folders is None, all folders in dir_input are processed.

    ``ground_truth_source`` selects ``"only_reviewer"``, ``"only_user"``
    (user validated and above ``inference_confidence_threshold_pct``), or
    ``"reviewer_and_user"``. By default, only reviewer-reviewed entries are
    selected. The returned ``selected_entries`` contains each full metadata
    entry and its selected transcript in ``ground_truth``.
    ``inference_confidence_threshold_pct`` is a percentage from 0 to 100.
    ``ratio`` controls the fraction of eligible entries included, selected after
    a seeded shuffle. When ``existing_eval_dataset_path`` is provided, entries
    in that JSON dataset are retained and new entries are appended only when
    needed to reach the requested ratio. ``output_filename`` sets the JSON
    artifact name and the corresponding exclusion-log basename.
    """
    _validate_inference_confidence_threshold(inference_confidence_threshold_pct)
    if not 0 <= ratio <= 1:
        raise ValueError("ratio must be between 0 and 1")
    if not dir_input:
        raise ValueError("dir_input is required")
    if not dir_output:
        raise ValueError("dir_output is required")
    if Path(output_filename).name != output_filename or Path(output_filename).suffix.lower() != ".json":
        raise ValueError("output_filename must be a JSON filename without a directory path")
    valid_ground_truth_sources = {"only_reviewer", "only_user", "reviewer_and_user"}
    if ground_truth_source not in valid_ground_truth_sources:
        raise ValueError(
            "ground_truth_source must be 'only_reviewer', 'only_user', or 'reviewer_and_user'"
        )

    input_root = Path(dir_input)
    output_dir = Path(dir_output)
    selected_entries: List[Dict[str, Any]] = []
    existing_audio_paths: set[str] = set()
    if existing_eval_dataset_path is not None:
        existing_path = Path(existing_eval_dataset_path)
        try:
            existing_payload = json.loads(existing_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Unable to load existing eval dataset from {existing_path}") from exc

        if isinstance(existing_payload, dict):
            existing_payload = existing_payload.get("selected_entries")
        if not isinstance(existing_payload, list):
            raise ValueError("Existing eval dataset must be a list of entries or contain a 'selected_entries' list")

        selected_entries = [entry for entry in existing_payload if isinstance(entry, dict)]
        existing_audio_paths = {
            entry["audio_data"].strip().lstrip("/")
            for entry in selected_entries
            if isinstance(entry.get("audio_data"), str) and entry["audio_data"].strip()
        }

    folder_names = folders
    if folder_names is None:
        folder_names = (
            path.name for path in input_root.iterdir() if path.is_dir()
        ) if input_root.is_dir() else []

    if ground_truth_source == "only_reviewer":
        print("[create_dataset_eval] Selecting only reviewer-reviewed entries for evaluation dataset")
    elif ground_truth_source == "only_user":
        print(
            "[create_dataset_eval] Selecting only user-validated entries with "
            f"inference confidence above {inference_confidence_threshold_pct}% for evaluation dataset"
        )
    else:
        print(
            "[create_dataset_eval] Selecting reviewer-reviewed entries and user-validated "
            f"entries with inference confidence above {inference_confidence_threshold_pct}% "
            "for evaluation dataset"
        )

    new_entries: List[tuple[str, Dict[str, Any]]] = []
    excluded_entries_log: List[Dict[str, Any]] = []
    for folder_name in sorted({folder for folder in folder_names if folder}):
        folder_path = input_root / folder_name
        if not folder_path.exists():
            continue

        #print(f"[create_dataset_eval] Processing folder '{folder_name}' at '{folder_path}'...")

        for entry in _load_metadata_entries(folder_path):
            is_reviewer_reviewed = entry.get("reviewer_is_reviewed") is True
            is_user_validated = entry.get("user_is_validated") is True
            inference_confidence = entry.get("inference_confidence")
            has_confidence_above_threshold = (
                isinstance(inference_confidence, (int, float))
                and inference_confidence > inference_confidence_threshold_pct
            )
            reviewer_is_eligible = (
                ground_truth_source in {"only_reviewer", "reviewer_and_user"}
                and is_reviewer_reviewed
            )
            user_is_eligible = (
                ground_truth_source in {"only_user", "reviewer_and_user"}
                and is_user_validated
                and has_confidence_above_threshold
            )
            is_eligible = reviewer_is_eligible or user_is_eligible
            if not is_eligible:
                if ground_truth_source == "only_reviewer":
                    exclusion_reason = "ground_truth_source='only_reviewer' requires reviewer_is_reviewed=true"
                elif ground_truth_source == "only_user":
                    exclusion_reason = (
                        "ground_truth_source='only_user' requires user_is_validated=true "
                        f"and inference_confidence > {inference_confidence_threshold_pct}%. "
                        f"This sample has: user_is_validated={is_user_validated}, "
                        f"inference_confidence={inference_confidence}"
                    )
                else:
                    exclusion_reason = (
                        "ground_truth_source='reviewer_and_user' requires reviewer_is_reviewed=true "
                        "or user_is_validated=true with inference confidence above "
                        f"{inference_confidence_threshold_pct}%. "
                        f"this sample has: reviewer_is_reviewed={is_reviewer_reviewed}, "
                        f"user_is_validated={is_user_validated}, "
                        f"inference_confidence={inference_confidence}"
                    )
                excluded_entries_log.append({
                    #"folder": folder_name,
                    #"entry": {"audio_data": entry.get("audio_data")},
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": exclusion_reason,
                })
                continue

            eval_entry = _prefix_entry_audio_path(entry, folder_name)
            audio_path = eval_entry.get("audio_data")
            if isinstance(audio_path, str) and audio_path.strip():
                audio_path_key = audio_path.strip().lstrip("/")
                original_audio_path = entry.get("audio_data")
                if audio_path_key in existing_audio_paths or (
                    isinstance(original_audio_path, str)
                    and original_audio_path.strip().lstrip("/") in existing_audio_paths
                ):
                    excluded_entries_log.append({
                        #"folder": folder_name,
                        #"entry": {"audio_data": entry.get("audio_data")},
                        "entry": f"{folder_name}/{entry.get('audio_data')}",
                        "exclusion_reason": "duplicate_audio_path",
                    })
                    continue
                existing_audio_paths.add(audio_path_key)
            entry_ground_truth_source = "reviewer" if reviewer_is_eligible else "user"
            eval_entry["source_ground_truth"] = entry_ground_truth_source
            resolved_audio_path = _resolve_audio_path(folder_path, entry, input_root)
            if resolved_audio_path is not None:
                eval_entry["audio_data"] = str(resolved_audio_path.resolve())
            new_entries.append((folder_name, eval_entry))

    rng = random.Random(seed)
    rng.shuffle(new_entries)
    if existing_eval_dataset_path is None:
        entries_to_keep = int(len(new_entries) * ratio)
    else:
        target_entry_count = math.ceil((len(selected_entries) + len(new_entries)) * ratio)
        entries_needed = max(0, target_entry_count - len(selected_entries))
        entries_to_keep = min(entries_needed, len(new_entries))
    for folder_name, entry in new_entries[entries_to_keep:]:
        excluded_entries_log.append({
            #"folder": folder_name,
            #"entry": {"audio_data": entry.get("audio_data")},
            "entry": f"{folder_name}/{entry.get('audio_data')}",            
            "exclusion_reason": "excluded_by_ratio",
        })
    selected_entries.extend(entry for _, entry in new_entries[:entries_to_keep])
    selected_entries = remove_duplicate_dataset_entries(selected_entries)
    for entry in selected_entries:
        is_reviewer_ground_truth = entry.get("source_ground_truth") == "reviewer" or (
            "source_ground_truth" not in entry and entry.get("reviewer_is_reviewed") is True
        )
        if is_reviewer_ground_truth:
            transcript = entry.get("reviewer_transcript_corrected") or entry.get("inference_transcript")
        else:
            transcript = entry.get("inference_transcript")
        entry["ground_truth"] = str(transcript)
        audio_data = entry.get("audio_data")
        if isinstance(audio_data, str) and audio_data.strip():
            audio_path = Path(audio_data)
            if not audio_path.is_absolute():
                audio_path = input_root / audio_path
            entry["audio_data"] = str(audio_path.resolve())

    print(f"[create_dataset_eval] Dataset contains {len(selected_entries)} entries")
    artifacts = _write_dataset_artifacts(
        selected_entries,
        output_dir,
        "dataset-eval",
        json_filename=output_filename,
    )
    artifacts["selected_entries"] = selected_entries
    exclusion_log_path = output_dir / f"{Path(output_filename).stem}_excluded.jsonl"
    with open(exclusion_log_path, "w", encoding="utf-8") as handle:
        for excluded_entry in excluded_entries_log:
            handle.write(json.dumps(excluded_entry, ensure_ascii=False) + "\n")
    artifacts["exclusion_log_path"] = str(exclusion_log_path)
    return artifacts


def create_dataset_sft(
    folders:        Optional[Iterable[str]],
    dir_input:      Optional[str],
    dir_output:     Optional[str],
    inference_confidence_threshold_pct: float   = 85.0,
    ground_truth_source: str                = "only_reviewer",
    exclude_entries: Optional[Iterable[Dict[str, Any]] | str | Path] = None,
    output_filename: str = "dataset-sft.json",
) -> Dict[str, str]:
    """Create an SFT-style dataset from metadata folders.

    Each row contains an audio path and a transcript.
    The output directory receives the ``sft.json`` by default; ``output_filename``
    can be used to choose a different JSON filename.

    ``ground_truth_source`` selects ``"only_reviewer"``, ``"only_user"``
    (user validated and above the inference confidence threshold), or
    ``"reviewer_and_user"``. Reviewer-corrected transcripts take precedence
    when both sources are included.
    ``inference_confidence_threshold_pct`` is a percentage from 0 to 100.
    ``exclude_entries`` accepts full metadata entries, a JSON file written by
    :func:`create_dataset_eval`, or a serialized result containing
    ``selected_entries``.
    """
    _validate_inference_confidence_threshold(inference_confidence_threshold_pct)
    if not dir_input:
        raise ValueError("dir_input is required")
    if not dir_output:
        raise ValueError("dir_output is required")
    valid_ground_truth_sources = {"only_reviewer", "only_user", "reviewer_and_user"}
    if ground_truth_source not in valid_ground_truth_sources:
        raise ValueError(
            "ground_truth_source must be 'only_reviewer', 'only_user', or 'reviewer_and_user'"
        )
    if Path(output_filename).name != output_filename or Path(output_filename).suffix.lower() != ".json":
        raise ValueError("output_filename must be a JSON filename without a directory path")

    output_dir          = Path(dir_output)
    output_dir.mkdir(parents=True, exist_ok=True)
    input_root          = Path(dir_input)
    rows: List[Dict[str, Any]] = []
    excluded_entries_log: List[Dict[str, Any]] = []
    excluded_entries = _load_excluded_entries(exclude_entries)
    excluded_entry_signatures = _load_excluded_entry_signatures(excluded_entries)
    excluded_audio_paths = _load_excluded_audio_paths(excluded_entries, input_root)

    folder_names = folders
    if folder_names is None:
        folder_names = (
            path.name for path in input_root.iterdir() if path.is_dir()
        ) if input_root.is_dir() else []

    if ground_truth_source      == "only_reviewer":
        print("[create_dataset_sft] Using only reviewer-corrected transcripts for ground truths")
    elif ground_truth_source    == "only_user":
        print(f"[create_dataset_sft] Using only user-validated transcripts with inference confidence above {inference_confidence_threshold_pct}% for ground truths")
    elif ground_truth_source    == "reviewer_and_user":
        print(f"[create_dataset_sft] Using reviewer-corrected and user-validated transcripts for ground truths")

    for folder_name in sorted({folder for folder in folder_names if folder}):
        folder_path = input_root / folder_name
        
        #print(f"[create_dataset_sft] Processing folder '{folder_name}' at '{folder_path}'...")
        
        if not folder_path.exists():
            continue

        for entry in _load_metadata_entries(folder_path):

            if _entry_is_excluded(entry, folder_name, excluded_entry_signatures):
                excluded_entries_log.append({
                    "folder": folder_name,
                    "entry": {"audio_data": entry.get("audio_data")},
                    "exclusion_reason": "listed in 'exclude_entries'",
                })
                continue

            # --- Check exlusion criteria based on
            # validation by: reviewer / user, inference confidence
            is_reviewer_reviewed            = entry.get("reviewer_is_reviewed") is True
            is_user_validated               = entry.get("user_is_validated") is True
            inference_confidence            = entry.get("inference_confidence")
            has_confidence_above_threshold  = False
            if isinstance(inference_confidence, (int, float)): has_confidence_above_threshold = inference_confidence >= inference_confidence_threshold_pct

            reviewer_is_eligible = (
                ground_truth_source in {"only_reviewer", "reviewer_and_user"}
                and is_reviewer_reviewed
            )
            user_is_eligible = (
                ground_truth_source in {"only_user", "reviewer_and_user"}
                and is_user_validated
                and has_confidence_above_threshold
                and (ground_truth_source != "only_user" or not is_reviewer_reviewed)
            )
            is_eligible = reviewer_is_eligible or user_is_eligible

            if not is_eligible:
                if ground_truth_source == "only_user":
                    exclusion_reason = (
                        "ground_truth_source='only_user' requires reviewer_is_reviewed=false, "
                        "user_is_validated=true, and "
                        f"inference_confidence >= {inference_confidence_threshold_pct}%. "
                        f"This sample has: reviewer_is_reviewed={is_reviewer_reviewed}, "
                        f"user_is_validated={is_user_validated}, "
                        f"inference_confidence={inference_confidence}"
                    )
                elif ground_truth_source == "only_reviewer":
                    exclusion_reason = (
                        "ground_truth_source='only_reviewer' requires reviewer_is_reviewed=true"
                        f". this sample has: reviewer_is_reviewed={is_reviewer_reviewed}"
                    )
                else:
                    exclusion_reason = (
                        "ground_truth_source='reviewer_and_user' requires reviewer_is_reviewed=true "
                        "or user_is_validated=true with inference confidence >= "
                        f"{inference_confidence_threshold_pct}%"
                        f". this sample has: reviewer_is_reviewed={is_reviewer_reviewed}, user_is_validated={is_user_validated}, inference_confidence={inference_confidence}"
                    )
                excluded_entries_log.append({
                    #"folder": folder_name,
                    #"entry": {"audio_data": entry.get("audio_data")},
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": exclusion_reason,
                })
                continue

            # --- check for a valid .wav audio file, and skip entries without one
            audio_path = _resolve_audio_path(folder_path, entry, input_root)
            if (
                audio_path is not None
                and os.path.normcase(str(audio_path.resolve())) in excluded_audio_paths
            ):
                excluded_entries_log.append({
                    #"folder": folder_name,
                    #"entry": {"audio_data": entry.get("audio_data")},
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": "listed in 'exclude_entries'",
                })
                continue
            if audio_path is None:
                excluded_entries_log.append({
                    #"folder": folder_name,
                    #"entry": {"audio_data": entry.get("audio_data")},
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": "audio_file_not_found",
                })
                continue # skip entries without a valid .wav audio file
            if audio_path.suffix.lower() != ".wav":
                excluded_entries_log.append({
                    #"folder": folder_name,
                    #"entry": {"audio_data": entry.get("audio_data")},
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": f"audio_file_is_not_wav: {audio_path.name}",
                })
                continue # skip entries without a valid .wav audio file


            # --- here, the sample is either:
            # - reviewer_is_reviewed=true
            # - (user_is_validated=true AND inference_confidence > threshold)
            # i.e. we want to use it for SFT
            # to get the transcript to be used as ground truth for the SFT,
            # we prioritize the reviewer-corrected transcript,
            # then the inference transcript
            if ground_truth_source == "only_user":
                transcript = entry.get("inference_transcript")
                sample_ground_truth_source = "user"
            elif reviewer_is_eligible:
                transcript = entry.get("reviewer_transcript_corrected") or entry.get("inference_transcript")
                sample_ground_truth_source = "reviewer"
            else:
                transcript = entry.get("inference_transcript")
                sample_ground_truth_source = "user"
            
            '''
            # and skip entries without any transcript.
            if not transcript:
                excluded_entries.append({
                    #"folder": folder_name,
                    #"entry": {"audio_data": entry.get("audio_data")},
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": "missing_transcript",
                })
                continue
            '''

            # --- here, we have a valid transcript and a valid .wav audio file
            # we can use the entry to build a dataset row

            # copy audio to destination path
            #destination_path = _copy_audio_to_output(audio_path, output_dir, f"{folder_name}_{audio_path.stem}")

            # set source of ground truth transcript for SFT dataset
            rows.append(
                _build_dataset_row(
                    entry,
                    #destination_path,
                    audio_path,
                    {
                        "source_ground_truth": sample_ground_truth_source,
                        "ground_truth": str(transcript),
                    },
                )
            )

    rows = remove_duplicate_dataset_entries(rows)
    artifacts = _write_dataset_artifacts(
        rows,
        output_dir,
        "sft",
        json_filename=output_filename,
    )

    # Write a log of excluded entries for transparency and debugging
    # for exclusion_log_path, use output_filename, remove .json suffix, and append _excluded.jsonl
    exclusion_log_path = output_dir / f"{Path(output_filename).stem}_excluded.jsonl"
    #exclusion_log_path = output_dir / "dataset-sft_excluded.jsonl"

    with open(exclusion_log_path, "w", encoding="utf-8") as handle:
        for excluded_entry in excluded_entries_log:
            handle.write(json.dumps(excluded_entry, ensure_ascii=False) + "\n")
    artifacts["exclusion_log_path"] = str(exclusion_log_path)

    # return a dictionary of artifacts, including the main dataset JSON and the exclusion log
    print(f"[create_dataset_sft] Dataset contains {len(rows)} entries")
    return artifacts


def create_dataset_kto(
    folders: Optional[Iterable[str]],
    dir_input: Optional[str],
    dir_output: Optional[str],
    inference_confidence_threshold_pct: float   = 85.0,
    ground_truth_source: str = "reviewer_and_user",
    exclude_entries: Optional[Iterable[Dict[str, Any]] | str | Path] = None,
    output_filename: str = "dataset-kto.json",
) -> Dict[str, str]:
    """Create a KTO dataset from accepted and rejected model transcripts.

    ``ground_truth_source`` selects ``"only_reviewer"``, ``"only_user"``
    (user validated and above the inference confidence threshold), or
    ``"reviewer_and_user"`` for positive examples. User-rejected inferences
    remain negative examples for all three modes.
    ``inference_confidence_threshold_pct`` is a percentage from 0 to 100.

    ``exclude_entries`` accepts full metadata entries or a JSON file containing
    a list of entries or a ``selected_entries`` field.
    Entries are excluded by matching their resolved audio paths as well as metadata.
    ``output_filename`` sets the name of the generated JSON artifact.
    """
    _validate_inference_confidence_threshold(inference_confidence_threshold_pct)
    if not dir_input:   raise ValueError("dir_input is required")
    if not dir_output:  raise ValueError("dir_output is required")
    valid_ground_truth_sources = {"only_reviewer", "only_user", "reviewer_and_user"}
    if ground_truth_source not in valid_ground_truth_sources:
        raise ValueError(
            "ground_truth_source must be 'only_reviewer', 'only_user', or 'reviewer_and_user'"
        )
    if Path(output_filename).name != output_filename or Path(output_filename).suffix.lower() != ".json":
        raise ValueError("output_filename must be a JSON filename without a directory path")

    output_dir = Path(dir_output)
    output_dir.mkdir(parents=True, exist_ok=True)
    input_root = Path(dir_input)
    excluded_entry_signatures = _load_excluded_entry_signatures(exclude_entries)
    excluded_audio_paths = _load_excluded_audio_paths(exclude_entries, input_root)
    
    rows: List[Dict[str, Any]] = []
    excluded_entries_log: List[Dict[str, Any]] = []

    folder_names = folders
    if folder_names is None:
        folder_names = (
            path.name for path in input_root.iterdir() if path.is_dir()
        ) if input_root.is_dir() else []

    for folder_name in sorted({folder for folder in folder_names if folder}):
        folder_path = input_root / folder_name
        
        if not folder_path.exists():
            continue

        for entry in _load_metadata_entries(folder_path):

            if _entry_is_excluded(entry, folder_name, excluded_entry_signatures):
                excluded_entries_log.append({
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": "listed in 'exclude_entries'",
                })
                continue

            # get fields
            is_reviewer_reviewed    = entry.get("reviewer_is_reviewed") is True
            is_user_validated       = entry.get("user_is_validated") is True
            reviewer_transcript     = entry.get("reviewer_transcript_corrected")
            inference_transcript    = entry.get("inference_transcript")

            # get whether confidence is above threshold
            inference_confidence            = entry.get("inference_confidence")
            has_confidence_above_threshold  = False
            if isinstance(inference_confidence, (int, float)):
                has_confidence_above_threshold = inference_confidence > inference_confidence_threshold_pct

            # if entry is
            # (i)   not reviewed by a reviewer (i.e. is_reviewer_reviewed==False), and
            # (ii)  we don't know if user validated it or not (i.e. user_is_validated is None)
            # then we can't use it for KTO dataset
            if is_reviewer_reviewed==False and entry.get("user_is_validated") is None:
                #print(f"Warning: entry is not reviewed and it is missing 'user_is_validated' field: {folder_path}/{entry.get('audio_data')}")
                #print(f"Warning: entry not included in dataset because we can't determine if it is a positive or negative sample")
                excluded_entries_log.append({
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": "missing user_is_validated; unable to determine label",
                })
                continue

            # determine label and transcript to use
            reviewer_is_eligible = (
                ground_truth_source in {"only_reviewer", "reviewer_and_user"}
                and is_reviewer_reviewed
            )
            user_is_eligible = (
                ground_truth_source in {"only_user", "reviewer_and_user"}
                and is_user_validated
                and has_confidence_above_threshold
                and (ground_truth_source != "only_user" or not is_reviewer_reviewed)
            )
            if reviewer_is_eligible:
                transcript    = reviewer_transcript
                label         = 1
                label_cause   = "reviewed by reviewer"
            elif user_is_eligible:
                transcript    = inference_transcript
                label         = 1
                label_cause   = f"validated by user, and inference confidence above threshold: {inference_confidence_threshold_pct}%"
            
            elif not is_reviewer_reviewed and not is_user_validated:
                transcript    = inference_transcript
                label         = 0
                label_cause   = "rejected by user"
            
            else:
                #print(f"Warning: {folder_path}/{entry.get('audio_data')} not included in dataset")
                #print(f"Warning: details: is_reviewer_reviewed={is_reviewer_reviewed}, reviewer_transcript={reviewer_transcript}, is_user_validated={is_user_validated}, inference_confidence={inference_confidence}, inference_transcript={inference_transcript}")
                if ground_truth_source == "only_reviewer":
                    exclusion_reason = "ground_truth_source='only_reviewer' requires reviewer_is_reviewed=true. this sample has: reviewer_is_reviewed={is_reviewer_reviewed}"
                elif ground_truth_source == "only_user":
                    exclusion_reason = (
                        "ground_truth_source='only_user' requires reviewer_is_reviewed=false, "
                        "user_is_validated=true, and "
                        f"inference_confidence > {inference_confidence_threshold_pct}%. this sample has: reviewer_is_reviewed={is_reviewer_reviewed}, user_is_validated={is_user_validated}, inference_confidence={inference_confidence}"
                    )
                else:
                    exclusion_reason = (
                        "ground_truth_source='reviewer_and_user' requires reviewer_is_reviewed=true "
                        "or user_is_validated=true with inference confidence above "
                        f"{inference_confidence_threshold_pct}%. this sample has: reviewer_is_reviewed={is_reviewer_reviewed}, user_is_validated={is_user_validated}, inference_confidence={inference_confidence}"
                    )
                excluded_entries_log.append({
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": exclusion_reason,
                })
                continue

            audio_path = _resolve_audio_path(folder_path, entry, input_root)
            if audio_path is None:
                excluded_entries_log.append({
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": "audio_file_not_found",
                })
                continue
            if os.path.normcase(str(audio_path.resolve())) in excluded_audio_paths:
                excluded_entries_log.append({
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": "listed in 'exclude_entries'",
                })
                continue
            if audio_path.suffix.lower() != ".wav":
                excluded_entries_log.append({
                    "entry": f"{folder_name}/{entry.get('audio_data')}",
                    "exclusion_reason": f"audio_file_is_not_wav: {audio_path.name}",
                })
                continue

            rows.append(
                _build_dataset_row(
                    entry,
                    audio_path,
                    {
                        "ground_truth":   str(transcript),
                        "source_ground_truth": "reviewer" if reviewer_is_eligible else "user",
                        "kto_label":        label,
                        "kto_label_cause":  label_cause,
                    },
                )
            )

    rows = remove_duplicate_dataset_entries(rows)
    print(f"[create_dataset_kto] Dataset contains {len(rows)} entries")
    artifacts = _write_dataset_artifacts(
        rows,
        output_dir,
        "kto",
        json_filename=output_filename,
    )
    exclusion_log_path = output_dir / f"{Path(output_filename).stem}_excluded.jsonl"
    with open(exclusion_log_path, "w", encoding="utf-8") as handle:
        for excluded_entry in excluded_entries_log:
            handle.write(json.dumps(excluded_entry, ensure_ascii=False) + "\n")
    artifacts["exclusion_log_path"] = str(exclusion_log_path)
    return artifacts


def create_dataset_ipo(
    folders: Optional[Iterable[str]],
    dir_input: Optional[str],
    dir_output: Optional[str],
    transcribe_endpoint: str,
    exclude_entries: Optional[Iterable[Dict[str, Any]] | str | Path] = None,
    output_filename: str = "dataset-ipo.json",
    transcribe_timeout: int = 120,
    max_entries: Optional[int] = None,
) -> Dict[str, str]:
    """Create an IPO dataset from reviewer-corrected entries the current model still fails.

    Eligible entries must have ``reviewer_is_reviewed=true``. ``reviewer_transcript_corrected``
    may be empty. For each of those entries, a transcript is generated by posting the audio WAV to
    ``transcribe_endpoint`` (a model-server address, for example
    ``http://127.0.0.1:8000`` or ``http://127.0.0.1:8000/transcribe``). The entry
    is kept only when that generated transcript differs from the normalized
    ``reviewer_transcript_corrected``. Both transcripts are normalized through
    ``my_normalizer`` before comparison.

    ``exclude_entries`` accepts full metadata entries, a JSON file written by
    :func:`create_dataset_eval`, or a serialized result containing
    ``selected_entries``.

    ``max_entries`` limits the number of entries to process for testing purposes.
    If None, all eligible entries are processed.
    """
    if not dir_input:
        raise ValueError("dir_input is required")
    if not dir_output:
        raise ValueError("dir_output is required")
    if not transcribe_endpoint or not str(transcribe_endpoint).strip():
        raise ValueError("transcribe_endpoint is required")
    if Path(output_filename).name != output_filename or Path(output_filename).suffix.lower() != ".json":
        raise ValueError("output_filename must be a JSON filename without a directory path")

    output_dir = Path(dir_output)
    output_dir.mkdir(parents=True, exist_ok=True)
    input_root = Path(dir_input)
    rows: List[Dict[str, Any]] = []
    excluded_entries_log: List[Dict[str, Any]] = []
    excluded_entries            = _load_excluded_entries(exclude_entries)
    excluded_entry_signatures   = _load_excluded_entry_signatures(excluded_entries)
    excluded_audio_paths        = _load_excluded_audio_paths(excluded_entries, input_root)

    folder_names = folders
    if folder_names is None:
        folder_names = (
            path.name for path in input_root.iterdir() if path.is_dir()
        ) if input_root.is_dir() else []

    print(
        "[create_dataset_ipo] Using reviewer-corrected transcripts as winners "
        "and remote model-server transcripts as losers"
    )

    candidates: List[Dict[str, Any]] = []
    for folder_name in sorted({folder for folder in folder_names if folder}):
        folder_path = input_root / folder_name
        if not folder_path.exists():
            continue

        for entry in _load_metadata_entries(folder_path):
            entry_ref = f"{folder_name}/{entry.get('audio_data')}"

            if _entry_is_excluded(entry, folder_name, excluded_entry_signatures):
                excluded_entries_log.append({
                    "entry": entry_ref,
                    "exclusion_reason": "listed in 'exclude_entries'",
                })
                continue

            if entry.get("reviewer_is_reviewed") is not True:
                excluded_entries_log.append({
                    "entry": entry_ref,
                    "exclusion_reason": (
                        "create_dataset_ipo requires reviewer_is_reviewed=true. "
                        f"this sample has: reviewer_is_reviewed={entry.get('reviewer_is_reviewed')}"
                    ),
                })
                continue

            chosen_transcript = str(entry.get("reviewer_transcript_corrected") or "").strip()

            audio_path = _resolve_audio_path(folder_path, entry, input_root)
            if (
                audio_path is not None
                and os.path.normcase(str(audio_path.resolve())) in excluded_audio_paths
            ):
                excluded_entries_log.append({
                    "entry": entry_ref,
                    "exclusion_reason": "listed in 'exclude_entries'",
                })
                continue
            if audio_path is None:
                excluded_entries_log.append({
                    "entry": entry_ref,
                    "exclusion_reason": "audio_file_not_found",
                })
                continue
            if audio_path.suffix.lower() != ".wav":
                excluded_entries_log.append({
                    "entry": entry_ref,
                    "exclusion_reason": f"audio_file_is_not_wav: {audio_path.name}",
                })
                continue

            candidates.append({
                "entry":                entry,
                "entry_ref":            entry_ref,
                "audio_path":           audio_path,
                "chosen_transcript":    chosen_transcript,
            })

    total_candidates = len(candidates)
    candidates_to_process = len(candidates)
    if max_entries is not None and max_entries > 0:
        candidates = candidates[:max_entries]
        candidates_to_process = len(candidates)
        print(f"[create_dataset_ipo] Limited to processing {candidates_to_process} of {total_candidates} candidates (max_entries={max_entries})")
    print(f"[create_dataset_ipo] Transcribing {candidates_to_process} reviewer-reviewed entries")

    for index, candidate in enumerate(candidates, start=1):
        entry_ref           = candidate["entry_ref"]
        audio_path          = candidate["audio_path"]
        chosen_transcript   = candidate["chosen_transcript"]
        print(
            f"[create_dataset_ipo] [{index}/{candidates_to_process}] Processing {entry_ref}"
        )

        generated = _transcribe_audio_via_endpoint(
            audio_path      = audio_path,
            endpoint_url    = str(transcribe_endpoint),
            timeout         = transcribe_timeout,                           # timeout for the transcribe request
        )
        rejected_transcript = str(generated.get("transcript") or "").strip()
        
        # Normalize both transcripts before comparison
        normalized_chosen   = my_normalizer(chosen_transcript)      if chosen_transcript    else ""
        normalized_rejected = my_normalizer(rejected_transcript)    if rejected_transcript  else ""
        
        # Handle cases where normalization returns None
        if normalized_chosen    is None:
            normalized_chosen   = ""
        if normalized_rejected  is None:
            normalized_rejected = ""
        
        if normalized_rejected == normalized_chosen:
            print(
                f"[create_dataset_ipo] [{index}/{candidates_to_process}] "
                f"Skipped {entry_ref}: generated transcript matches reviewer_transcript_corrected"
            )
            excluded_entries_log.append({
                "entry": entry_ref,
                "exclusion_reason": (
                    "generated transcript matches reviewer_transcript_corrected"
                ),
                "generated_transcript": rejected_transcript,
            })
            continue

        print(
            f"[create_dataset_ipo] [{index}/{candidates_to_process}] "
            f"Included {entry_ref}: generated transcript does not match reviewer_transcript_corrected: winner (by reviewer)={chosen_transcript!r} loser (by model)={rejected_transcript!r}"
        )
        extra_fields = {
            "ipo_transcript_winner":    normalized_chosen,
            "ipo_transcript_loser":     normalized_rejected,
            "ipo_source_transcript_winner": "reviewer",
        }
        loser_confidence = generated.get("whisper_confidence")
        
        #confidence_gap = _compute_ipo_confidence_gap(candidate["entry"].get("inference_confidence"), loser_confidence)
        confidence_gap = _compute_ipo_confidence_gap(100, loser_confidence) # 100 because we are 100% sure about the reviewer's transcript

        if confidence_gap is not None:
            extra_fields["ipo_confidence_gap"] = confidence_gap
        rows.append(
            _build_dataset_row(
                candidate["entry"],
                audio_path,
                extra_fields,
            )
        )

    rows = remove_duplicate_dataset_entries(rows)
    print(f"[create_dataset_ipo] Dataset contains {len(rows)} entries")
    artifacts = _write_dataset_artifacts(
        rows,
        output_dir,
        "ipo",
        json_filename=output_filename,
    )
    exclusion_log_path = output_dir / f"{Path(output_filename).stem}_excluded.jsonl"
    with open(exclusion_log_path, "w", encoding="utf-8") as handle:
        for excluded_entry in excluded_entries_log:
            handle.write(json.dumps(excluded_entry, ensure_ascii=False) + "\n")
    artifacts["exclusion_log_path"] = str(exclusion_log_path)
    return artifacts


def list_bucket_folders(bucket: str) -> list[str]:
    """Return immediate folder names in a bucket."""
    credentials = _build_google_service_account_credentials()
    if google_storage is not None and credentials is not None:
        client = google_storage.Client(
            project=credentials.project_id,
            credentials=credentials,
        )
        prefixes = client.list_blobs(bucket, delimiter="/")
        list(prefixes)
        return sorted(prefix.rstrip("/").split("/")[-1] for prefix in prefixes.prefixes)

    gcloud_path = shutil.which("gcloud")
    gsutil_path = shutil.which("gsutil")
    if gcloud_path is not None:
        result = subprocess.run(
            [gcloud_path, "storage", "ls", f"gs://{bucket}/", "--delimiter=/"],
            check=False,
            capture_output=True,
            text=True,
        )
    elif gsutil_path is not None:
        result = subprocess.run(
            [gsutil_path, "ls", "-d", f"gs://{bucket}/*/"],
            check=False,
            capture_output=True,
            text=True,
        )
    else:
        if google_storage is None or credentials is None:
            raise EnvironmentError(
                "Neither `gcloud` nor `gsutil` was found on PATH, and no usable "
                "Firebase service-account credentials are available. Install the "
                "Google Cloud SDK or set FIREBASE_ADMIN_* env vars."
            )
        client = google_storage.Client(
            project=credentials.project_id,
            credentials=credentials,
        )
        prefixes = client.list_blobs(bucket, delimiter="/")
        list(prefixes)
        return sorted(prefix.rstrip("/").split("/")[-1] for prefix in prefixes.prefixes)

    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "unknown error"
        raise RuntimeError(f"Unable to list gs://{bucket}/: {message}")

    bucket_prefix = f"gs://{bucket}/"
    folders = set()
    for line in result.stdout.splitlines():
        prefix = line.strip()
        if prefix.startswith(bucket_prefix) and prefix.endswith("/"):
            folder = prefix[len(bucket_prefix) : -1]
            if folder and "/" not in folder:
                folders.add(folder)

    return sorted(folders)


def _normalize_folder_date(raw_value: str) -> int:
    value = raw_value.strip()
    if not re.fullmatch(r"\d{6}|\d{8}", value):
        raise ValueError("date must be in YYYYMM or YYYYMMDD format")
    if len(value) == 6:
        value += "01"
    return int(value)


def _folder_date_from_name(folder_name: str) -> Optional[int]:
    cleaned = folder_name.strip("/")
    match = re.match(r"^(\d{6}|\d{8})(?:[_-].*)?$", cleaned)
    if match is None:
        return None

    value = match.group(1)
    if len(value) == 6:
        value += "01"
    return int(value)


def list_dgx_bucket_folders_by_date(
    bucket: str,
    cutoff_date: str,
    direction: str = "after",
    include_cutoff: bool = False,
) -> list[str]:
    """Return `_dgx` folders in a Firebase/GCS bucket relative to ``cutoff_date``.

    Folder names are expected to look like ``20260901_dgx``. ``cutoff_date`` may
    be ``YYYYMM`` or ``YYYYMMDD``.

    Parameters
    ----------
    direction:
        ``"after"`` keeps folders later than the cutoff; ``"before"`` keeps
        folders earlier than the cutoff.
    include_cutoff:
        If True, also keep folders whose embedded date equals ``cutoff_date``.
    """
    if direction not in {"before", "after"}:
        raise ValueError("direction must be 'before' or 'after'")

    normalized_cutoff = _normalize_folder_date(cutoff_date)
    matching_folders = []

    for folder_name in list_bucket_folders(bucket):
        if not folder_name.endswith("_dgx"):
            continue
        folder_date = _folder_date_from_name(folder_name)
        if folder_date is None:
            continue

        if      direction == "after":
            keep = folder_date >= normalized_cutoff if include_cutoff else folder_date > normalized_cutoff
        elif    direction == "before":
            keep = folder_date <= normalized_cutoff if include_cutoff else folder_date < normalized_cutoff

        if keep:
            matching_folders.append(folder_name)

    return matching_folders


def _list_processed_bucket_folders(
    bucket: str,
    storage_tool: str,
    storage_env: dict[str, str],
) -> list[str]:
    """Return folder names marked as processed in the bucket-root folders.json."""
    if storage_tool == "python-storage":
        credentials = _build_google_service_account_credentials()
        if google_storage is None or credentials is None:
            raise EnvironmentError("Unable to read folders.json with the Python storage client.")

        client = google_storage.Client(project=credentials.project_id, credentials=credentials)
        payload = client.bucket(bucket).blob("folders.json").download_as_bytes()
    else:
        command = (
            ["gcloud", "storage", "cat", f"gs://{bucket}/folders.json"]
            if storage_tool == "gcloud"
            else ["gsutil", "cat", f"gs://{bucket}/folders.json"]
        )
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            env=storage_env,
        )
        if result.returncode != 0:
            message = result.stderr.strip() or result.stdout.strip() or "unknown error"
            raise RuntimeError(f"Unable to read gs://{bucket}/folders.json: {message}")
        payload = result.stdout

    try:
        records = json.loads(payload)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid JSON in gs://{bucket}/folders.json") from exc

    if not isinstance(records, list):
        raise ValueError(f"Expected a list of folder records in gs://{bucket}/folders.json")

    return sorted(
        {
            str(record["folder_name"])
            for record in records
            if isinstance(record, dict)
            and record.get("folder_name")
            and record.get("is_processed") is True
        }
    )


def download_firebase_folders(
    folders: Optional[Iterable[str]],
    dir_firebase_bucket: Optional[str],
    dir_output: Optional[str],
    only_download_json: bool        = False,
    force_download_data_json: bool  = False,
    force_download_wav: bool        = False,
    only_processed: bool            = False,
    download_txt: bool              = False,
):
    """Download validation folders from a Firebase/GCS bucket.

    Parameters
    ----------
    folders:
        Iterable of folder names to download.
    dir_firebase_bucket:
        Bucket name without the `gs://` prefix.
    dir_output:
        Local destination directory for the downloaded data.
    only_download_json:
        If True, skip downloading WAV files.
    force_download_data_json:
        If True, download ``data.json`` even when it already exists locally.
    only_processed:
        If True, only download folders whose root ``folders.json`` record has
        ``is_processed`` set to True. When ``folders`` is provided, it limits
        the requested subset to processed folders.
    download_txt:
        If True, also download ``.txt`` files in addition to JSON and WAV.
    force_download_wav:
        If True, re-download ``.wav`` files even when they already exist locally.
    """
    if not dir_firebase_bucket:
        raise ValueError("dir_firebase_bucket is required")
    if not dir_output:
        raise ValueError("dir_output is required")

    print(f"I will download data from the firebase bucket: {dir_firebase_bucket}")
    if only_download_json:
        print("I will only download .json files")
    elif download_txt:
        print("I will download .json, .wav and .txt files")
    if force_download_data_json:
        print("I will force download data.json when it already exists locally")
    if force_download_wav:
        print("I will force re-download .wav files even when they already exist locally")

    os.makedirs(dir_output, exist_ok=True)

    storage_env = os.environ.copy()
    _ensure_google_application_credentials_from_env(storage_env)

    gcloud_path = shutil.which("gcloud")
    gsutil_path = shutil.which("gsutil")
    python_storage_available = _build_google_service_account_credentials() is not None

    if python_storage_available:
        storage_tool = "python-storage"
    elif gcloud_path is not None:
        storage_tool = "gcloud"
    elif gsutil_path is not None:
        storage_tool = "gsutil"
    else:
        raise EnvironmentError(
            "Neither `gcloud` nor `gsutil` was found on PATH, and no Firebase service account credentials are available in env. "
            "Install the Google Cloud SDK or set FIREBASE_ADMIN_* env vars."
        )

    print(f"Using storage tool: {storage_tool}")

    processed_folders = None
    if only_processed:
        processed_folders = set(
            _list_processed_bucket_folders(
                dir_firebase_bucket,
                storage_tool,
                storage_env,
            )
        )
        print(f"Found {len(processed_folders)} processed folders in folders.json")

    if folders is None:
        folders_to_download = (
            sorted(processed_folders)
            if processed_folders is not None
            else list_bucket_folders(dir_firebase_bucket)
        )
        if processed_folders is None:
            print("No folder list provided; using all top-level folders in the bucket.")
        else:
            print("No folder list provided; using only folders marked is_processed=true.")
    else:
        folders_to_download = sorted({folder for folder in folders if folder})
        if processed_folders is not None:
            folders_to_download = [
                folder for folder in folders_to_download if folder in processed_folders
            ]

    print(f"Found {len(folders_to_download)} unique folders to download.")
    print(f"Source Bucket:  {dir_firebase_bucket}")
    print(f"Destination:    {dir_output}\n")

    def run_storage_cmd(cmd: str):
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=storage_env)
            return result.stdout.strip(), result.stderr.strip(), result.returncode
        except Exception as exc:  # pragma: no cover - defensive fallback
            return "", str(exc), 1

    def raise_storage_permission_error(stderr: str, cmd: str):
        if not stderr:
            return
        low = stderr.lower()
        if "anonymous caller" in low or "storage.objects.list" in low or "access denied" in low:
            raise EnvironmentError(
                f"Google Cloud Storage access failed while running: {cmd}\n"
                "This looks like an authentication or permission issue. "
                "Authenticate with `gcloud auth login` or `gcloud auth application-default login`, "
                "and ensure the active account has storage permissions on the bucket."
            )

    def get_remote_file_size(gs_path: str):
        """Get file size in bytes from a gs:// path."""
        if storage_tool == "gcloud":
            cmd = f"gcloud storage stat {gs_path} --format='value(size)'"
            stdout, stderr, returncode = run_storage_cmd(cmd)
            raise_storage_permission_error(stderr, cmd)
            if returncode == 0 and stdout:
                try:
                    return int(stdout)
                except ValueError:
                    return None
            return None

        cmd = f"gsutil ls -L {gs_path}"
        stdout, stderr, returncode = run_storage_cmd(cmd)
        raise_storage_permission_error(stderr, cmd)
        if returncode != 0 or not stdout:
            return None

        for line in stdout.splitlines():
            if line.strip().startswith("Content-Length:"):
                try:
                    return int(line.split(":", 1)[1].strip())
                except ValueError:
                    return None
        return None

    for folder in folders_to_download:
        print(f"-> Processing '{folder}'...")

        destination_folder = os.path.join(dir_output, folder)
        os.makedirs(destination_folder, exist_ok=True)

        if storage_tool == "python-storage":
            _download_folder_with_storage_client(
                bucket_name=dir_firebase_bucket,
                folder=folder,
                destination_folder=destination_folder,
                only_download_json=only_download_json,
                force_download_data_json=force_download_data_json,
                download_txt=download_txt,
                force_download_wav=force_download_wav,
            )
            continue

        print("   Downloading .json files...")
        if storage_tool == "gcloud":
            cmd_ls_json = f"gcloud storage ls gs://{dir_firebase_bucket}/{folder}/*.json"
        else:
            cmd_ls_json = f"gsutil ls gs://{dir_firebase_bucket}/{folder}/*.json"
        stdout, stderr, returncode = run_storage_cmd(cmd_ls_json)
        raise_storage_permission_error(stderr, cmd_ls_json)

        if returncode == 0 and stdout:
            remote_json_files = []
            for line in stdout.split("\n"):
                if line.strip():
                    filename = line.strip().split("/")[-1]
                    if filename.endswith(".json"):
                        remote_json_files.append(filename)

            json_files_to_download = []
            for json_file in remote_json_files:
                local_path = os.path.join(destination_folder, json_file)
                is_data_json = json_file == "data.json" or json_file.endswith("_data.json")
                if not os.path.exists(local_path) or (force_download_data_json and is_data_json):
                    json_files_to_download.append(json_file)
                else:
                    print(f"   Skipping {json_file} (already exists locally)")

            if json_files_to_download:
                print(f"   Found {len(json_files_to_download)} .json files to download out of {len(remote_json_files)}")
                for json_file in json_files_to_download:
                    if storage_tool == "gcloud":
                        cmd_json = f"gcloud storage cp gs://{dir_firebase_bucket}/{folder}/{json_file} {destination_folder}/"
                    else:
                        cmd_json = f"gsutil cp gs://{dir_firebase_bucket}/{folder}/{json_file} {destination_folder}/"
                    stdout, stderr, returncode = run_storage_cmd(cmd_json)
                    raise_storage_permission_error(stderr, cmd_json)
                    if returncode != 0 and stderr:
                        print(f"     ⚠ Error: {stderr}")
            else:
                print(f"   All {len(remote_json_files)} .json files already present locally -> not downloading again")
        elif returncode != 0:
            print(f"   Warning: Could not list remote .json files (command failed with: {stderr or 'unknown error'})")

        if not only_download_json:
            print("   Checking .wav files...")
            if storage_tool == "gcloud":
                cmd_ls = f"gcloud storage ls gs://{dir_firebase_bucket}/{folder}/*.wav"
            else:
                cmd_ls = f"gsutil ls gs://{dir_firebase_bucket}/{folder}/*.wav"
            stdout, stderr, returncode = run_storage_cmd(cmd_ls)
            raise_storage_permission_error(stderr, cmd_ls)

            if returncode == 0 and stdout:
                remote_wav_files = []
                for line in stdout.split("\n"):
                    if line.strip():
                        filename = line.strip().split("/")[-1]
                        if filename.endswith(".wav"):
                            remote_wav_files.append(filename)

                files_to_download = []
                for wav_file in remote_wav_files:
                    local_path = os.path.join(destination_folder, wav_file)
                    if not os.path.exists(local_path):
                        files_to_download.append((wav_file, "is missing locally"))
                    elif force_download_wav:
                        files_to_download.append((wav_file, "force re-download requested"))
                    else:
                        print(f"   Skipping {wav_file} (already exists locally)")

                if files_to_download:
                    print(f"   Found {len(files_to_download)} .wav files to download out of {len(remote_wav_files)}")
                    for wav_file, reason in files_to_download:
                        print(f"   - Downloading {wav_file} ({reason})...")
                        if storage_tool == "gcloud":
                            cmd_wav = f"gcloud storage cp gs://{dir_firebase_bucket}/{folder}/{wav_file} {destination_folder}/"
                        else:
                            cmd_wav = f"gsutil cp gs://{dir_firebase_bucket}/{folder}/{wav_file} {destination_folder}/"
                        stdout, stderr, returncode = run_storage_cmd(cmd_wav)
                        raise_storage_permission_error(stderr, cmd_wav)
                        if returncode != 0 and stderr:
                            print(f"     ⚠ Error: {stderr}")
                else:
                    print(f"   All {len(remote_wav_files)} .wav files already present locally -> not downloading again")
            else:
                print("   Warning: Could not list remote .wav files (command failed with: unknown error)")

        if download_txt and not only_download_json:
            print("   Checking .txt files...")
            if storage_tool == "gcloud":
                cmd_ls_txt = f"gcloud storage ls gs://{dir_firebase_bucket}/{folder}/*.txt"
            else:
                cmd_ls_txt = f"gsutil ls gs://{dir_firebase_bucket}/{folder}/*.txt"
            stdout, stderr, returncode = run_storage_cmd(cmd_ls_txt)
            raise_storage_permission_error(stderr, cmd_ls_txt)

            if returncode == 0 and stdout:
                remote_txt_files = []
                for line in stdout.split("\n"):
                    if line.strip():
                        filename = line.strip().split("/")[-1]
                        if filename.endswith(".txt"):
                            remote_txt_files.append(filename)

                files_to_download = []
                for txt_file in remote_txt_files:
                    local_path = os.path.join(destination_folder, txt_file)
                    if not os.path.exists(local_path):
                        files_to_download.append((txt_file, "is missing locally"))
                    else:
                        print(f"   Skipping {txt_file} (already exists locally)")

                if files_to_download:
                    print(f"   Found {len(files_to_download)} .txt files to download out of {len(remote_txt_files)}")
                    for txt_file, reason in files_to_download:
                        print(f"   - Downloading {txt_file} ({reason})...")
                        if storage_tool == "gcloud":
                            cmd_txt = f"gcloud storage cp gs://{dir_firebase_bucket}/{folder}/{txt_file} {destination_folder}/"
                        else:
                            cmd_txt = f"gsutil cp gs://{dir_firebase_bucket}/{folder}/{txt_file} {destination_folder}/"
                        stdout, stderr, returncode = run_storage_cmd(cmd_txt)
                        raise_storage_permission_error(stderr, cmd_txt)
                        if returncode != 0 and stderr:
                            print(f"     ⚠ Error: {stderr}")
                else:
                    print(f"   All {len(remote_txt_files)} .txt files already present locally -> not downloading again")
            else:
                print("   Warning: Could not list remote .txt files (command failed with: unknown error)")

    print("\n✓ All downloads completed.")
    return folders_to_download


def set_substitutions_log_path(path: Optional[str]):
    """Set the path to a JSONL substitutions log file.

    Pass `None` to disable logging.
    """
    global substitutions_log_path
    substitutions_log_path = path


# @todo: show befor / after only if there are differences
def my_normalizer(
            input_text: str,
            audio_filename: Optional[str]           = None,
            substitutions_log_path: Optional[str]   = None,
            verbose: bool                           = False
        ) -> Optional[str]:
    """Normalize an Italian transcript string and optionally log substitutions.

    Returns the normalized string or `None` if input is invalid.
    """
    #if verbose:
    #    print(f"[my_normalizer] Text before normalization: '{input_text}'")

    original_text = input_text

    # strip whitespaces
    # do not strip here, because we want to preserve leading/trailing spaces
    #input_text = str(input_text).strip()

    # Lowercase
    input_text = input_text.lower()

    # Vowels with accents written as e.g. a' -> à
    input_text = input_text.replace("a'", "à").replace("A'", "À")
    input_text = input_text.replace("e'", "è").replace("E'", "È")
    input_text = input_text.replace("i'", "ì").replace("I'", "Ì")
    input_text = input_text.replace("o'", "ò").replace("O'", "Ò") # this wrongly substitutes "po'" (which is the abbreviated form of "poco") with "pò"
    input_text = input_text.replace("u'", "ù").replace("U'", "Ù")
    
    # Punctuation -> spaces
    for ch in [", ", ". ", "? ", "! "]: input_text = input_text.replace(ch, " ")
    for ch in [",", ".", "?", "!"]:     input_text = input_text.replace(ch, "")

    # Words with accents
    input_text = input_text.replace(" lunedi ",     " lunedì ").replace(    " Lunedi ",     " Lunedì ")
    input_text = input_text.replace(" martedi ",    " martedì ").replace(   " Martedi ",    " Martedì ")
    input_text = input_text.replace(" mercoledi ",  " mercoledì ").replace( " Mercoledi ",  " Mercoledì ")
    input_text = input_text.replace(" giovedi ",    " giovedì ").replace(   " Giovedi ",    " Giovedì ")
    input_text = input_text.replace(" venerdi ",    " venerdì ").replace(   " Venerdi ",    " Venerdì ")

    input_text = input_text.replace(" papa ",       " papà ").replace(      " Papa ",       " Papà ") # potential false positive: "papa" could also mean "pope" in Italian
    input_text = input_text.replace(" citta ",      " città ").replace(     " Citta ",      " Città ")
    input_text = input_text.replace(" universita ", " università ").replace(" Universita ", " Università ")
    input_text = input_text.replace(" felicita ",   " felicità ").replace(  " Felicita ",   " Felicità ")
    input_text = input_text.replace(" verita ",     " verità ").replace(    " Verita ",     " Verità ")
    input_text = input_text.replace(" liberta ",    " libertà ").replace(   " Liberta ",    " Libertà ")
    input_text = input_text.replace(" societa ",    " società ").replace(   " Societa ",    " Società ")

    input_text = input_text.replace(" perche ",     " perché ").replace(    " Perche ",     " Perché ")
    input_text = input_text.replace(" perchè ",     " perché ").replace(    " Perchè ",     " Perché ")
    input_text = input_text.replace(" poiche ",     " poiché ").replace(    " Poiche ",     " Poiché ")
    input_text = input_text.replace(" affinche ",   " affinché ").replace(  " Affinche ",   " Affinché ")
    input_text = input_text.replace(" finche ",     " finché ").replace(    " Finche ",     " Finché ")

    input_text = input_text.replace(" giu ",    " giù ").replace(   " Giu ",    " Giù ")
    input_text = input_text.replace(" piu ",    " più ").replace(   " Piu ",    " Più ")
    input_text = input_text.replace(" gia ",    " già ").replace(   " Gia ",    " Già ")
    input_text = input_text.replace(" pò ",     " po ").replace(    " Pò ",     " Po ") # whisper does not generate po' (which is the correct form in Italian), so we replace it with "po" for consistency
    input_text = input_text.replace(" sì ",     " si ").replace(    " Sì ",     " Si ")

    input_text = input_text.replace(" andro ", " andrò ").replace(" Andro ", " Andrò ")
    input_text = input_text.replace(" faro ", " farò ").replace(" Faro ", " Farò ") # potential false positive: "faro" could also mean "lighthouse" in Italian
    input_text = input_text.replace(" diro ", " dirò ").replace(" Diro ", " Dirò ")
    input_text = input_text.replace(" saro ", " sarò ").replace(" Saro ", " Sarò ")
    
    '''
    input_text = input_text.replace(" uno ",        " 1 ")
    input_text = input_text.replace(" due ",        " 2 ")
    input_text = input_text.replace(" tre ",        " 3 ")
    input_text = input_text.replace(" quattro ",    " 4 ")
    input_text = input_text.replace(" cinque ",     " 5 ")
    input_text = input_text.replace(" sei ",        " 6 ")
    input_text = input_text.replace(" sette ",      " 7 ")
    input_text = input_text.replace(" otto ",       " 8 ")
    input_text = input_text.replace(" nove ",       " 9 ")
    input_text = input_text.replace(" dieci ",      " 10 ")
    '''

    # if empty
    if not input_text:
        #if verbose: print(f"[my_normalizer] not a string or empty transcript: '{input_text}'")
        return input_text

    # Use the Whisper BasicTextNormalizer for final normalization
    if normalizer is not None:  input_text = normalizer(input_text)
    if not input_text:
        if verbose:
            print(f"[my_normalizer] not correct string: '{input_text}'")
        return None

    # Optional spellcheck (disabled by default)
    # misspelled = spell.unknown(input_text.split())
    # if verbose and misspelled:
    #     print(f"[my_normalizer] misspelled word: {misspelled}\n")

    # Log substitutions if requested
    if substitutions_log_path and input_text != original_text:
        import json as _json
        try:
            with open(substitutions_log_path, 'a', encoding='utf-8') as f:
                f.write(_json.dumps({
                    'audio_filename':           audio_filename,
                    'original_transcript':      original_text,
                    'normalized_transcript':    input_text
                }, ensure_ascii=False) + '\n')
        except Exception:
            # Do not fail normalization if logging fails
            if verbose:
                print(f"[my_normalizer] Warning: failed to write substitutions log to {substitutions_log_path}")

    '''
    if verbose:
        if original_text != input_text:
            print(f"[my_normalizer] before normalization: '{original_text}'")
            print(f"[my_normalizer] after normalization:  '{input_text}'")
    '''

    return input_text

    
__all__ = [
    "my_normalizer",
    "set_substitutions_log_path",
    "download_firebase_folders",
    "list_dgx_bucket_folders_by_date",
    "normalizer",
    "spell",
    "create_dataset_sft",
    "create_dataset_eval",
    "create_dataset_kto",
    "create_dataset_ipo",
    "create_ipo_dataset",
    "remove_duplicate_dataset_entries",
    "compare_dataset_overlaps",
]