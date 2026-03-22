<div align="center">

# 🎙️ OpenClaw Discord Voice Bridge

**Experimental, self-hosted Discord voice bridge for OpenClaw**

![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-14-5865F2?logo=discord&logoColor=white)
![Whisper](https://img.shields.io/badge/Whisper-STT-412991?logo=openai&logoColor=white)
![ffmpeg](https://img.shields.io/badge/ffmpeg-audio-007808?logo=ffmpeg&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-TTS-000000?logo=apple&logoColor=white)
![dotenv](https://img.shields.io/badge/dotenv-config-ECD53F?logo=dotenv&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

OpenClaw Discord Voice Bridge connects a Discord voice channel to a local OpenClaw session: it captures one spoken turn, transcribes it locally, sends the transcript to OpenClaw, and plays the reply back into the channel.

It is built for self-hosted, personal, or small trusted setups, not as a polished hosted SaaS product.

---

## Contents

- [Highlights](#-highlights)
- [Scope](#-scope)
- [Tech Stack](#-tech-stack)
- [Requirements](#-requirements)
- [Quick Start](#-quick-start)
- [Docker (test without a macOS VM)](#-docker--test-without-a-macos-vm)
- [Configuration](#-configuration)
- [Commands](#-commands)
- [Scripts](#-scripts)
- [Architecture](#-architecture)
- [Session Behavior](#-session-behavior)
- [Known Limitations](#-known-limitations)

---

## ✨ Highlights

| | Feature |
|---|---|
| 🎙️ | Discord slash-command voice bridge for local OpenClaw sessions |
| 🧠 | Local speech-to-text with Whisper CLI |
| 🔊 | Switchable TTS: macOS `say` or ElevenLabs |
| 🧵 | Optional verbose thread for tool calls and background execution details |
| 🩺 | Built-in health check via `npm run doctor:bridge` and `/info` |
| 🧪 | Debug helper `/debugtext` for text-only session testing |

---

## 🌍 Scope

- **Self-hosted only**
- **Environment-sensitive**: depends on local binaries, PATH, macOS runtime, Discord voice state, and your local OpenClaw setup
- **Best for trusted setups** rather than public multi-tenant hosting
- **Live voice behavior still needs real smoke testing** in an actual Discord call

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Bot runtime** | Node.js 20, TypeScript, Discord.js 14 |
| **Voice pipeline** | Discord Voice, Opus decode, PCM → WAV via `ffmpeg` |
| **Speech-to-text** | `whisper-cli` with local GGML models |
| **OpenClaw bridge** | local `openclaw` CLI + gateway |
| **Text-to-speech** | macOS `say` or ElevenLabs |

---

## 📋 Requirements

- **macOS** with `say`
- **Node.js** `20+`
- **openclaw**
- **ffmpeg**
- **whisper-cli**
- Whisper model at `models/ggml-base.bin` or another configured path
- Discord bot credentials for a single-guild setup

At startup the bot checks:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `openclaw`
- `ffmpeg`
- `whisper-cli`
- `say`
- the configured Whisper model path

---

## 🚀 Quick Start

```bash
git clone https://github.com/jx-grxf/OpenClaw-Discord-Voice.git
cd OpenClaw-Discord-Voice
npm install
cp .env.example .env
npm run doctor:bridge
npm run dev
```

Before the bot can actually start, you still need:

- a working local `openclaw` installation
- `ffmpeg`, `whisper-cli`, and macOS `say`
- a Whisper model file in `models/`
- valid `DISCORD_TOKEN` and `DISCORD_GUILD_ID` values in `.env`

More details:

- [docs/INSTALLATION.md](docs/INSTALLATION.md)
- [docs/USAGE.md](docs/USAGE.md)

---

## 🐳 Docker – test without a macOS VM

If you want to test the installation on a clean system without setting up a macOS VM, use Docker.
A `Dockerfile` and `docker-compose.yml` are included.

```bash
cp .env.example .env   # set TTS_PROVIDER=elevenlabs and ElevenLabs credentials
docker compose build   # compiles whisper-cli, installs ffmpeg, builds the app
docker compose up
```

Full instructions: [docs/DOCKER.md](docs/DOCKER.md)

---

## ⚙️ Configuration

### Required

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_GUILD_ID` | Guild where slash commands are registered |

### Voice and TTS

| Variable | Purpose |
|---|---|
| `TTS_PROVIDER` | `say` or `elevenlabs`, default `say` |
| `TTS_VOICE` | macOS `say` voice, default `Flo` |
| `TTS_RATE` | macOS `say` rate, default `220` |
| `ELEVENLABS_API_KEY` | Required for `TTS_PROVIDER=elevenlabs` |
| `ELEVENLABS_VOICE_ID` | Required for `TTS_PROVIDER=elevenlabs` |
| `ELEVENLABS_MODEL_ID` | Optional, default `eleven_multilingual_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | Optional, default `mp3_44100_128` |

### Speech Recognition

| Variable | Purpose |
|---|---|
| `WHISPER_MODEL_PATH` | Model path, default `models/ggml-base.bin` |
| `WHISPER_LANGUAGE` | `auto`, `de`, or `en` |
| `WHISPER_THREADS` | Optional manual CPU tuning |
| `VOICE_NO_AUDIO_TIMEOUT_MS` | Timeout before giving up on no audio |
| `VOICE_NO_SPEECH_TIMEOUT_MS` | Timeout for unclear/background-only speech |
| `VOICE_MAX_CAPTURE_MS` | Hard cap for one captured turn |

### Notes

- `DISCORD_CLIENT_ID` is **not required** anymore; the bot derives the application id from the logged-in client session.
- Local `.env` values override exported shell variables so the repo does not accidentally pick up credentials from another terminal session.

---

## 🧭 Commands

| Command | Description |
|---|---|
| `/join` | Join your current voice channel and prepare or reuse the active OpenClaw voice session |
| `/listen` | Capture one spoken turn and send it to OpenClaw |
| `/leave` | Disconnect the bot and request OpenClaw session cleanup |
| `/voice-verbose` | Enable a separate Discord thread for tool calls and background execution details |
| `/debugtext` | Send plain text directly into the active voice session for debugging |
| `/info` | Show diagnostics, session state, talk mode, TTS, and bridge status |
| `/help` | Open the interactive help menu |
| `/ping` | Simple health check |

---

## 📜 Scripts

Run from the repository root:

| Command | Description |
|---|---|
| `npm run dev` | Start the bot in development mode |
| `npm run build` | Type-check and build the project |
| `npm test` | Run the test suite |
| `npm run doctor:bridge` | Check env, binaries, model path, and Discord auth |

---

## 🧠 Architecture

1. Receive a Discord slash command
2. Read audio from the invoking user in the voice channel
3. Decode Opus to PCM
4. Convert PCM to WAV with `ffmpeg`
5. Transcribe WAV with `whisper-cli`
6. Send the transcript to OpenClaw with the active voice `sessionKey`
7. Generate speech with the selected TTS provider and play it back in Discord

---

## 🔄 Session Behavior

- The bridge keeps **one active voice session per guild** while the bot stays connected.
- `/join` creates or reuses the active OpenClaw voice session for that voice connection.
- `/listen` reuses that session for follow-up turns until `/leave`.
- `/leave` disconnects the bot and asks OpenClaw to delete/archive the session.
- Whether the session still appears inside `openclaw sessions` depends on the local OpenClaw runtime and cleanup success, not just the Discord bridge.

---

## ⚠️ Known Limitations

- `say` is **macOS-only**
- Discord voice receive is sensitive to real runtime conditions such as mute/deafen state, permissions, push-to-talk, and who is speaking
- Session continuity still depends on what the local OpenClaw runtime returns
- End-to-end validation is still primarily a **manual live Discord smoke test**
