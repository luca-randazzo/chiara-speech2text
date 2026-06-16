import os
from dotenv import load_dotenv
from huggingface_hub import login, upload_folder, create_repo
from huggingface_hub.hf_api import HfFolder

load_dotenv("/home/lucar/Development/chiara-speech2text_private-v2/envs/.env")

# Store token locally (you can also rely on HF_TOKEN env var)
hf_token = os.environ.get("HF_TOKEN")
if hf_token:
    HfFolder.save_token(hf_token)

# (optional) Login with your Hugging Face credentials if you haven't already
# login()

# the name of the repo we want to push to
# (if the repo doesn't exist, it will be created)
repo_id = "luca-r/chiara_whisper-large-v3-turbo_20260612"

# the following command creates repo in hugging face Hub
# (no-op if repo already existis)
# private=True: create a private model repo
create_repo(repo_id, repo_type="model", private=True, exist_ok=True)

# Push your model files
upload_folder(
    folder_path="/home/lucar/Development/chiara-speech2text_models/chiara_whisper-large-v3-turbo_20260612",
    repo_id=repo_id,
    repo_type="model")