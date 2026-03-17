import dotenv from 'dotenv';
import https from 'node:https';
import { collectBridgeHealth } from './diagnostics.js';

dotenv.config({ override: true, quiet: true });

type DiscordAuthCheck = {
  ok: boolean;
  detail: string;
};

function checkDiscordAuth(token: string): Promise<DiscordAuthCheck> {
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
            resolve({ ok: true, detail: 'Discord bot auth succeeded.' });
            return;
          }

          resolve({
            ok: false,
            detail: `Discord auth failed with status ${res.statusCode ?? 'unknown'}: ${body || 'no response body'}`,
          });
        });
      },
    );

    req.on('error', (error) => {
      resolve({ ok: false, detail: `Discord auth request failed: ${error.message}` });
    });

    req.end();
  });
}

function printSection(title: string, lines: string[]) {
  console.log(`\n${title}`);
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

async function main() {
  const health = collectBridgeHealth(process.env);
  const token = process.env.DISCORD_TOKEN?.trim() || '';
  const discordAuth = token ? await checkDiscordAuth(token) : { ok: false, detail: 'DISCORD_TOKEN is missing.' };

  printSection(
    'Environment',
    health.env.map((item) => `${item.ok ? 'OK' : 'MISSING'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`),
  );
  printSection(
    'Binaries',
    health.binaries.map((item) => `${item.ok ? 'OK' : 'MISSING'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`),
  );
  printSection(
    'Assets',
    [`${health.whisperModel.ok ? 'OK' : 'MISSING'} ${health.whisperModel.name} (${health.whisperModel.detail})`],
  );
  printSection('Discord', [`${discordAuth.ok ? 'OK' : 'FAIL'} ${discordAuth.detail}`]);

  const hasFailures =
    health.env.some((item) => !item.ok) ||
    health.binaries.some((item) => !item.ok) ||
    !health.whisperModel.ok ||
    !discordAuth.ok;

  process.exitCode = hasFailures ? 1 : 0;
}

void main();
