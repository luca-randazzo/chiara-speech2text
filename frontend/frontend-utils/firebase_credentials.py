from __future__ import annotations

import os
from typing import Any, Mapping


def _normalize_env_private_key(value: str | None) -> str | None:
    if not value:
        return None

    value = value.strip()
    if value.startswith('"') and value.endswith('"'):
        value = value[1:-1]

    value = value.replace("\\n", "\n")
    return value


def build_firebase_service_account_info(env_vars: Mapping[str, str] | None = None) -> dict[str, Any] | None:
    env_vars = env_vars or os.environ

    project_id = (env_vars.get("FIREBASE_ADMIN_PROJECT_ID") or "").strip()
    private_key = _normalize_env_private_key(env_vars.get("FIREBASE_ADMIN_PRIVATE_KEY"))
    client_email = (env_vars.get("FIREBASE_ADMIN_CLIENT_EMAIL") or "").strip()

    if not project_id or not private_key or not client_email:
        return None

    return {
        "type": env_vars.get("FIREBASE_ADMIN_TYPE", "service_account"),
        "project_id": project_id,
        "private_key_id": (env_vars.get("FIREBASE_ADMIN_PRIVATE_KEY_ID") or "").strip() or None,
        "private_key": private_key,
        "client_email": client_email,
        "client_id": (env_vars.get("FIREBASE_ADMIN_CLIENT_ID") or "").strip() or None,
        "auth_uri": (env_vars.get("FIREBASE_ADMIN_AUTH_URI") or "").strip() or None,
        "token_uri": (env_vars.get("FIREBASE_ADMIN_TOKEN_URI") or "").strip() or None,
        "auth_provider_x509_cert_url": (env_vars.get("FIREBASE_ADMIN_AUTH_PROVIDER_X509_CERT_URL") or "").strip() or None,
        "client_x509_cert_url": (env_vars.get("FIREBASE_ADMIN_CLIENT_X509_CERT_URL") or "").strip() or None,
        "universe_domain": (env_vars.get("FIREBASE_ADMIN_UNIVERSE_DOMAIN") or "googleapis.com").strip() or "googleapis.com",
    }


def resolve_firebase_credentials_path(env_vars: Mapping[str, str] | None = None) -> str | None:
    env_vars = env_vars or os.environ

    for var_name in ("FRONTEND_FIREBASE_CREDENTIALS", "FIREBASE_CREDENTIALS_PATH", "GOOGLE_APPLICATION_CREDENTIALS"):
        value = (env_vars.get(var_name) or "").strip()
        if value:
            return value

    return None
