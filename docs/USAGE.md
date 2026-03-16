# Usage

## Normal flow

1. Join a Discord voice channel.
2. Run `/join`.
3. Run `/listen` and speak after the bot says it is listening.
4. The bot transcribes the turn, sends it to OpenClaw, and plays the spoken reply.

## Commands

- `/join` - join your voice channel and prepare your stable voice session key
- `/listen` - process exactly one spoken turn from the invoking user
- `/leave` - disconnect the voice connection
- `/info` - show voice status, real session status, and dependency health
- `/ping` - simple reachability check

## Session behavior

- Each Discord user gets one stable OpenClaw session key.
- The real OpenClaw session is created by the first successful `openclaw agent --session-id <key>` turn.
- Later `/listen` calls reuse the same key and continue that session context.
- After a bot restart, the in-memory user-to-session mapping starts over, but the same deterministic key is used again for that user in that guild.

## Troubleshooting

### `/join` or `/listen` fails immediately

- Make sure you are in a voice channel.
- Run `/info` and check for missing dependencies.

### `/listen` says no voice signal was received

- Start speaking only after the `/listen` prompt appears.
- Check Discord input settings, voice activity, and push-to-talk.
- Confirm the bot can stay undeafened in the channel.
- Check the bot logs for `Speaking started`, `SSRC mapped`, and `First opus packet received`.

### No transcription

- Check that `models/ggml-base.bin` exists.
- Check that `whisper-cli` is in `PATH`.
- Check that `ffmpeg` is in `PATH`.

### No OpenClaw reply

- Check locally that `openclaw agent --help` works.
- Confirm the local OpenClaw gateway and agent setup are healthy.
- Run `/info` or `openclaw sessions` after a successful turn to verify the session is visible.

### No playback

- Check the bot's voice-channel permissions.
- Check that `say` works on macOS.

## Smoke test checklist

This is still a manual end-to-end check:

1. Run `npm run build`.
2. Run `npm start`.
3. In Discord, run `/info` and confirm all dependencies show as `OK`.
4. Join a normal voice channel and run `/join`.
5. Confirm `/join` shows an OpenClaw key and says the real session will be created on first successful listen.
6. Run `/listen`, wait for the prompt, then speak one short sentence.
7. Confirm the reply shows your transcript and an OpenClaw key, plus a session id if the CLI returns one.
8. Run `openclaw sessions` locally and confirm the session is visible after the successful turn.
9. Run `/listen` again and confirm the reply still uses the same OpenClaw key and keeps context.
