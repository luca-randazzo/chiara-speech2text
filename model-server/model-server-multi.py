# -----------------------------
# instructions
# -----------------------------
# This is a FastAPI server that serves multiple ASR models (Whisper fine-tuned models) and an LLM model for post-processing the transcripts.
# Set the 'path_whisper_finetuned1' and 'path_whisper_finetuned2' variables to the paths of the fine-tuned Whisper models you want to use.
# See 'docs/1-setup.md' for more details on how to prepare models for this server, and how to launch the server.

# To test transcription + LLM locally:
# - Run Docker image which serves the Ollama LLM model, e.g.: /home/luca/Development/chiara-speech2text/models-mixer/launch-open-webui.sh
# - Run this file
# -----------------------------


# -----------------------------
# user parameters
# -----------------------------
# model paths
# NOTE: models must be in the correct format for the backend (CT2 or Transformers).
# The code will automatically detect the format based on the presence of model.bin and config.json files.
# check 'docs/1-setup.md' for more details on how to prepare the models for this server.
#path_whisper_vanilla    = "/home/luca/Development/chiara-speech2text_models/whisper-large-v3"
path_whisper_finetuned2 = "/home/luca/Development/chiara-speech2text_models/chiara_whisper_20261026"        #-ct2
path_whisper_finetuned1 = "/home/luca/Development/chiara-speech2text_models/chiara_whisper_20261112_kto"    #-ct2

# port
http_port = 9100

# LLM model
#llm_model = "gemma4:e2b" # ensure this model is available through local Ollama instance
llm_model = "gemma3:1b" # ensure this model is available through local Ollama instance
#llm_model  = "gpt-oss:120b" # ensure this model is available through local Ollama instance
llm_prompt = '''
You are part of an Automatic Speech Recognition (ASR) system for a user who has dysarthria and impaired speech.
You are provided with a transcript as input. You have to proofread it, fix spelling and grammar.
- Do not propose multiple alternatives, only one final answer
- Your answer must only be the processed output, no decorations, no explanations (like "sure", "this is the answer", etc), only the final corrected transcript
- Do not change the meaning or add new information
- Remove any word repeated more than 3 times
- Add punctuation as needed
- Input is in Italian language
- Output must be in Italian language
'''
# -----------------------------


# -----------------------------
# setup logging
import logging
#logging.basicConfig(level=logging.DEBUG)
logging.basicConfig(level=logging.INFO)
# -----------------------------


# -----------------------------
# imports
# -----------------------------
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi import Body, FastAPI, UploadFile, File, Query
import tempfile
import shutil
import json
from faster_whisper import WhisperModel
from transformers import WhisperForConditionalGeneration, WhisperProcessor
# Patch transformers to load newer configs with list-formatted extra_special_tokens
import transformers
try:
    orig_set_model_specific_special_tokens = transformers.tokenization_utils_base.SpecialTokensMixin._set_model_specific_special_tokens
    def patched_set_model_specific_special_tokens(self, special_tokens):
        if isinstance(special_tokens, list):
            special_tokens = {tok: tok for tok in special_tokens}
        return orig_set_model_specific_special_tokens(self, special_tokens)
    transformers.tokenization_utils_base.SpecialTokensMixin._set_model_specific_special_tokens = patched_set_model_specific_special_tokens
except AttributeError:
    pass

import torch
import librosa
import traceback
from datetime import datetime
import time
import firebase_admin
from firebase_admin import credentials, storage
#from nemo.collections.asr.models import ASRModel
import requests
import os
import uvicorn
from ollama import chat
from ollama import ChatResponse
# -----------------------------


# -----------------------------
# set device (GPU or CPU)
# -----------------------------
# for warning: Found GPU0 NVIDIA GB10 which is of cuda capability 12.1., look into: https://build.nvidia.com/spark/pytorch-fine-tune/instructions
cuda_available = torch.cuda.is_available()
if cuda_available:
    logging.debug(f"CUDA device count: {torch.cuda.device_count()}")
    for i in range(torch.cuda.device_count()):
        logging.debug(f"CUDA device {i} name: {torch.cuda.get_device_name(i)}")
device = "cuda" if cuda_available else "cpu"

logging.debug(f"PyTorch version: {torch.__version__}")
logging.debug(f"CUDA version from PyTorch: {torch.version.cuda}")
logging.debug(f"CUDA available according to PyTorch: {cuda_available}")
logging.info(f"Using device: {device}")
# -----------------------------


# -----------------------------
# load models
# -----------------------------
def _looks_like_ct2_dir(path):
    return (
        os.path.isdir(path)
        and os.path.isfile(os.path.join(path, "model.bin"))
        and os.path.isfile(os.path.join(path, "config.json"))
    )


def _get_whisper_feature_size(path):
    for filename in ("preprocessor_config.json", "processor_config.json"):
        config_path = os.path.join(path, filename)
        if not os.path.isfile(config_path):
            continue

        with open(config_path, "r", encoding="utf-8") as config_file:
            config = json.load(config_file)
        feature_extractor = config.get("feature_extractor", config)
        return feature_extractor.get("feature_size")

    return None


def _load_whisper_model(path, model_name):
    transformers_path = path[:-4] if path.endswith("-ct2") else path
    ct2_path = path
    if not _looks_like_ct2_dir(ct2_path) and _looks_like_ct2_dir(f"{path}-ct2"):
        ct2_path = f"{path}-ct2"

    if _looks_like_ct2_dir(ct2_path):
        feature_size = _get_whisper_feature_size(transformers_path)
        has_transformers_weights = any(
            os.path.isfile(os.path.join(transformers_path, filename))
            for filename in ("model.safetensors", "pytorch_model.bin")
        )
        if feature_size not in (None, 80) and has_transformers_weights:
            logging.warning(
                f"Whisper {model_name} uses {feature_size} mel bins; loading its Transformers checkpoint "
                f"from {transformers_path} instead of the incompatible CT2 export"
            )
            path = transformers_path
        else:
            logging.info(f"Loading Whisper {model_name} CT2 model from: {ct2_path}...")
            model = WhisperModel(
                ct2_path,
                device=device,
                compute_type="float16" if cuda_available else "int8",
            )
            logging.info(f"Successfully loaded Whisper {model_name} CT2 model")
            return model, None, "ct2"

    logging.info(f"Loading Whisper {model_name} Transformers model from: {path}...")
    model = WhisperForConditionalGeneration.from_pretrained(path)
    processor = WhisperProcessor.from_pretrained(path)
    model.to(device)
    model.eval()
    logging.info(f"Successfully loaded Whisper {model_name} Transformers model")
    return model, processor, "transformers"


try:
    # vanilla
    '''
    model_whisper_vanilla, processor_whisper_vanilla, backend_whisper_vanilla = _load_whisper_model(
        path_whisper_vanilla,
        "vanilla",
    )
    '''

    # fine-tuned 1
    model_whisper_finetuned1, processor_whisper_finetuned1, backend_whisper_finetuned1 = _load_whisper_model(
        path_whisper_finetuned1,
        "finetuned 1",
    )

    # fine-tuned 2
    model_whisper_finetuned2, processor_whisper_finetuned2, backend_whisper_finetuned2 = _load_whisper_model(
        path_whisper_finetuned2,
        "finetuned 2",
    )
except Exception as e:
    model_whisper_vanilla         = None
    processor_whisper_vanilla     = None
    backend_whisper_vanilla       = None
    #
    model_whisper_finetuned1      = None
    processor_whisper_finetuned1  = None
    backend_whisper_finetuned1    = None
    #
    model_whisper_finetuned2      = None
    processor_whisper_finetuned2  = None
    backend_whisper_finetuned2    = None
    #
    logging.error(f"Failed to load models: {e}")
    logging.error(f"Traceback:\n{traceback.format_exc()}")
    logging.error(f"If trying to load models from local path, make sure the path is correct and that the model files are present in that path")
    exit(1)
# -----------------------------


# -----------------------------
# functions
# -----------------------------
def _process_wavfile(wav, verbose):    
    # store received file for processing
    try:
        fd, wav_file = tempfile.mkstemp()
        os.close(fd)
        
        with open(wav_file, "wb") as buffer:
            shutil.copyfileobj(wav.file, buffer)
        
        if verbose: logging.info(f"[_process_input_wavfile] Received audio file. Converted '{wav.filename}' to '{wav_file}'. Now transcribing...")
        return wav_file
    
    except Exception as e:
        tb = traceback.format_exc()
        logging.error(f"[_process_input_wavfile] Error: {e}")
        logging.error(f"[_process_input_wavfile] Traceback:\n{tb}")

        # Attempt safe removal of temporary file
        try:
            if os.path.exists(wav_file):    os.remove(wav_file)
        except Exception as re:
            logging.warning(f"[_process_input_wavfile] Failed to remove tmp file {wav_file}: {re}")
            
        # raise exception
        raise e

def _transcribe_whisper(wav_file, model, processor=None, backend="transformers", verbose=False):
    start_time = time.time()

    try:
        if model is None:
            raise RuntimeError("Whisper model not loaded")

        if backend == "ct2":
            segments, _ = model.transcribe(
                wav_file,
                language                    ="it",
                task                        ="transcribe",
                beam_size                   =1,
                temperature                 =0.0,
                condition_on_previous_text  =False,
            )
            transcript_whisper = "".join(segment.text for segment in segments).strip()
        elif processor is not None:
            # Load audio
            waveform, _ = librosa.load(wav_file, sr=16000)

            # Process features
            inputs = processor(waveform, sampling_rate=16000, return_tensors="pt")
            input_features = inputs.input_features.to(device, dtype=model.dtype)
            
            # Generate transcription
            with torch.no_grad(): predicted_ids = model.generate(
                input_features,
                language    ="it",
                task        ="transcribe")
            
            # Decode
            transcript_whisper = processor.batch_decode(
                predicted_ids,
                skip_special_tokens=True,
            )[0].strip()
        else:
            raise RuntimeError(f"Unsupported Whisper backend: {backend}")

        if verbose:
            logging.info(f"[_transcribe_whisper] Backend: {backend}")
            logging.info(f"[_transcribe_whisper] Whisper transcription took {time.time() - start_time:.2f} seconds")
            logging.info(f"[_transcribe_whisper] Whisper transcription completed: {transcript_whisper}\n")

        return transcript_whisper
    
    except Exception as e:
        tb = traceback.format_exc()
        logging.error(f"[_transcribe_whisper] Error during Whisper transcription: {e}")
        logging.error(f"[_transcribe_whisper] Traceback:\n{tb}")
        raise e

def _process_with_llm(transcript, verbose=False):
    start_time = time.time()

    prompt = llm_prompt + "The transcript is the following: " +transcript
    
    if verbose: logging.info(f"[_process_with_llm] prompt to LLM: {prompt}")
    #if verbose: logging.info(f"[_process_with_llm] Received: {transcript}")

    try:
        if verbose: logging.info(f"[_process_with_llm] Processing input with LLM...")

        # send the request to the model-server
        response: ChatResponse = chat(model=llm_model, messages=[
        {
            'role':     'user',
            'content':  prompt,
        },
        ])
        llm_response = response.message.content
        
        end_time_llm = time.time()

        # info
        if verbose:
            logging.info(f"[_process_with_llm] LLM response took {end_time_llm - start_time:.2f} seconds")
            logging.info(f"[_process_with_llm] LLM response: {llm_response}\n")
        
        # return
        return llm_response
    
    except Exception as e:
        logging.error(f"[_process_with_llm] Error during LLM response: {e}")
        raise e
# -----------------------------


# -----------------------------
# app and endpoints
# -----------------------------
app = FastAPI()

#
@app.get("/")
def greet_json():
    return {
        "msg"   : "Hello world. I'm model-server-multi.py",
        "usage" :
            "Send a POST request to /transcribe_multi with an attached wav file.\n"
            "This service returns a response in JSON format, with the following fields:\n"
            f"- transcript_whisper_finetuned1: output from {path_whisper_finetuned1}\n"
            #f"- transcript_whisper_finetuned2: output from {path_whisper_finetuned2}\n"
    }

# process_with_llm
@app.post('/process_with_llm')
def process_with_llm(transcript: str = Body(...), verbose: bool = False):
    return PlainTextResponse(content=_process_with_llm(transcript, verbose))

# transcribe_multi
@app.post('/transcribe_multi')
def transcribe_multi(
        wav: UploadFile = File(...),
        verbose: bool = Query(False, description="If true, the server will print detailed logs during transcription")
    ):
    
    start_time = time.time()
    if verbose: logging.info(f"[transcribe_multi] Received request. Processing...")

    #transcript_whisper_vanilla    = None
    transcript_whisper_finetuned1 = None
    transcript_whisper_finetuned2 = None
    try:
        # process input wav file
        wav_file = _process_wavfile(wav, verbose)

        # transcribe whisper vanilla
        '''
        try:
            transcript_whisper_vanilla  = _transcribe_whisper(
                wav_file,
                model_whisper_vanilla,
                processor_whisper_vanilla,
                backend_whisper_vanilla,
                verbose)
            if verbose: logging.info(f"[transcribe_multi] transcript_whisper_vanilla: {transcript_whisper_vanilla}")
        except Exception as e:
            logging.error(f"[transcribe_multi] Error during whisper vanilla transcription: {e}")
            transcript_whisper_vanilla = None
        '''

        # transcribe whisper finetuned1
        try:
            transcript_whisper_finetuned1 = _transcribe_whisper(
                wav_file,
                model_whisper_finetuned1,
                processor_whisper_finetuned1,
                backend_whisper_finetuned1,
                verbose,
            )
            if verbose: logging.info(f"[transcribe_multi] transcript_whisper_finetuned1: {transcript_whisper_finetuned1}")
        except Exception as e:
            logging.error(f"[transcribe_multi] Error during whisper finetuned1 transcription: {e}")
            transcript_whisper_finetuned1 = None

        # transcribe whisper finetuned2
        try:
            transcript_whisper_finetuned2 = _transcribe_whisper(
                wav_file,
                model_whisper_finetuned2,
                processor_whisper_finetuned2,
                backend_whisper_finetuned2,
                verbose,
            )
            if verbose: logging.info(f"[transcribe_multi] transcript_whisper_finetuned2: {transcript_whisper_finetuned2}")
            
            # add LLM processing to whisper finetuned2 transcript
            #transcript_whisper_finetuned2_llm =_process_with_llm(transcript_whisper_finetuned2, verbose)
        except Exception as e:
            logging.error(f"[transcribe_multi] Error during whisper finetuned2 transcription: {e}")
            transcript_whisper_finetuned2 = None

    except Exception as e:
        tb = traceback.format_exc()
        logging.error(f"[transcribe_multi] Error during transcription: {e}")
        logging.error(f"[transcribe_multi] Traceback:\n{tb}")
        return JSONResponse(content={"error": str(e), "traceback": tb}, status_code=500)
    
    #
    end_time = time.time()
    if verbose: logging.info(f"[transcribe_multi] Finished transcription(s). Total required time: {end_time - start_time:.2f} seconds")

    # remove audio file
    try:                os.remove(wav_file)
    except Exception:   pass
    
    # return transcription
    #return PlainTextResponse(content=transcript_mixer)
    return JSONResponse(content={
        #"transcript_whisper_vanilla":        transcript_whisper_vanilla,
        "transcript_whisper_finetuned1":     transcript_whisper_finetuned1,
        "transcript_whisper_finetuned2":     transcript_whisper_finetuned2,
    })
# -----------------------------

#
if __name__ == "__main__":
    print(f"--------------------------------------------------------------------------")
    print(f"                 Hello world. I'm model-server-multi.py")
    print(f"--------------------------------------------------------------------------")
    
    uvicorn.run(app, host="0.0.0.0", port=http_port)
# -----------------------------