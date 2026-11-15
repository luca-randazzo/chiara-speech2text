import os
from dotenv import load_dotenv
from huggingface_hub import login, upload_folder, create_repo

load_dotenv("<path_to_env_file>")

# Store token locally (you can also rely on HF_TOKEN env var)
hf_token = os.environ.get("HF_TOKEN")
if hf_token:
    login(token=hf_token)

# (optional) Login with your Hugging Face credentials if you haven't already
# login()

# the name of the repo we want to push to
# (if the repo doesn't exist, it will be created)
repo_id = "<path_to_your_hf_username>/<model_name>"                                         # <--- IMPORTANT: change this to your own repo name

# the following command creates repo in hugging face Hub
# (no-op if repo already existis)
# private=True: create a private model repo
create_repo(repo_id, repo_type="model", private=True, exist_ok=True)

# Push your model files
upload_folder(
    folder_path="<path_to_your_model_directory>",                                           # <--- IMPORTANT: change this to your local model folder path
    repo_id=repo_id,
    repo_type="model")


'''
# push to hub
# If user wants, push model to Hugging Face Hub
# - <path_to_repo>/utils/push-model-to-hf-hub.py

# - using git:
# -- login to HF via CLI
# python -m pip install huggingface_hub
# hf auth login (use right click to paste token, not middle-click)

# - manually through Hugging Face website
# -- https://huggingface.co/docs/hub/en/repositories-getting-started

# terminal
# git clone https://huggingface.co/username/repo_name
# e.g.: https://huggingface.co/<hf_username>/<model_name>/tree/main?clone=true

# - or APIs. e.g. hf_trainer.push_to_hub()

# pushing to HF can be done e.g. after evaulation and comparison against other models is done
# so that only the best user-chosen model is pushed
'''