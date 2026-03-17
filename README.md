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

This bot joins a Discord voice channel, captures one spoken turn from the user who invoked `/listen`, transcribes it locally with Whisper, sends the transcript to a local `openclaw` CLI session, and plays the reply back with macOS `say`.

It is designed for personal or small trusted setups, not as a polished hosted service.

## What it does

- `/join` connects to your current voice channel and creates a fresh OpenClaw voice session for that joined channel
- `/listen` captures one spoken turn from the invoking user, sends it to OpenClaw, and plays one spoken reply
- `/leave` disconnects the bot from voice
- `/info` shows dependency health and current in-memory session status
- `/ping` provides a simple health check

## Scope

- Self-hosted only
- Environment-sensitive: depends on local binaries, PATH, voice state, and Discord runtime conditions
- Text-to-speech is macOS-only in the current implementation because playback is generated with `say`
- End-to-end voice receive still needs manual smoke testing in a real Discord voice channel

## Requirements

- macOS with `say`
- Node.js 20+
- `ffmpeg`
- `whisper-cli`
- `openclaw`
- Whisper model at `models/ggml-base.bin`
- Discord bot credentials for a single guild setup

At startup the bot checks:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `openclaw`, `ffmpeg`, `whisper-cli`, `say`
- the Whisper model at `models/ggml-base.bin`

## Configuration

Required environment variables:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`

Notes:

- The bot derives the Discord application id from the logged-in bot session, so `DISCORD_CLIENT_ID` is no longer required.
- Local `.env` values override exported shell variables to avoid accidentally reusing an old `DISCORD_TOKEN` from another project or terminal session.

Optional text-to-speech settings:

- `TTS_VOICE`: macOS `say` voice name, default `Flo`
- `TTS_RATE`: macOS `say` speaking rate, default `220`

## Quick start

```bash
git clone https://github.com/jx-grxf/OpenClaw-Discord-Voice.git
cd OpenClaw-Discord-Voice
npm install
cp .env.example .env
npm run dev
```

More details:

- `docs/INSTALLATION.md`
- `docs/USAGE.md`

## Architecture

1. Receive a Discord slash command
2. Read audio from the invoking user in the voice channel
3. Decode Opus to PCM
4. Convert PCM to WAV with `ffmpeg`
5. Transcribe WAV with `whisper-cli`
6. Send the transcript to the OpenClaw gateway `agent` method with the active voice `sessionKey`
7. Generate speech with `say` and play it in Discord

## Session behavior

- The bridge keeps one active voice session per guild while the bot is connected.
- `/join` immediately creates a fresh OpenClaw session for that active voice connection.
- `/listen` reuses that active session for follow-up turns until `/leave`.
- `/leave` disconnects the bot and asks OpenClaw to delete/archive that voice session.
- Whether that session appears in `openclaw sessions` is determined by the local OpenClaw runtime, not guaranteed by this bridge alone.

## Known limitations

- macOS only for TTS in the current version because it shells out to `say`
- Discord voice receive is sensitive to real runtime conditions such as who is speaking, mute/deafen state, push-to-talk or voice activity, and channel permissions
- Session continuity depends on the local OpenClaw runtime and what it returns; this repo does not manage or persist OpenClaw sessions itself
- End-to-end validation is still primarily a manual smoke test in a live Discord voice channel
