# OpenClaw Discord Voice Assistant

Voice bridge between Discord and OpenClaw.

This bot joins a Discord voice channel, records speech, transcribes it locally with Whisper, sends the prompt to OpenClaw, and plays the response back as synthesized voice.

## Highlights

- Discord slash commands for voice workflow
- Session-aware OpenClaw integration
- Two operation modes:
  - **Talk Mode** (conversation only)
  - **Action Mode** (OpenClaw may execute tools)
- Local speech-to-text (Whisper via `whisper-cli`)
- Local text-to-speech on macOS (`say`)

## Commands

- `/ping` — health check
- `/join` — join voice + choose session + choose mode
- `/listen` — record, transcribe, query OpenClaw, play reply
- `/leave` — disconnect bot from voice channel
- `/info` — show bot stats/status (basic, extendable)

## Architecture (high-level)

1. Discord interaction received
2. Voice stream captured from configured speaker
3. Opus → PCM → WAV conversion (`ffmpeg`)
4. Transcription (`whisper-cli` + model file)
5. OpenClaw request (`openclaw agent --json`)
6. TTS generation (`say`)
7. Audio playback into Discord voice channel

## Requirements

- macOS (currently required because of `say`)
- Node.js 20+
- `ffmpeg`
- `whisper-cli` (from `whisper-cpp`)
- OpenClaw CLI (`openclaw`) configured on host
- Discord bot credentials

## Quick Start

```bash
git clone https://github.com/jx-grxf/OpenClaw-Discord-Voice.git
cd OpenClaw-Discord-Voice
npm install
cp .env.example .env
# fill .env values
npm run dev
```

For full setup details, see:
- `docs/INSTALLATION.md`
- `docs/USAGE.md`

## OpenClaw References

- Docs: <https://docs.openclaw.ai>
- GitHub: <https://github.com/openclaw/openclaw>
- Community: <https://discord.com/invite/clawd>

## Repository Layout

```text
src/index.ts          # Main bot logic
package.json          # Scripts and dependencies
tsconfig.json         # TypeScript config
docs/                 # Installation/usage docs
```

## Security Notes

- Never commit `.env`
- Rotate Discord and OpenClaw credentials if leaked
- Use **Action Mode** only in trusted environments
- Review `SECURITY.md` before public deployment

## Public Readiness Status

- ✅ `.env` excluded from git
- ✅ Large model binaries excluded from git (`models/*.bin`)
- ✅ Setup docs + usage docs added
- ⚠️ Known limitation: speaker capture uses `DISCORD_USER_ID` targeting

## License

MIT (see `LICENSE`).
