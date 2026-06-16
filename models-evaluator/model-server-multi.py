# -----------------------------
# instructions
# -----------------------------
# To test locally:
# - Run Docker image which serves the Ollama LLM model:  /home/lucar/Development/chiara-speech2text/models-mixer/launch-open-webui.sh
# - Run this file
# - Send requests:
# curl -F wav=@/home/lucar/Development/chiara-speech2text/assets/chiara-1.wav "127.0.0.1:9100/transcribe_all"
# -----------------------------


# -----------------------------
# user parameters
# -----------------------------
# port
http_port = 9100

# model paths
path_whisper_vanilla        = "/home/lucar/Development/chiara-speech2text_models/whisper-large-v3-turbo/"
path_whisper_finetuned1     = "/home/lucar/Development/chiara-speech2text_models/chiara_whisper-large-v3-turbo_20260318/"
path_whisper_finetuned2     = "/home/lucar/Development/chiara-speech2text_models/chiara_whisper-large-v3-turbo_20260612/"

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
from transformers import WhisperForConditionalGeneration, WhisperProcessor
# Patch transformers to load newer configs with list-formatted extra_special_tokens
import transformers
orig_set_model_specific_special_tokens = transformers.tokenization_utils_base.SpecialTokensMixin._set_model_specific_special_tokens
def patched_set_model_specific_special_tokens(self, special_tokens):
    if isinstance(special_tokens, list):
        special_tokens = {tok: tok for tok in special_tokens}
    return orig_set_model_specific_special_tokens(self, special_tokens)
transformers.tokenization_utils_base.SpecialTokensMixin._set_model_specific_special_tokens = patched_set_model_specific_special_tokens

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
try:
    # -------------------------------------------------- vanilla models
    # load 
    logging.info(f" --------------------------------------------------")
    logging.info(f"Loading whisper vanilla from: {path_whisper_vanilla}...")
    model_whisper_vanilla      = WhisperForConditionalGeneration.from_pretrained   (path_whisper_vanilla) # whisper-model vanilla
    processor_whisper_vanilla  = WhisperProcessor.from_pretrained                  (path_whisper_vanilla)
    logging.info(f"Successfully loaded whisper vanilla")
       
    # move to GPU
    logging.info(f"Moving whisper vanilla to device: {device}...")
    model_whisper_vanilla.to(device)
    logging.info(f"Successfully moved whisper vanilla")
    

    # -------------------------------------------------- fine-tuned models
    # load
    # - whisper 1
    logging.info(f" --------------------------------------------------")
    logging.info(f"Loading whisper finetuned 1 from: {path_whisper_finetuned1}...")
    model_whisper_finetuned1        = WhisperForConditionalGeneration.from_pretrained   (path_whisper_finetuned1)  # whisper-model,      custom, local path
    processor_whisper_finetuned1    = WhisperProcessor.from_pretrained                  (path_whisper_finetuned1)  # whisper-processor,  custom, local path
    logging.info(f"Successfully loaded whisper finetuned 1")
    
    # - whisper
    logging.info(f"Loading whisper finetuned 2 from: {path_whisper_finetuned2}...")
    model_whisper_finetuned2        = WhisperForConditionalGeneration.from_pretrained   (path_whisper_finetuned2)   # whisper-model,      custom, local path
    processor_whisper_finetuned2    = WhisperProcessor.from_pretrained                  (path_whisper_finetuned2)   # whisper-processor,  custom, local path
    logging.info(f"Successfully loaded whisper finetuned 2")

    # move models to GPU
    logging.info(f"Moving whisper finetuned 1 to device: {device}...")
    model_whisper_finetuned1.to(device)
    logging.info(f"Successfully moved whisper finetuned 1")
    
    logging.info(f"Moving whisper finetuned 2 to device: {device}...")
    model_whisper_finetuned2.to(device)
    logging.info(f"Successfully moved whisper finetuned 2")
    
except Exception as e:
    model_whisper_vanilla         = None
    processor_whisper_vanilla     = None
    #
    model_whisper_finetuned1      = None
    processor_whisper_finetuned1  = None
    #
    model_whisper_finetuned2      = None
    processor_whisper_finetuned2  = None
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

def _transcribe_whisper(wav_file, model, processor, verbose=False):
    start_time = time.time()

    try:
        if verbose: logging.debug(f"[_transcribe_whisper] model_loaded={model is not None} processor_loaded={processor is not None}")        

        if model and processor is not None:
            # Load audio
            waveform, sr = librosa.load(wav_file, sr=16000)    

            # Process features
            inputs = processor(waveform, sampling_rate=16000, return_tensors="pt")
            input_features = inputs.input_features.to(device, dtype=model.dtype)
            
            # Generate transcription
            with torch.no_grad(): predicted_ids = model.generate(input_features, language="it", task="transcribe")
            
            # Decode
            transcript_whisper = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
            end_time_whisper = time.time()

            # info
            if verbose:
                logging.info(f"[_transcribe_whisper] Whisper transcription took {end_time_whisper - start_time:.2f} seconds")
                logging.info(f"[_transcribe_whisper] Whisper transcription completed: {transcript_whisper}\n")
        
            # return
            return transcript_whisper
        
        else:
            logging.error(f"[_transcribe_whisper] Whisper model not loaded")
    
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
        "msg"   : "Hello world. I'm tester_model-server!",
        "usage" : "Send a POST request to /transcribe_all with a wav file. The response is in JSON format, with the following fields: transcript_whisper_vanilla, transcript_canary_vanilla, transcript_whisper_finetuned, transcript_canary_finetuned, transcript_mixer.",
    }

# transcribe_all
@app.post('/transcribe_all')
def transcribe_all(
        wav: UploadFile = File(...),
        verbose: bool = Query(False, description="If true, the server will print detailed logs during transcription")
    ):
    
    start_time = time.time()
    if verbose: logging.info(f"[transcribe_all] Received request. Processing...")
  
    try:
        # process input wav file
        wav_file = _process_wavfile(wav, verbose)

        # transcribe whisper vanilla
        try:
            transcript_whisper_vanilla  = _transcribe_whisper(wav_file, model_whisper_vanilla, processor_whisper_vanilla, verbose)
            if verbose: logging.info(f"[transcribe_all] transcript_whisper_vanilla: {transcript_whisper_vanilla}")
        except Exception as e:
            logging.error(f"[transcribe_all] Error during whisper vanilla transcription: {e}")
            transcript_whisper_vanilla = None

        # transcribe whisper finetuned1
        try:
            transcript_whisper_finetuned1  = _transcribe_whisper(wav_file, model_whisper_finetuned1, processor_whisper_finetuned1, verbose)
            if verbose: logging.info(f"[transcribe_all] transcript_whisper_finetuned1: {transcript_whisper_finetuned1}")
        except Exception as e:
            logging.error(f"[transcribe_all] Error during whisper finetuned1 transcription: {e}")
            transcript_whisper_finetuned1 = None

        # transcribe whisper finetuned2
        try:
            transcript_whisper_finetuned2  = _transcribe_whisper(wav_file, model_whisper_finetuned2, processor_whisper_finetuned2, verbose)
            if verbose: logging.info(f"[transcribe_all] transcript_whisper_finetuned2: {transcript_whisper_finetuned2}")
            
            # add LLM processing to whisper finetuned2 transcript
            #transcript_whisper_finetuned2_llm =_process_with_llm(transcript_whisper_finetuned2, verbose)
        except Exception as e:
            logging.error(f"[transcribe_all] Error during whisper finetuned2 transcription: {e}")
            transcript_whisper_finetuned2 = None
            transcript_whisper_finetuned2_llm = None
            
    except Exception as e:
        tb = traceback.format_exc()
        logging.error(f"[transcribe_all] Error during transcription: {e}")
        logging.error(f"[transcribe_all] Traceback:\n{tb}")
        return JSONResponse(content={"error": str(e), "traceback": tb}, status_code=500)
    
    #
    end_time = time.time()
    if verbose: logging.info(f"[transcribe_all] Finished transcription(s). Total required time: {end_time - start_time:.2f} seconds")

    # remove audio file
    try:                os.remove(wav_file)
    except Exception:   pass
    
    # return transcription
    #return PlainTextResponse(content=transcript_mixer)
    return JSONResponse(content={
        "transcript_whisper_vanilla":        transcript_whisper_vanilla,
        "transcript_whisper_finetuned1":     transcript_whisper_finetuned1,
        "transcript_whisper_finetuned2":     transcript_whisper_finetuned2,
    })

# process_with_llm
@app.post('/process_with_llm')
def process_with_llm(transcript: str = Body(...), verbose: bool = False):
    return PlainTextResponse(content=_process_with_llm(transcript, verbose))
# -----------------------------

#
if __name__ == "__main__":
    print(f"--------------------------------------------------------------------------")
    print(f"                   Hello world. I'm tester_model-server")
    print(f"--------------------------------------------------------------------------")
    
    uvicorn.run(app, host="0.0.0.0", port=http_port)
# -----------------------------