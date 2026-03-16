# OpenClaw Discord Voice Bridge

Simple Discord voice bridge for OpenClaw.

The bot joins your voice channel, captures one spoken turn from the user who invoked `/listen`, transcribes it locally with Whisper, sends the transcript to OpenClaw through a real CLI session, and plays the reply back in the channel.

Each Discord user gets a stable voice session key. The real OpenClaw session is created on the first successful `/listen` turn and then reused for later turns.

## Commands

- `/ping` - simple health check
- `/join` - join your current voice channel and prepare your voice session key
- `/listen` - capture one spoken turn, send it to OpenClaw, and play the reply
- `/leave` - disconnect the bot from voice
- `/info` - show bridge status, session status, and dependency health

## Simplifications kept on purpose

- No talk/action modes
- No Discord UI for session selection
- No special voice-bridge prompt injected into OpenClaw
- `/listen` simply sends the transcript as a normal `openclaw agent` turn

## Requirements

- macOS with `say`
- Node.js 20+
- `ffmpeg`
- `whisper-cli`
- `openclaw`
- Whisper model at `models/ggml-base.bin`
- Discord bot credentials for one guild setup

At startup the bot checks:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `openclaw`, `ffmpeg`, `whisper-cli`, `say`
- the Whisper model at `models/ggml-base.bin`

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
6. Send the transcript to `openclaw agent --session-id ... --message ... --json`
7. Generate speech with `say` and play it in Discord

## Notes

- Session continuity is per Discord user while the bot process stays alive.
- `/join` prepares the stable session key, but the real OpenClaw session appears only after the first successful `/listen`.
- End-to-end Discord voice capture is still a manual smoke test; see `docs/USAGE.md`.
