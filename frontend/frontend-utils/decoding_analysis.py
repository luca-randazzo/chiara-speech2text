"""Decoding performance analysis using NVIDIA NeMo Speech Data Explorer.

Converts folder ``data.json`` entries into a JSONL manifest and computes
WER/CER/WMR/MWA plus per-word accuracy via ``data_explorer.load_data``.
"""

from __future__ import annotations

import difflib
import json
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

import editdistance
import jiwer

DEFAULT_SPEECH_DATA_EXPLORER = (
    "/path/to/nvidia-nemo/tools/speech_data_explorer/data_explorer.py"
)


def _reviewer_transcript(entry: dict[str, Any]) -> str:
    return str(
        entry.get("reviewer_transcript_corrected")
        or entry.get("reviewer_corrected_transcript")
        or entry.get("reviewer_trasncript_corrected")
        or ""
    ).strip()


def _inference_model(entry: dict[str, Any]) -> str:
    return str(
        entry.get("inference_model_version")
        or entry.get("inference_model")
        or ""
    ).strip()


def _entry_audio_filepath(entry: dict[str, Any]) -> str:
    for key in ("audio_filepath", "audio_data", "audio_file", "audio_path"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def entry_to_manifest_record(entry: dict[str, Any]) -> dict[str, Any] | None:
    """Map a data.json entry to a Speech Data Explorer manifest line."""
    text = _reviewer_transcript(entry)
    if not text:
        return None

    audio_filepath = _entry_audio_filepath(entry)
    if not audio_filepath:
        return None

    duration = entry.get("audio_duration")
    try:
        duration_value = float(duration) if duration is not None else 0.0
    except (TypeError, ValueError):
        duration_value = 0.0

    return {
        "audio_filepath": audio_filepath,
        "duration": duration_value,
        "text": text,
        "pred_text": str(entry.get("inference_transcript") or "").strip(),
    }


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def collect_unique_inference_words(entries: list[Any]) -> list[dict[str, Any]]:
    """Return sorted unique words with counts and validated-transcript membership."""
    counts: dict[str, int] = defaultdict(int)
    in_validated: set[str] = set()
    in_unvalidated: set[str] = set()
    in_reviewer_reviewed: set[str] = set()
    in_unreviewed: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        text = str(entry.get("inference_transcript") or "").strip()
        if not text:
            continue
        validated = _coerce_bool(entry.get("user_is_validated", False))
        reviewer_reviewed = _coerce_bool(entry.get("reviewer_is_reviewed", False))
        for word in text.split():
            if not word:
                continue
            counts[word] += 1
            if validated:
                in_validated.add(word)
            else:
                in_unvalidated.add(word)
            if reviewer_reviewed:
                in_reviewer_reviewed.add(word)
            else:
                in_unreviewed.add(word)
    return [
        {
            "word": word,
            "count": counts[word],
            "user_is_validated": word in in_validated and word not in in_unvalidated,
            "reviewer_is_reviewed": word in in_reviewer_reviewed and word not in in_unreviewed,
        }
        for word in sorted(counts, key=str.lower)
    ]


def filter_entries_for_model(
    entries: list[Any],
    model_version: str,
) -> list[dict[str, Any]]:
    version = str(model_version or "").strip()
    if not version:
        return []

    matched: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if _inference_model(entry) != version:
            continue
        record = entry_to_manifest_record(entry)
        if record is not None:
            matched.append(record)
    return matched


def write_jsonl_manifest(records: list[dict[str, Any]], path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _compute_metrics_local(
    manifest_path: str,
    audio_base_path: str | None = None,
) -> dict[str, Any]:
    """Compute metrics using the same algorithm as ``data_explorer.load_data``."""
    del audio_base_path  # not needed when audio metrics are disabled

    data: list[dict[str, Any]] = []
    wer_dist = 0.0
    wer_count = 0
    cer_dist = 0.0
    cer_count = 0
    wmr_count = 0
    num_hours = 0.0
    vocabulary: dict[str, int] = defaultdict(int)
    match_vocab: dict[str, int] = defaultdict(int)
    sm = difflib.SequenceMatcher()
    metrics_available = False

    with open(manifest_path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            text = item.get("text")
            if not isinstance(text, str):
                text = ""
            num_chars = len(text)
            orig = text.split()
            num_words = len(orig)
            for word in orig:
                vocabulary[word] += 1
            num_hours += float(item.get("duration") or 0.0)

            row: dict[str, Any] = {
                "audio_filepath": item.get("audio_filepath", ""),
                "duration": round(float(item.get("duration") or 0.0), 2),
                "num_words": num_words,
                "num_chars": num_chars,
                "text": text,
            }

            if "pred_text" in item:
                metrics_available = True
                pred = str(item.get("pred_text") or "").split()
                measures = jiwer.process_words(text, str(item.get("pred_text") or ""))
                word_dist = (
                    measures.substitutions
                    + measures.insertions
                    + measures.deletions
                )
                char_dist = editdistance.eval(text, str(item.get("pred_text") or ""))
                wer_dist += word_dist
                cer_dist += char_dist
                wer_count += num_words
                cer_count += num_chars

                sm.set_seqs(orig, pred)
                for block in sm.get_matching_blocks():
                    for word_idx in range(block[0], block[0] + block[2]):
                        match_vocab[orig[word_idx]] += 1
                wmr_count += measures.hits

                safe_words = num_words or 1e-9
                safe_chars = num_chars or 1e-9
                row["pred_text"] = str(item.get("pred_text") or "")
                row["WER"] = round(word_dist / safe_words * 100.0, 2)
                row["CER"] = round(char_dist / safe_chars * 100.0, 2)
                row["WMR"] = round(measures.hits / safe_words * 100.0, 2)

            data.append(row)

    vocabulary_data = [{"word": word, "count": vocabulary[word]} for word in vocabulary]

    if not metrics_available or not vocabulary_data:
        return {
            "metrics_available": False,
            "sample_count": len(data),
            "wer": None,
            "cer": None,
            "wmr": None,
            "mwa": None,
            "num_hours": round(num_hours / 3600.0, 4),
            "vocabulary": [],
        }

    acc_sum = 0.0
    for item in vocabulary_data:
        word = item["word"]
        word_accuracy = match_vocab[word] / vocabulary[word] * 100.0
        acc_sum += word_accuracy
        item["accuracy"] = round(word_accuracy, 1)
    mwa = acc_sum / len(vocabulary_data)

    wer = wer_dist / wer_count * 100.0 if wer_count else 0.0
    cer = cer_dist / cer_count * 100.0 if cer_count else 0.0
    wmr = wmr_count / wer_count * 100.0 if wer_count else 0.0

    return {
        "metrics_available": True,
        "sample_count": len(data),
        "wer": round(wer, 2),
        "cer": round(cer, 2),
        "wmr": round(wmr, 2),
        "mwa": round(mwa, 2),
        "num_hours": round(num_hours / 3600.0, 4),
        "vocabulary": vocabulary_data,
    }


def _call_data_explorer_load_data(
    manifest_path: str,
    audio_base_path: str | None = None,
) -> dict[str, Any]:
    """Invoke ``data_explorer.load_data`` in a subprocess (no Dash server)."""
    runner = Path(__file__).with_name("sde_metrics_runner.py")
    if not runner.is_file():
        return _compute_metrics_local(manifest_path, audio_base_path)

    cmd = [
        sys.executable,
        str(runner),
        manifest_path,
        "--disable-caching-metrics",
    ]
    if audio_base_path:
        cmd.extend(["--audio-base-path", audio_base_path])

    completed = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        raise RuntimeError(stderr or "Speech Data Explorer runner failed")

    return json.loads(completed.stdout)


def compute_decoding_metrics(
    records: list[dict[str, Any]],
    *,
    audio_base_path: str | None = None,
    use_data_explorer: bool = True,
) -> dict[str, Any]:
    """Convert manifest records to metrics via Speech Data Explorer."""
    if not records:
        return {
            "metrics_available": False,
            "sample_count": 0,
            "wer": None,
            "cer": None,
            "wmr": None,
            "mwa": None,
            "num_hours": 0.0,
            "vocabulary": [],
            "error": "No entries with \"reviewer_is_reviewed\"=True for this model version in this folder",
        }

    with tempfile.TemporaryDirectory(prefix="sde-manifest-") as tmpdir:
        manifest_path = os.path.join(tmpdir, "manifest.json")
        write_jsonl_manifest(records, manifest_path)

        sde_script = os.environ.get("SPEECH_DATA_EXPLORER_SCRIPT", DEFAULT_SPEECH_DATA_EXPLORER)
        if use_data_explorer and os.path.isfile(sde_script):
            try:
                metrics = _call_data_explorer_load_data(manifest_path, audio_base_path)
            except Exception:
                metrics = _compute_metrics_local(manifest_path, audio_base_path)
        else:
            metrics = _compute_metrics_local(manifest_path, audio_base_path)

    metrics["sample_count"] = len(records)
    return metrics


def analyze_entries_for_model(
    entries: list[Any],
    model_version: str,
    *,
    audio_base_path: str | None = None,
) -> dict[str, Any]:
    """Analyze decoding performance for one inference model version."""
    records = filter_entries_for_model(entries, model_version)
    result = compute_decoding_metrics(records, audio_base_path=audio_base_path)
    result["model_version"] = model_version
    result["reviewed_sample_count"] = len(records)
    return result
