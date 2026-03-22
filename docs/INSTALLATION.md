# Installation

> **Want to test on a clean system without a macOS VM?**
> Use Docker instead – see [docs/DOCKER.md](DOCKER.md) for a Linux container setup that runs on any Mac with Docker Desktop.

## 1) Install system dependencies

```bash
brew install ffmpeg whisper-cpp
```

Check them:

```bash
which ffmpeg
which whisper-cli
which openclaw
which say
```

`openclaw` must already be installed and working locally.

Recommended:

- install OpenClaw first from the official repo: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- confirm `openclaw gateway call agent --help` or at least `openclaw --help` works before starting this bot

This project currently assumes macOS because reply audio is generated with `say`. Linux and Windows are not documented or supported as-is.

## 2) Clone the repo and install Node dependencies

```bash
git clone https://github.com/jx-grxf/OpenClaw-Discord-Voice.git
cd OpenClaw-Discord-Voice
npm install
```

## 3) Configure the environment

Create `.env`:

```bash
cp .env.example .env
```

Set:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`

Optional:

- `TTS_PROVIDER` to choose `say` or `elevenlabs`. Default: `say`
- `TTS_VOICE` to choose the macOS `say` voice. Default: `Flo`
- `TTS_RATE` to set the macOS `say` speaking rate. Default: `220`
- `ELEVENLABS_API_KEY` if you use `TTS_PROVIDER=elevenlabs`
- `ELEVENLABS_VOICE_ID` if you use `TTS_PROVIDER=elevenlabs`
- `ELEVENLABS_MODEL_ID` optional, default `eleven_multilingual_v2`
- `ELEVENLABS_OUTPUT_FORMAT` optional, default `mp3_44100_128`
- `WHISPER_MODEL_PATH` optional, default `models/ggml-base.bin`
- `WHISPER_LANGUAGE` optional, default `auto`; use `de` or `en` to force one language
- `WHISPER_THREADS` optional; use it if you want to give `whisper-cli` more CPU threads
- `VOICE_NO_AUDIO_TIMEOUT_MS` optional, default `12000`
- `VOICE_NO_SPEECH_TIMEOUT_MS` optional, default `5000`
- `VOICE_MAX_CAPTURE_MS` optional, default `9000`

## 4) Place the Whisper model

Path:

```text
models/ggml-base.bin
```

Expected filename in this repo:

- `models/ggml-base.bin`

How to get it:

- download or build a Whisper model compatible with `whisper-cli`
- place it at exactly `models/ggml-base.bin`
- if you prefer another file, rename or copy it to that path for this project

If the file is missing, the bot stops with a clear startup error.

## 5) Start

Run a quick health check first:

```bash
npm run doctor:bridge
```

Development:

```bash
npm run dev
```

Build + start:

```bash
npm run build
npm start
```

The bot registers guild slash commands automatically on startup.

## TTS providers

Default:

- `TTS_PROVIDER=say`
- local macOS voice via `say`

Optional:

- `TTS_PROVIDER=elevenlabs`
- requires `ELEVENLABS_API_KEY`
- requires `ELEVENLABS_VOICE_ID`
- does not require the local `say` binary for startup checks

## Speech-to-text tuning

Recommended for better accuracy:

- point `WHISPER_MODEL_PATH` to a stronger Whisper model if your machine can handle it
- leave `WHISPER_LANGUAGE=auto` if you switch between German and English
- set `WHISPER_LANGUAGE=de` or `WHISPER_LANGUAGE=en` only if you want to optimize for one language

## Known setup caveats

- Successful startup only confirms the expected env vars, binaries, and Whisper model are present.
- It does not prove Discord voice receive will work in your runtime environment.
- Real verification still requires a manual smoke test in a Discord voice channel; see `docs/USAGE.md`.
- `/help` in Discord is the easiest way to discover commands, info, and doctor output after startup.
