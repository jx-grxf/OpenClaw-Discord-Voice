import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnection,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { getWhisperModelPath } from './diagnostics.js';

export type TtsProvider = 'say' | 'elevenlabs';

export async function convertPcmToWav(pcmPath: string, wavPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', pcmPath,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      wavPath,
      '-y',
    ]);
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
}

export function createRequestTempDir(): string {
  const root = path.resolve(process.cwd(), 'tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'listen-'));
}

export async function removeRequestTempDir(dirPath: string): Promise<void> {
  await fs.promises.rm(dirPath, { recursive: true, force: true });
}

export function getWhisperThreadCount(): number {
  const raw = Number(process.env.WHISPER_THREADS ?? '');
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.max(1, Math.floor(raw));
  }

  return Math.max(1, Math.min(8, os.availableParallelism?.() ?? 4));
}

export function buildWhisperCliArgs(modelPath: string, wavPath: string, transcriptBasePath: string): string[] {
  const language = process.env.WHISPER_LANGUAGE?.trim().toLowerCase() || 'auto';

  return [
    '-m', modelPath,
    '-f', wavPath,
    '-otxt',
    '-of', transcriptBasePath,
    '-l', language,
    '-t', String(getWhisperThreadCount()),
    '-np',
    '-nt',
  ];
}

export async function transcribeWav(wavPath: string, transcriptBasePath: string): Promise<string> {
  const modelPath = getWhisperModelPath();
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model missing: ${modelPath}`);

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('whisper-cli', buildWhisperCliArgs(modelPath, wavPath, transcriptBasePath), {
      cwd: process.cwd(),
    });

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper-cli exited with code ${code}: ${stderr}`));
      const txtPath = `${transcriptBasePath}.txt`;
      if (!fs.existsSync(txtPath)) return resolve('');
      resolve(fs.readFileSync(txtPath, 'utf8').trim());
    });
  });
}

function getTtsVoice(): string {
  return process.env.TTS_VOICE?.trim() || 'Flo';
}

function getTtsRate(): string {
  const raw = process.env.TTS_RATE?.trim();
  return raw && /^\d+$/.test(raw) ? raw : '220';
}

export function getTtsProvider(): TtsProvider {
  return process.env.TTS_PROVIDER?.trim().toLowerCase() === 'elevenlabs' ? 'elevenlabs' : 'say';
}

function getElevenLabsApiKey(): string {
  const value = process.env.ELEVENLABS_API_KEY?.trim();
  if (!value) {
    throw new Error('ELEVENLABS_API_KEY is required when TTS_PROVIDER=elevenlabs.');
  }
  return value;
}

function getElevenLabsVoiceId(): string {
  const value = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!value) {
    throw new Error('ELEVENLABS_VOICE_ID is required when TTS_PROVIDER=elevenlabs.');
  }
  return value;
}

function getElevenLabsModelId(): string {
  return process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2';
}

function getElevenLabsOutputFormat(): string {
  return process.env.ELEVENLABS_OUTPUT_FORMAT?.trim() || 'mp3_44100_128';
}

export function getTtsOutputExtension(): string {
  return getTtsProvider() === 'elevenlabs' ? 'mp3' : 'aiff';
}

export async function synthesizeWithSay(text: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('say', ['-v', getTtsVoice(), '-r', getTtsRate(), '-o', outPath, text]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`say exited with code ${code}: ${stderr || 'no additional details'}`));
    });
  });
}

export async function synthesizeWithElevenLabs(text: string, outPath: string): Promise<void> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(getElevenLabsVoiceId())}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': getElevenLabsApiKey(),
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: getElevenLabsModelId(),
      output_format: getElevenLabsOutputFormat(),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed with status ${response.status}: ${detail || 'no additional details'}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(outPath, audioBuffer);
}

export async function synthesizeSpeech(text: string, outPath: string): Promise<void> {
  if (getTtsProvider() === 'elevenlabs') {
    await synthesizeWithElevenLabs(text, outPath);
    return;
  }

  await synthesizeWithSay(text, outPath);
}

export async function playAudioFile(connection: VoiceConnection, filePath: string): Promise<void> {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const resource = createAudioResource(filePath);
  connection.subscribe(player);

  await new Promise<void>((resolve, reject) => {
    player.once('error', reject);
    player.once(AudioPlayerStatus.Idle, () => resolve());
    player.play(resource);
  });
}
