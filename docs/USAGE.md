# Usage

This bridge is best treated as an experimental self-hosted tool. The happy path is short, but real voice capture depends on Discord runtime conditions and local machine setup.

## Normal flow

1. Join a Discord voice channel.
2. Run `/join`.
3. Run `/listen` and speak after the bot says it is listening.
4. The bot transcribes the turn, sends it to OpenClaw, and plays the spoken reply.

## Commands

- `/join` - join your voice channel and prepare your stable voice session key
- `/listen` - process exactly one spoken turn from the invoking user
- `/leave` - disconnect the voice connection
- `/info` - show voice status, in-memory session status, and dependency health
- `/ping` - simple reachability check

## Session behavior

- Each Discord user gets one deterministic OpenClaw session key per guild.
- `/join` only prepares that key inside the bridge.
- The first successful `openclaw agent --session-id <key>` turn is what may cause OpenClaw to create or reuse a backing session.
- Later `/listen` calls reuse the same key and continue that context if the local OpenClaw runtime honors it.
- After a bot restart, the bridge rebuilds state in memory as users interact again.
- Do not assume that a prepared key or even a successful turn will always produce a visibly listed session in `openclaw sessions`; that depends on OpenClaw behavior outside this repo.

## Known limitations

- Reply playback is macOS-only because TTS uses `say`.
- Voice receive is sensitive to mute/deafen state, push-to-talk or voice activity, channel permissions, and when the speaker starts talking.
- `/listen` is a one-turn interaction, not a continuous streaming conversation mode.
- End-to-end validation remains a manual smoke test, not a fully automated integration test.

## Troubleshooting

### `/join` or `/listen` fails immediately

- Make sure you are in a voice channel.
- Run `/info` and check for missing dependencies.

### `/listen` says no voice signal was received

- Start speaking only after the `/listen` prompt appears.
- Check Discord input settings, voice activity, and push-to-talk.
- Confirm your client is not muted and is actually transmitting audio.
- Confirm the bot can stay undeafened in the channel and has the expected voice permissions.
- Check the bot logs for `Speaking started`, `SSRC mapped`, and `First opus packet received`.

### No transcription

- Check that `models/ggml-base.bin` exists.
- Check that `whisper-cli` is in `PATH`.
- Check that `ffmpeg` is in `PATH`.

### No OpenClaw reply

- Check locally that `openclaw agent --help` works.
- Confirm the local OpenClaw gateway and agent setup are healthy.
- Check `/info` for the session key and any returned session id.
- If you also inspect `openclaw sessions`, treat that as a local OpenClaw diagnostic, not as a guarantee provided by this bridge.

### No playback

- Check the bot's voice-channel permissions.
- Check that `say` works on macOS with your chosen `TTS_VOICE` and `TTS_RATE`.

## Smoke test checklist

This is still a manual end-to-end check:

1. Run `npm run build`.
2. Run `npm start`.
3. In Discord, run `/info` and confirm all dependencies show as `OK`.
4. Join a normal voice channel and run `/join`.
5. Confirm `/join` shows an OpenClaw key and says the real session is only exercised on first successful listen.
6. Run `/listen`, wait for the prompt, then speak one short sentence.
7. Confirm the reply shows your transcript and an OpenClaw key, plus a session id if the CLI returns one.
8. Optionally run `openclaw sessions` locally, but treat session visibility there as an OpenClaw-side observation rather than a bridge guarantee.
9. Run `/listen` again and confirm the reply still uses the same OpenClaw key and behaves consistently in your local setup.
