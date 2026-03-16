import fs from 'node:fs';
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

export async function convertPcmToWav(pcmPath: string, wavPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmPath, wavPath, '-y']);
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

export async function transcribeWav(wavPath: string, transcriptBasePath: string): Promise<string> {
  const modelPath = getWhisperModelPath();
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model missing: ${modelPath}`);

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('whisper-cli', ['-m', modelPath, '-f', wavPath, '-otxt', '-of', transcriptBasePath], {
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
