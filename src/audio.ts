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

export async function convertPcmToWav(pcmPath: string, wavPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmPath, wavPath, '-y']);
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
}

export async function transcribeWav(wavPath: string): Promise<string> {
  const modelPath = path.resolve(process.cwd(), 'models', 'ggml-base.bin');
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model missing: ${modelPath}`);

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('whisper-cli', ['-m', modelPath, '-f', wavPath, '-l', 'de', '-otxt', '-of', 'tmp/transcript'], {
      cwd: process.cwd(),
    });

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper-cli exited with code ${code}: ${stderr}`));
      const txtPath = path.resolve(process.cwd(), 'tmp', 'transcript.txt');
      if (!fs.existsSync(txtPath)) return resolve('');
      resolve(fs.readFileSync(txtPath, 'utf8').trim());
    });
  });
}

export async function synthesizeWithSay(text: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('say', ['-v', 'Anna', '-o', outPath, text]);
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`say exited with code ${code}`))));
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

