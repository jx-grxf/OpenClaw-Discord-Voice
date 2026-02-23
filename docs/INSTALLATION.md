# Installation Guide

## 1) System dependencies

```bash
brew install ffmpeg whisper-cpp
```

Verify:

```bash
which ffmpeg
which whisper-cli
which openclaw
```

## 2) Clone and install Node dependencies

```bash
git clone https://github.com/jx-grxf/OpenClaw-Discord-Voice.git
cd OpenClaw-Discord-Voice
npm install
```

## 3) Configure environment

Create `.env` from template:

```bash
cp .env.example .env
```

Fill values:

- `DISCORD_TOKEN` — bot token
- `DISCORD_CLIENT_ID` — Discord application ID
- `DISCORD_GUILD_ID` — target server ID
- `DISCORD_USER_ID` — currently captured speaker user ID

## 4) Download Whisper model

Place model at:

```text
models/ggml-base.bin
```

## 5) Run

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

On startup, guild slash commands are registered automatically.
