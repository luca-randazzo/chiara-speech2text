# 1. Setup

## 1.1. Create variable for project home-path
```bash
export CHIARA_STT=$HOME/Development/chiara-speech2text
```

## 1.2. Install required system packages
```bash
sudo apt update
sudo apt autoremove
sudo apt install python3-venv
sudo apt install python3-dev build-essential
```

## 1.3. Setup Python virtual environment (venv)
Create environment
```bash
cd $CHIARA_STT
python3 -m venv .stt
```

Activate environment, and install required packages
```bash
source $CHIARA_STT/.stt/bin/activate
python3 -m pip install --upgrade pip setuptools wheel
```

To later leave the virtual environment:
```bash
deactivate
```

## 1.4. Install CTranslate2 with CUDA support (if CUDA available)
The model-server module uses CTranslate2 on CUDA
to perform inference (i.e. transcribe audios into text) via OpenAI Whisper models

If that exists, remove previous CTranslate2 folder
```bash
sudo rm -r $HOME/Development/CTranslate2
```

```bash
# source venv
source $CHIARA_STT/.stt/bin/activate

# clone CTranslate2
cd $HOME/Development
git clone https://github.com/OpenNMT/CTranslate2.git
cd $HOME/Development/CTranslate2
git submodule update --init --recursive

# build CTranslate2
mkdir -p build
cd build
cmake .. -DWITH_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DOPENMP_RUNTIME=COMP -DWITH_MKL=OFF
cmake --build . -j

# copy built lib to path for later install
cd $HOME/Development/CTranslate2
mkdir -p lib
cp $HOME/Development/CTranslate2/build/libctranslate2.so* $HOME/Development/CTranslate2/lib/

# install CTranslate2 in venv
export CTRANSLATE2_ROOT=$HOME/Development/CTranslate2
cd $HOME/Development/CTranslate2/python
python -m pip install --upgrade pip setuptools wheel
python -m pip install -v .

# install system-wide
echo "$HOME/Development/CTranslate2/lib" | sudo tee /etc/ld.so.conf.d/ctranslate2.conf
sudo ldconfig
```

## 1.5. Create .env file
The project uses a single `.env` file to:
- set all settings (e.g. endpoints, ports)
- store secrets (e.g. access tokens)

A template file is provided (see [envs/example.env](envs/example.env).
Paste the file to a chosen path.
NOTE: To avoid risking to push secrets to cloud, paste the file outside the repo itself - to a local, not-tracked folder.

Through the next steps, we'll fill all variables inside the newly created `.env` file.

## 1.6. Setup Firebase storage
This repo uses a Google Firebase storage bucket to store all the audio data (e.g. recordings) and metadata (e.g. transcripts)

This step allows to:
- Setup the Firebase cloud storage
- Get the credentials to allow this repo's scripts to use the storage

### 1.5.1. Create storage bucket
NOTE: if the bucket already exists, directly skip to section (1.5.3 NOTE) 

- Go to: https://console.firebase.google.com/ 
- "Create a new Firebase project"
- Set project name (e.g. "speech2text"). Continue, and leave all other settings to default
- From the "Project Overview" page, click on arrow on bottom-left to expand left side-menu
- Click on "Databases & Storage" -> "Storage" -> "Upgrade project" -> "Create a Cloud Billing account". Continue with all steps required to setup the payment
  - Select "No cost location", and "Start in test mode"

### 1.5.2. Create app 
- From the "Project Overview" page, click on "+ Add app" -> "Web"
  - Set name
  - Leave checkbox "Also set up Firebase Hosting for this app." unchecked
  (no need to set Firebase hosting)
  - Click "Register app"
  - Copy the content of the provided code snippet to a local file (we'll use its content in the next step!)

### 1.5.3. Set clients credentials
- Paste the fields from the code snippet from the previous step into the respective fields of the `.env` file

NOTE: If you failed to copy the content of the code snippet,
or if you have to get the credentials of an already-existing project 
the credentials can be retrieved again by navigating:
- https://console.firebase.google.com/ 
- "Project Overview" page, left side-menu -> "Settings" -> "General"

### 1.5.4. Set admin credentials
- From the "Project Overview" page, under the project title, click on the newly created app (icon with "</>")
- Click on the gear icon -> "Service accounts"
- "Generate new private key" -> "Generate key". This will download a .json file
- Open the .json file and copy-paste its variables into the respective variables of the `.env` file

The remaining variables of the `.env` file will be filled in section (2) 

# 2. Configure and test modules

## 2.1. frontend

### Setup `.env` file
```
FRONTEND_HOST=127.0.0.1
FRONTEND_PORT=5000
```

to use Firebase Cloud storage:
```
FRONTEND_SOURCE=firebase
FRONTEND_FIREBASE_BUCKET=${FIREBASE_CLIENT_STORAGE_BUCKET_SOURCE}
```    
    
to use local storage:
```
FRONTEND_SOURCE=local
FRONTEND_LOCAL_ROOT=<path/to/local/directory>
```

### Install requirements
```bash
cd ${CHIARA_STT}/frontend
pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
```

### Test
```bash
clear
python ${CHIARA_STT}/frontend/frontend.py \
  --env-file $HOME/Development/chiara-speech2text_envs/.env
```

## 2.2. model-server (and model-server-multi)

### Install requirements
```bash
cd ${CHIARA_STT}/model-server
pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
```

### Get fine-tuned OpenAI Whisper model
An OpenAI Whisper model can be obtained:
- From the `model-trainer/3-train-whisper.ipynb`
- Download from Hugging-Face:
```bash
# install git-xet (https://hf.co/docs/hub/git-xet)
curl -sSfL https://hf.co/git-xet/install.sh | sh

# When prompted for a password, use an access token with write permissions.
# Generate one from your settings: https://huggingface.co/settings/tokens
git clone https://huggingface.co/luca-r/chiara_whisper-large-v3-turbo_20260624
```

### Setup `.env` file
```
MODEL_SERVER_HOST=127.0.0.1
MODEL_SERVER_PORT=8000
MODEL_SERVER_WHISPER_MODEL_PATH=(set same path used as --output_dir for the ctranslate2.converters.transformers command) 
```

### Run modules
- model-server
```bash
clear
python ${CHIARA_STT}/model-server/model-server.py \
  --env-file $HOME/Development/chiara-speech2text_envs/.env
```

- model-server-multi
```bash
clear
python ${CHIARA_STT}/model-server/model-server-multi.py
```

### Test module
- Test `model-server`
(see `model-server/model-server.py` for examples)

```bash
# get simple response
curl -F wav=@$HOME/Development/chiara-speech2text/assets/audios/sample.wav "http://127.0.0.1:8000/transcribe?upload_to_firebase_server=false"

# get json response
curl -F wav=@$HOME/Development/chiara-speech2text/assets/sample.wav "http://127.0.0.1:8000/transcribe?upload_to_firebase_server=false&json_response=true"

# validate transcript
curl -X POST -H "Content-Type: application/json" -H "X-Device-Id: dev" \
  -d '{"transcript":"casa"}' \
  "http://127.0.0.1:8000/validate"

# test LLM
curl -X POST "127.0.0.1:8000/llm" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "why dogs bark?"
      }
    ]
  }'
```

- Test `model-server-multi`
```bash
curl -F wav=@$HOME/Development/chiara-speech2text/assets/audios/sample.wav "127.0.0.1:9100/transcribe_all"
```

# 3. Deploy
Modules can be deployed either locally (e.g. an own machine with a GPU) or on a cloud service.

For local deployment, the machine can be added to a tailscale network, to be accessible from any device within the same tailscale network.

## Local - 'frontend' service
### Install
The existing service file `frontend/chiara-speech2text_frontend.service`
is configured to run a system service as your user, that starts on boot and restarts automatically on failure

```bash
# Remove existing service file if exists
sudo rm /etc/systemd/system/chiara-speech2text_frontend.service
```

```bash
# Link service file to systemd's directory (requires sudo)
sudo ln -s ${CHIARA_STT}/frontend/chiara-speech2text_frontend.service /etc/systemd/system/chiara-speech2text_frontend.service

# Reload systemd to recognize new service
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable chiara-speech2text_frontend.service

# Start service now
sudo systemctl start chiara-speech2text_frontend.service
```

### Manage and Monitor
Restart Service:
```bash
sudo systemctl daemon-reload
sudo systemctl restart chiara-speech2text_frontend.service
sudo systemctl status chiara-speech2text_frontend.service --no-pager -l
```

View Logs:
```bash
sudo journalctl -u chiara-speech2text_frontend.service -f
```

Check Status:
```bash
sudo systemctl status chiara-speech2text_frontend.service
```

Stop Service:
```bash
sudo systemctl stop chiara-speech2text_frontend.service
```
(This will trigger the cleanup function in your script, stopping and removing the container).

## Local - 'model-server' service
### Install
The existing service file `model-server/chiara-speech2text_model-server.service`
is configured to run a system service as your user, that starts on boot and restarts automatically on failure

```bash
# Remove existing service file if exists
sudo rm /etc/systemd/system/chiara-speech2text_model-server.service
```

```bash
# Link service file to systemd's directory (requires sudo)
sudo ln -s $HOME/Development/chiara-speech2text/model-server/chiara-speech2text_model-server.service /etc/systemd/system/chiara-speech2text_model-server.service

# Reload systemd to recognize new service
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable chiara-speech2text_model-server.service

# Start service now
sudo systemctl start chiara-speech2text_model-server.service
```

### Manage and Monitor
Restart Service:
```bash
sudo systemctl daemon-reload
sudo systemctl restart chiara-speech2text_model-server.service
sudo systemctl status chiara-speech2text_model-server.service --no-pager -l
```

View Logs: 
```bash
sudo journalctl -u chiara-speech2text_model-server.service -f
```

Check Status:
```bash
sudo systemctl status chiara-speech2text_model-server.service
```

Stop Service:
```bash
sudo systemctl stop chiara-speech2text_model-server.service
```
(This will trigger the cleanup function in your script, stopping and removing the container).

## Google Cloud Run - 'frontend'
```bash
cd frontend
chmod +x deploy.sh
./deploy.sh /path/to/your/.env
```

### Test deployed frontend
To access deployed images:
- Go to: https://console.cloud.google.com/
- Click on the hamburger menu (3 lines on the top-right of the page)
- Select "Cloud Run" -> "Services"
- Click on the available link
- The public URL is shown on top. You can use it to access the deployed frontend

# 4. Use
## Keyboard
Before using the keyboard, a server hosting a fine-tuned Whisper model must be deployed. See instructions at section `Deploy -> model-server service` above.

The deployed server module will serve a fine-tuned Whisper model, through a service that accepts ".wav" files as input and returns a decoded transcript.

The keyboard source code in this repo is forked from: https://github.com/j3soon/whisper-to-input 
Keyboard must be compiled with Android Studio

- Open the `keyboard` folder (Android project) with Android Studio
- Connect the tablet / smartphone on which you want to install the keyboard
- From the top right bar, ensure connected tablet / smartphone is recognized
- Click on "Run 'app'". This will install the keyboard on the phone
- From the tablet / smartphone
  - The keyboard settings shall automatically open. If not, go to Apps -> "chiara-speech2text_keyboard_v2"
  - Set the "ASR primary endpoint" field to the address where your server serving the fine-tune Whisper model is deployed
    e.g. `100.0.0.0:8000/transcribe`
  - On the top right, click on "Android settings - Keyboards"
  - Enable "chiara-speech2text_keyboard_v2"
  - Click on "Default keyboard", select "chiara-speech2text_keyboard_v2"
  - Now, every time the user clicks on a text field (e.g. Whatsapp message field) the custom keyboard will be brought up
  - Try clicking on the microphone icon, whihc will record an audio and send it to the "ASR primary endpoint" 

## Evaluate models with Nvidia Speech Explorer tool
The notebook `models-evaluator/models-evaluator.ipynb` can be used to evaluate models on a given dataset and generate a .jsonl file 

The .jsonl file can then be used with Nvidia Speech Explorer tool
- https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/speech_data_explorer.html 
- https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/comparison_tool.html 

### Install
```bash
pip install -r '$HOME/Development/nvidia-nemo/tools/speech_data_explorer/requirements.txt'
```

### Use
```bash   
# Compare 2 models, , show stats for 2nd model
python3 $HOME/Development/nvidia-nemo/tools/speech_data_explorer/data_explorer.py       \
    $HOME/Development/chiara-speech2text_results/results_20260624/20260624_results.json \
    --names_compared pred_text_vanilla pred_text_finetuned2                                   \
    --show_statistics pred_text_finetuned2

# 1 model
python3 $HOME/Development/nvidia-nemo/tools/speech_data_explorer/data_explorer.py       \
    $HOME/Development/chiara-speech2text_results/results_20260701-chiara_whisper-large-v3-turbo_20260630/20260701_results.json 
```

## Evaluate models with custom analysis tool
```bash
source .stt/bin/activate
python3 $HOME/Development/chiara-speech2text/models-evaluator/analysis-tool/launch.py \
  $HOME/Development/chiara-speech2text_results/results_20260701-chiara_whisper-large-v3-turbo_20260630/20260701_words.csv
```