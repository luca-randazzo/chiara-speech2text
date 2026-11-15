#!/usr/bin/env python3
"""Run NeMo Speech Data Explorer metrics without starting the Dash UI."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any


def _serialize_vocabulary(vocabulary: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in vocabulary:
        row = {"word": item.get("word", ""), "count": int(item.get("count", 0))}
        if "accuracy" in item:
            row["accuracy"] = float(item["accuracy"])
        rows.append(row)
    return rows


def _load_data_explorer_module(script_path: str):
    spec = importlib.util.spec_from_file_location("nemo_sde_data_explorer", script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load Speech Data Explorer from {script_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description="Speech Data Explorer metrics runner")
    parser.add_argument("manifest", help="path to JSONL manifest file")
    parser.add_argument("--disable-caching-metrics", action="store_true")
    parser.add_argument("--audio-base-path", default=None)
    parser.add_argument(
        "--script",
        default=os.environ.get(
            "SPEECH_DATA_EXPLORER_SCRIPT",
            "/path/to/nvidia-nemo/tools/speech_data_explorer/data_explorer.py",
        ),
        help="path to data_explorer.py",
    )
    args = parser.parse_args()

    original_argv = sys.argv[:]
    sys.argv = ["data_explorer", args.manifest, "--disable-caching-metrics"]
    if args.audio_base_path:
        sys.argv.extend(["--audio-base-path", args.audio_base_path])

    try:
        module = _load_data_explorer_module(args.script)
    finally:
        sys.argv = original_argv

    metrics_available = bool(getattr(module, "metrics_available", False))
    payload = {
        "metrics_available": metrics_available,
        "wer": round(float(module.wer), 2) if metrics_available else None,
        "cer": round(float(module.cer), 2) if metrics_available else None,
        "wmr": round(float(module.wmr), 2) if metrics_available else None,
        "mwa": round(float(module.mwa), 2) if metrics_available else None,
        "num_hours": round(float(module.num_hours), 4),
        "vocabulary": _serialize_vocabulary(getattr(module, "vocabulary", [])),
    }
    json.dump(payload, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
