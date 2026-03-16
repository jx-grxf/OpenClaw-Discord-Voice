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
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`

`DISCORD_USER_ID` is no longer needed. The bridge always captures the user who invoked `/listen`.

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
