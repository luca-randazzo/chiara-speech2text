import re
from typing import Any, Iterable, Optional


def _normalize_text(text: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (text or "").strip()).lower()


def _fallback_alternative(text: Optional[str]) -> Optional[str]:
    stripped = (text or "").strip()
    if not stripped:
        return None
    if stripped.endswith("!"):
        return stripped[:-1] + "?"
    if stripped.endswith("?"):
        return stripped[:-1] + "!"
    return stripped + "..."


def _is_valid_italian_candidate(text: Optional[str]) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if len(stripped) < 2:
        return False
    # Reject candidates with non-text junk or non-Latin glyphs.
    if re.search(r"[^A-Za-zÀ-ÖØ-öø-ÿ0-9'’.,;:!?%()\-\s]", stripped):
        return False
    return True


def _coerce_candidate(entry: Any) -> tuple[Optional[str], float]:
    if isinstance(entry, dict):
        return (entry.get("text"), float(entry.get("confidence", 0.0) or 0.0))
    if isinstance(entry, (tuple, list)) and len(entry) >= 1:
        text = entry[0]
        confidence = entry[1] if len(entry) > 1 else 0.0
        return (text, float(confidence or 0.0))
    return (entry, 0.0)


def select_loser_transcript(winner: Optional[str], candidates: Iterable[Any]) -> Optional[str]:
    """Return the first candidate that differs from the winner.

    This preserves the original simple behavior: iterate through the already-generated
    candidates in order and take the first transcript that is not identical to the winner.
    If no distinct candidate is available, we return a minimal punctuation-based fallback
    so the caller can still expose a non-empty alternative without silently dropping it.
    """
    winner_norm = _normalize_text(winner)
    if not candidates:
        return None

    for entry in candidates:
        text, _ = _coerce_candidate(entry)
        stripped = (text or "").strip()
        if not stripped:
            continue
        if _normalize_text(stripped) != winner_norm and _is_valid_italian_candidate(stripped):
            return stripped

    return _fallback_alternative(winner)
