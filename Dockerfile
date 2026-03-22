# ─── Stage 1: Build whisper-cli from whisper.cpp ─────────────────────────────
FROM debian:bookworm-slim AS whisper-build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      git \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG WHISPER_CPP_TAG=v1.7.4

RUN git clone --depth 1 --branch "${WHISPER_CPP_TAG}" \
      https://github.com/ggerganov/whisper.cpp /whisper.cpp && \
    cmake -B /whisper.cpp/build -S /whisper.cpp \
      -DCMAKE_BUILD_TYPE=Release \
      -DWHISPER_BUILD_TESTS=OFF && \
    cmake --build /whisper.cpp/build --target whisper-cli -j"$(nproc)" && \
    cp /whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli

# ─── Stage 2: Build the Node.js app ──────────────────────────────────────────
FROM node:20-slim AS app-build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Stage 3: Runtime image ───────────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# whisper-cli compiled in stage 1
COPY --from=whisper-build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli

WORKDIR /app

COPY --from=app-build /app/dist ./dist
COPY --from=app-build /app/node_modules ./node_modules
COPY package*.json ./

# Create writable directories for models and temp audio files
RUN mkdir -p models tmp

# macOS `say` is not available on Linux.
# Set TTS_PROVIDER=elevenlabs in your .env (or docker-compose environment) and
# supply ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID before starting the bot.
#
# openclaw must be supplied at runtime – see docs/DOCKER.md.

CMD ["node", "dist/index.js"]
