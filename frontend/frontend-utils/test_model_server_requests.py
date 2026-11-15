import importlib.util
import sys
from pathlib import Path


def _load_frontend_module():
    frontend_dir = Path(__file__).resolve().parent.parent
    env_path = frontend_dir.parent / "envs" / "example.env"
    sys.path.insert(0, str(frontend_dir))
    sys.argv = ["frontend.py", "--env-file", str(env_path)]
    module_name = "frontend_app_for_test"
    spec = importlib.util.spec_from_file_location(module_name, frontend_dir / "frontend.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def test_model_server_session_disables_proxy_env(monkeypatch):
    monkeypatch.setenv("MODEL_SERVER_HOST", "127.0.0.1")
    monkeypatch.setenv("MODEL_SERVER_PORT", "8000")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:5001")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:5001")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:5001")
    monkeypatch.setenv("https_proxy", "http://127.0.0.1:5001")

    frontend = _load_frontend_module()
    session = frontend._create_model_server_session()

    assert session.trust_env is False
