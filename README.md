# OpenClaw Discord Voice Assistant

Ein Discord-Bot, der Sprache aus einem Voice Channel aufnimmt, lokal transkribiert (Whisper), OpenClaw befragt und die Antwort wieder als Stimme im Channel abspielt.

## Features

- Slash Commands:
  - `/ping` → Bot-Healthcheck
  - `/join` → Session-Auswahl (neu oder bestehend) + Talk/Action Mode
  - `/listen` → Sprache aufnehmen, transkribieren, OpenClaw fragen, Antwort abspielen
  - `/leave` → Voice Channel verlassen
- **Talk Mode**: Nur normale Antworten (keine Tool-Ausführung)
- **Action Mode**: OpenClaw darf echte Aktionen/Tools ausführen
- Lokale Speech-to-Text mit `whisper-cli`
- Lokale Text-to-Speech mit macOS `say`

---

## Voraussetzungen

- macOS (wegen `say`)
- Node.js 20+
- ffmpeg
- whisper.cpp CLI (`whisper-cli`)
- OpenClaw CLI (`openclaw`)
- Discord Bot Token + App Setup

### 1) System-Tools installieren

```bash
brew install ffmpeg
brew install whisper-cpp
```

OpenClaw CLI muss ebenfalls installiert und im PATH verfügbar sein.

---

## Installation

```bash
git clone https://github.com/<DEIN-USERNAME>/OpenClaw-Discord-Voice.git
cd OpenClaw-Discord-Voice
npm install
```

### 2) Whisper-Modell herunterladen

Lege das Modell nach `models/ggml-base.bin`.

Ordnerstruktur:

```text
models/
└── ggml-base.bin
```

### 3) `.env` anlegen

```env
DISCORD_TOKEN=dein_bot_token
DISCORD_CLIENT_ID=deine_application_id
DISCORD_GUILD_ID=deine_server_id
DISCORD_USER_ID=deine_discord_user_id
```

**Hinweis:** Aktuell wird beim Listen gezielt `DISCORD_USER_ID` abonniert.

---

## Discord Setup (kurz)

1. Im [Discord Developer Portal](https://discord.com/developers/applications) App erstellen
2. Bot erstellen + Token kopieren
3. Unter OAuth2 URL für den Bot generieren (Scopes: `bot`, `applications.commands`)
4. Bot auf deinen Server einladen
5. Bot braucht Voice- und Senderechte im Zielserver

---

## Starten

### Development

```bash
npm run dev
```

### Production Build

```bash
npm run build
npm start
```

Beim Start werden die Slash-Commands für die Guild registriert.

---

## Nutzung

1. In Discord in einen Voice Channel gehen
2. `/join` ausführen
3. Session wählen (neu oder bestehend)
4. Modus wählen:
   - **Talk Mode**
   - **Action Mode**
5. `/listen` ausführen und sprechen
6. Antwort wird als Text + Audio geliefert

---

## Projektstruktur

```text
src/index.ts       # Hauptlogik (Discord + Audio + OpenClaw Bridge)
dist/              # Build-Output
tmp/               # Temporäre Audiodateien/Transkripte
models/            # Whisper-Modell
```

---

## Troubleshooting

### `whisper-cli` not found

```bash
which whisper-cli
```

Falls leer: `brew install whisper-cpp`.

### `ffmpeg` not found

```bash
which ffmpeg
```

Falls leer: `brew install ffmpeg`.

### Bot reagiert nicht auf Slash Commands

- Stimmt `DISCORD_GUILD_ID`?
- Bot neu starten (Commands werden beim Start registriert)
- Prüfen, ob Bot auf dem Server ist

### Keine/fehlerhafte Audioausgabe

- Prüfen ob `say` auf macOS verfügbar ist
- Voice-Rechte des Bots prüfen

---

## Sicherheit

- `.env` niemals committen
- Tokens regelmäßig rotieren
- Action Mode nur in vertrauenswürdigen Umgebungen verwenden

---

## Lizenz

Private Nutzung / nach Bedarf anpassen.
