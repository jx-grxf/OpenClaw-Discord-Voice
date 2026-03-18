import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REQUIRED_ENV_VARS = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID'] as const;
export const REQUIRED_BINARIES = ['openclaw', 'ffmpeg', 'whisper-cli', 'say'] as const;

export type HealthCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type BridgeHealth = {
  env: HealthCheck[];
  binaries: HealthCheck[];
  whisperModel: HealthCheck;
};

export function getWhisperModelPath(): string {
  return path.resolve(process.cwd(), 'models', 'ggml-base.bin');
}

function checkBinary(name: string): HealthCheck {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  if (result.status === 0) {
    return { name, ok: true, detail: result.stdout.trim() };
  }

  const stderr = (result.stderr || result.stdout || '').trim();
  return { name, ok: false, detail: stderr || 'not found in PATH' };
}

export function collectBridgeHealth(env: NodeJS.ProcessEnv = process.env): BridgeHealth {
  const envChecks = REQUIRED_ENV_VARS.map((name) => ({
    name,
    ok: Boolean(env[name]),
    detail: env[name] ? 'set' : 'missing',
  }));

  const binaryChecks = REQUIRED_BINARIES.map((name) => checkBinary(name));
  const modelPath = getWhisperModelPath();
  const whisperModel = {
    name: 'Whisper model',
    ok: fs.existsSync(modelPath),
    detail: fs.existsSync(modelPath) ? modelPath : `missing: ${modelPath}`,
  };

  return {
    env: envChecks,
    binaries: binaryChecks,
    whisperModel,
  };
}

export function checkDiscordBotAuth(token: string): Promise<HealthCheck> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'discord.com',
        path: '/api/v10/users/@me',
        method: 'GET',
        headers: { Authorization: `Bot ${token}` },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ name: 'Discord bot auth', ok: true, detail: 'succeeded' });
            return;
          }

          resolve({
            name: 'Discord bot auth',
            ok: false,
            detail: `failed with status ${res.statusCode ?? 'unknown'}: ${body || 'no response body'}`,
          });
        });
      },
    );

    req.on('error', (error) => {
      resolve({ name: 'Discord bot auth', ok: false, detail: `request failed: ${error.message}` });
    });

    req.end();
  });
}

export function summarizeHealthIssues(health: BridgeHealth): string[] {
  return [...health.env, ...health.binaries, health.whisperModel].filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`);
}

export function assertStartupReadiness(env: NodeJS.ProcessEnv = process.env): void {
  const issues = summarizeHealthIssues(collectBridgeHealth(env));
  if (issues.length === 0) return;

  throw new Error(`Startup checks failed:\n- ${issues.join('\n- ')}`);
}
