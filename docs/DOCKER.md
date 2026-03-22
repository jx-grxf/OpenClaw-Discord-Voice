# Docker – Testing on Linux (without a macOS VM)

This guide explains how to run the OpenClaw Discord Voice bridge inside a **Linux Docker container** on your Mac.
This is the recommended way to test the installation on a clean system without setting up a full macOS VM.

---

## Overview

The Docker image:

- is built on **Node.js 20 (Debian Slim)**
- compiles **whisper-cli** from [whisper.cpp](https://github.com/ggerganov/whisper.cpp) during the image build
- installs **ffmpeg** via apt
- builds the TypeScript app

Two things you must supply at runtime because they cannot be bundled:

| Dependency | Why external | How to provide |
|---|---|---|
| `openclaw` binary | proprietary / host-installed | mount from host (see below) |
| Whisper model file | large binary, download separately | volume-mount `./models/` |
| ElevenLabs credentials | macOS `say` is not available in Linux | set in `.env` |

---

## Requirements

- [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/) (or OrbStack / Colima)
- A `.env` file derived from `.env.example`
- A Whisper model binary at `models/ggml-base.bin`
- ElevenLabs account with `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`
- A working local `openclaw` installation on your Mac (for full functionality)

---

## Quick start

### 1. Configure the environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-guild-id
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=your-api-key
ELEVENLABS_VOICE_ID=your-voice-id
```

> `TTS_PROVIDER=elevenlabs` is required because macOS `say` is not available on Linux.

### 2. Download a Whisper model

```bash
mkdir -p models
curl -L \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" \
  -o models/ggml-base.bin
```

### 3. Mount openclaw (optional but needed for full functionality)

Find where `openclaw` is installed on your Mac:

```bash
which openclaw
```

Then uncomment and adjust the volume line in `docker-compose.yml`:

```yaml
volumes:
  - /usr/local/bin/openclaw:/usr/local/bin/openclaw:ro
```

> If `openclaw` is not yet available, you can still start the bot and run `/info`, `/help`,
> and `/ping` – only `/join` and `/listen` will fail because they call the `openclaw` CLI.

### 4. Build the image

The first build compiles whisper.cpp from source, which takes a few minutes.

```bash
docker compose build
```

To use a specific whisper.cpp version (default is `v1.7.4`):

```bash
docker compose build --build-arg WHISPER_CPP_TAG=v1.7.4
```

### 5. Run the bot

```bash
docker compose up
```

Or in detached mode:

```bash
docker compose up -d
docker compose logs -f
```

### 6. Run the health check inside the container

```bash
docker compose run --rm bot node -e \
  "require('./dist/doctor.js')"
```

Or for full doctor output:

```bash
docker compose run --rm bot npm run doctor:bridge
```

---

## File layout

```
OpenClaw-Discord-Voice/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env                   ← your local credentials (not committed)
├── models/
│   └── ggml-base.bin      ← Whisper model (not committed)
└── tmp/                   ← temporary audio files (created at runtime)
```

---

## Troubleshooting

### `say: not found` at startup

Set `TTS_PROVIDER=elevenlabs` in `.env`.

### `openclaw: not found` when running `/join` or `/listen`

Uncomment the `openclaw` volume line in `docker-compose.yml` and make sure the host path is correct.

### `whisper-cli: not found` or transcription errors

The image builds `whisper-cli` from source during `docker compose build`.
If the build fails, try a different whisper.cpp tag:

```bash
docker compose build --build-arg WHISPER_CPP_TAG=v1.7.2
```

### Model file missing

Make sure `models/ggml-base.bin` exists on the host before starting the container.
The `models/` directory is volume-mounted read-only into the container.

### Permission errors on `tmp/`

Docker creates `./tmp` as root on first run. Fix with:

```bash
mkdir -p tmp && chmod 755 tmp
```

---

## Notes

- The Docker image does **not** include `say`, so `TTS_PROVIDER=say` will fail.
  Always use `TTS_PROVIDER=elevenlabs` inside Docker.
- Voice receive still depends on real Discord runtime conditions; end-to-end smoke testing
  requires an actual Discord voice call.
- The `models/` and `tmp/` directories are volume-mounted so they survive container restarts.
