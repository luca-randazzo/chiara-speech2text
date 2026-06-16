# 1. Setup

## Setup Python virtual environment (venv)
```bash
sudo apt install python3.12-venv
python3 -m venv .stt
source .stt/bin/activate
python -m pip install --upgrade pip
```

To later leave the virtual environment:
```bash
deactivate
```

## Install requirements
Inside each module (folder) there is a `requirements.txt` file

`cd` to that folder and 

```bash
pip install -r requirements.txt
```

## Install CTranslate2 with CUDA support
```bash
cd /home/lucar/Development
git clone https://github.com/OpenNMT/CTranslate2.git
cd /home/lucar/Development/CTranslate2
mkdir -p build && cd build
cmake .. -DWITH_CUDA=ON -DCMAKE_BUILD_TYPE=Release
cmake --build . -j
cd ..
pip install -U pip
cd python
pip install -v .
```

## Create .env file
The project uses a single `.env` file with all required settings (e.g. secrets, endpoints, etc).

Paste the provided template (see [credentials/.env.example](credentials/.env.example) to a path of your choice.
NOTE: For safety reasons, do not include the file inside the repo itself - to avoid pushing secrets in the cloud.

For now, the variables inside the `.env` file can not be set yet.
Through the next steps, we'll get all details to fill the file.

## Setup Firebase storage
This step allows to setup a cloud storage (where the frontend will store all the data), and get the credentials to use it.

### Create storage bucket
- Go to: https://console.firebase.google.com/ 
- "Create a new Firebase project"
- Set project name (e.g. "speech2text"). Continue, and leave all other settings to default
- From the "Project Overview" page, click on arrow on bottom-left to expand left side-menu
- Click on "Databases & Storage" -> "Storage" -> "Upgrade project" -> "Create a Cloud Billing account". Continue with all steps required to setup the payment
  - Select "No cost location", and "Start in test mode"

### Create app 
- From the "Project Overview" page, click on "+ Add app" -> "Web"
  - Set name. Leave checkbox unchecked (no need to set Firebase hosting)
  - Click "Register app"
  - Copy the content of the provided code snippet to a local file (we'll use its content in the next step!)

### Get credentials for clients
- (the client credentials can be retrieved again as follows: "Project Overview" page, left side-menu -> "Settings" -> "General")
- Paste the fields from the code snippet into the respective fields of the `.env` file

### Get credentials for admin operations
- From the "Project Overview" page, under the project title, click on the newly created app -> click on the gear icon -> "Service accounts"
- "Generate new private key" -> "Generate key"
- Paste the fields from the downloaded .json file into the respective fields of the `.env` file

# 2. Deploy
The modules can be deployed either locally (e.g. an own machine with a GPU) or on a cloud service.

For local deployment, the machine can be added to a tailscale network, to be accessible from any device within the same tailscale network.

## Local model-server service
### Install
The existing service file `/home/lucar/Development/chiara-speech2text_private-v2/model-server/chiara-speech2text_model-server_v2.service`
is configured to run a system service as your user (lucar),that starts on boot and restarts automatically on failure

```bash
# Remove existing service file if exists
sudo rm /etc/systemd/system/chiara-speech2text_model-server_v2.service

# 1. Link the service file to systemd's directory (requires sudo)
sudo ln -s /home/lucar/Development/chiara-speech2text_private-v2/model-server/chiara-speech2text_model-server_v2.service /etc/systemd/system/chiara-speech2text_model-server_v2.service

# 2. Reload systemd to recognize the new service
sudo systemctl daemon-reload

# 3. Enable the service to start on boot
sudo systemctl enable chiara-speech2text_model-server_v2.service

# 4. Start the service now
sudo systemctl start chiara-speech2text_model-server_v2.service
```

### Manage and Monitor
Restart Service:
```bash
sudo systemctl daemon-reload
sudo systemctl restart chiara-speech2text_model-server_v2.service
sudo systemctl status chiara-speech2text_model-server_v2.service --no-pager -l
```

View Logs: 
```bash
sudo journalctl -u chiara-speech2text_model-server_v2.service -f
```

Check Status:
```bash
sudo systemctl status chiara-speech2text_model-server_v2.service
```

Stop Service:
```bash
sudo systemctl stop chiara-speech2text_model-server_v2.service
```
(This will trigger the cleanup function in your script, stopping and removing the container).


### Test
(see `/home/lucar/Development/chiara-speech2text_private-v2/model-server/model-server.py` for examples)


## Local frontend service
### Install
The existing service file `/home/lucar/Development/chiara-speech2text_private-v2/frontend/chiara-speech2text_frontend_v2.service`
is configured to run a system service as your user (lucar),that starts on boot and restarts automatically on failure

```bash
# Remove existing service file if exists
sudo rm /etc/systemd/system/chiara-speech2text_frontend_v2.service

# 1. Link the service file to systemd's directory (requires sudo)
sudo ln -s /home/lucar/Development/chiara-speech2text_private-v2/frontend/chiara-speech2text_frontend_v2.service /etc/systemd/system/chiara-speech2text_frontend_v2.service

# 2. Reload systemd to recognize the new service
sudo systemctl daemon-reload

# 3. Enable the service to start on boot
sudo systemctl enable chiara-speech2text_frontend_v2.service

# 4. Start the service now
sudo systemctl start chiara-speech2text_frontend_v2.service
```

### Manage and Monitor
Restart Service:
```bash
sudo systemctl daemon-reload
sudo systemctl restart chiara-speech2text_frontend_v2.service
sudo systemctl status chiara-speech2text_frontend_v2.service --no-pager -l
```

View Logs:
```bash
sudo journalctl -u chiara-speech2text_frontend_v2.service -f
```

Check Status:
```bash
sudo systemctl status chiara-speech2text_frontend_v2.service
```

Stop Service:
```bash
sudo systemctl stop chiara-speech2text_frontend_v2.service
```
(This will trigger the cleanup function in your script, stopping and removing the container).

## Cloud frontend on Google Cloud Run

```bash
cd frontend
chmod +x deploy.sh
./deploy.sh /path/to/your/.env
```

### Test frontend
To access deployed images:
- Go to: https://console.cloud.google.com/
- Click on the hamburger menu (3 lines on the top-right of the page)
- Select "Cloud Run" -> "Services"
- Click on the available link
- The public URL is shown on top. You can use it to access the deployed frontend

# 3. Use
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

```bash
# Compare 2 models
python3 /home/lucar/Development/nvidia-nemo/tools/speech_data_explorer/data_explorer.py         \
    /home/lucar/Development/chiara-speech2text_private-v2/models-evaluator/results/results.json \
    --names_compared pred_text_finetuned1 pred_text_finetuned2

# Compare 2 models, show stats for 2nd model
python3 /home/lucar/Development/nvidia-nemo/tools/speech_data_explorer/data_explorer.py                     \
    /home/lucar/Development/chiara-speech2text_private-v2/models-evaluator/results/20260612_results.json    \
    --names_compared pred_text_finetuned1 pred_text_finetuned2                                              \
    --show_statistics pred_text_finetuned2
```

## Evaluate models with custom analysis tool
```bash
source .stt/bin/activate
python3 /home/lucar/Development/chiara-speech2text_private-v2/models-evaluator/analysis-tool/launch.py \
  /home/lucar/Development/chiara-speech2text_private-v2/models-evaluator/results/20260612_words_chiara_whisper-large-v3-turbo_20260612.csv
```