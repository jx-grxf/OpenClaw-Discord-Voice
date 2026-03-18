 # Installation

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

- `TTS_VOICE` to choose the macOS `say` voice. Default: `Flo`
- `TTS_RATE` to set the macOS `say` speaking rate. Default: `220`

## 4) Place the Whisper model

Path:

```text
models/ggml-base.bin
```

If the file is missing, the bot stops with a clear startup error.

## 5) Start

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

## Known setup caveats

- Successful startup only confirms the expected env vars, binaries, and Whisper model are present.
- It does not prove Discord voice receive will work in your runtime environment.
- Real verification still requires a manual smoke test in a Discord voice channel; see `docs/USAGE.md`.
