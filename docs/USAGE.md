# Usage Guide

## Typical workflow

1. Join a Discord voice channel
2. Run `/join`
3. Choose:
   - new or existing OpenClaw session
   - Talk Mode or Action Mode
4. Run `/listen` and speak
5. Bot transcribes, queries OpenClaw, and replies in voice

## Modes

### Talk Mode
OpenClaw should respond conversationally and avoid tool execution.

### Action Mode
OpenClaw is allowed to execute tools. Use this only in trusted channels/servers.

## Commands

- `/ping` — check bot status
- `/join` — initialize voice/session/mode
- `/listen` — process one spoken utterance
- `/leave` — disconnect from voice
- `/info` — bot metadata/status endpoint (currently basic)

## Troubleshooting

### Slash commands not visible
- Verify `DISCORD_GUILD_ID`
- Restart bot to re-register commands
- Check bot invite includes `applications.commands`

### No transcription
- Check model path: `models/ggml-base.bin`
- Confirm `whisper-cli` exists in PATH

### No playback
- Confirm bot has voice permissions
- Confirm `say` is available on host macOS

### Command/tool failures
- Ensure OpenClaw CLI is installed and authenticated/configured
- Verify host machine can run `openclaw agent --json`
