import { spawn } from 'node:child_process';

type OpenClawPayload = {
  text?: string | null;
  content?: string | null;
};

type OpenClawResult = {
  payloads?: OpenClawPayload[];
  outputText?: string;
  text?: string;
  sessionId?: string;
  sessionKey?: string;
  key?: string;
  meta?: {
    summaryText?: string;
    sessionId?: string;
    sessionKey?: string;
  };
};

type OpenClawResponse = {
  result?: OpenClawResult;
  summary?: string;
  text?: string;
  outputText?: string;
  sessionId?: string;
  sessionKey?: string;
  key?: string;
  meta?: {
    sessionId?: string;
    sessionKey?: string;
  };
};

export type OpenClawTurnResult = {
  reply: string;
  sessionKey: string;
  sessionId: string | null;
};

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function parseOpenClawResponse(raw: string): OpenClawResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as OpenClawResponse;
  } catch {
    return null;
  }
}

export function extractOpenClawReply(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const data = parseOpenClawResponse(trimmed);
  if (!data) return trimmed;

  return firstNonEmpty([
    data.result?.outputText,
    data.outputText,
    data.result?.text,
    data.text,
    ...(data.result?.payloads ?? []).flatMap((payload) => [payload.text, payload.content]),
    data.result?.meta?.summaryText,
    data.summary,
  ]);
}

export function extractOpenClawSessionId(raw: string): string | null {
  const data = parseOpenClawResponse(raw);
  if (!data) return null;

  return firstNonEmpty([
    data.result?.sessionId,
    data.sessionId,
    data.result?.meta?.sessionId,
  ]);
}

export function extractOpenClawSessionKey(raw: string): string | null {
  const data = parseOpenClawResponse(raw);
  if (!data) return null;

  return firstNonEmpty([
    data.result?.sessionKey,
    data.sessionKey,
    data.key,
    data.result?.key,
    data.result?.meta?.sessionKey,
  ]);
}

function formatCliError(stderr: string, code: number | null): string {
  const detail = stderr.trim() || 'no additional details';
  return `OpenClaw CLI failed (exit ${code ?? 'unknown'}): ${detail}`;
}

export async function askOpenClaw(transcript: string, sessionKey: string): Promise<OpenClawTurnResult> {
  const message = transcript.trim();
  if (!message) {
    return {
      reply: 'I could not understand anything yet. Please try again.',
      sessionKey,
      sessionId: null,
    };
  }

  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn('openclaw', [
      'agent',
      '--session-id',
      sessionKey,
      '--thinking',
      'off',
      '--message',
      message,
      '--json',
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => reject(new Error(`Could not start OpenClaw: ${error.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(formatCliError(stderr || stdout, code)));
        return;
      }
      resolve(stdout);
    });
  });

  const reply = extractOpenClawReply(raw);
  if (!reply) {
    throw new Error('OpenClaw returned no usable reply.');
  }

  return {
    reply,
    sessionKey: extractOpenClawSessionKey(raw) ?? sessionKey,
    sessionId: extractOpenClawSessionId(raw),
  };
}
