import { randomUUID } from 'node:crypto';
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

type OpenClawGatewayResponse = {
  ok?: boolean;
  key?: string;
  deleted?: boolean;
  archived?: string[];
  entry?: {
    sessionId?: string;
  };
  result?: OpenClawResult;
  summary?: string;
  text?: string;
  outputText?: string;
  sessionId?: string;
  sessionKey?: string;
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

export type OpenClawSessionRef = {
  sessionKey: string;
  sessionId?: string | null;
};

export type OpenClawBootstrapResult = {
  sessionKey: string;
  sessionId: string | null;
};

export type OpenClawDeleteResult = {
  deleted: boolean;
  archived: string[];
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

function parseGatewayResponse(raw: string): OpenClawGatewayResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as OpenClawGatewayResponse;
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

function runOpenClawGatewayCall(
  method: string,
  params: Record<string, unknown>,
  options: { expectFinal?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = ['gateway', 'call', method, '--json', '--params', JSON.stringify(params)];
    if (options.expectFinal) args.push('--expect-final');
    if (typeof options.timeoutMs === 'number') args.push('--timeout', String(options.timeoutMs));

    const proc = spawn('openclaw', args);

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
}

export function buildOpenClawAgentParams(transcript: string, session: OpenClawSessionRef): Record<string, unknown> {
  return {
    idempotencyKey: `discord-voice-${randomUUID()}`,
    message: transcript.trim(),
    sessionKey: session.sessionKey.trim(),
    sessionId: session.sessionId?.trim() || undefined,
    thinking: 'off',
  };
}

export function buildOpenClawSessionResetParams(sessionKey: string): Record<string, unknown> {
  return {
    key: sessionKey.trim(),
    reason: 'new',
  };
}

export function buildOpenClawSessionDeleteParams(sessionKey: string): Record<string, unknown> {
  return {
    key: sessionKey.trim(),
    deleteTranscript: true,
  };
}

export async function createOpenClawSession(sessionKey: string): Promise<OpenClawBootstrapResult> {
  const raw = await runOpenClawGatewayCall('sessions.reset', buildOpenClawSessionResetParams(sessionKey), {
    timeoutMs: 30_000,
  });
  const data = parseGatewayResponse(raw);
  if (!data?.ok) {
    throw new Error('OpenClaw did not confirm session creation.');
  }

  return {
    sessionKey: firstNonEmpty([data.key, data.sessionKey, sessionKey]) ?? sessionKey,
    sessionId: firstNonEmpty([data.entry?.sessionId, data.sessionId, data.meta?.sessionId]),
  };
}

export async function deleteOpenClawSession(
  sessionKey: string,
  options: { timeoutMs?: number } = {},
): Promise<OpenClawDeleteResult> {
  const raw = await runOpenClawGatewayCall('sessions.delete', buildOpenClawSessionDeleteParams(sessionKey), {
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const data = parseGatewayResponse(raw);
  if (!data?.ok) {
    throw new Error('OpenClaw did not confirm session deletion.');
  }

  return {
    deleted: Boolean(data.deleted),
    archived: data.archived ?? [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deleteOpenClawSessionWithRetry(
  sessionKey: string,
  options: { attempts?: number; timeoutMs?: number; backoffMs?: number } = {},
): Promise<OpenClawDeleteResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const backoffMs = options.backoffMs ?? 1_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await deleteOpenClawSession(sessionKey, { timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(backoffMs * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('OpenClaw session deletion failed.');
}

export async function askOpenClaw(transcript: string, session: OpenClawSessionRef): Promise<OpenClawTurnResult> {
  const message = transcript.trim();
  if (!message) {
    return {
      reply: 'I could not understand anything yet. Please try again.',
      sessionKey: session.sessionKey,
      sessionId: session.sessionId ?? null,
    };
  }

  const raw = await runOpenClawGatewayCall('agent', buildOpenClawAgentParams(message, session), {
    expectFinal: true,
    timeoutMs: 600_000,
  });

  const reply = extractOpenClawReply(raw);
  if (!reply) {
    throw new Error('OpenClaw returned no usable reply.');
  }

  return {
    reply,
    sessionKey: extractOpenClawSessionKey(raw) ?? session.sessionKey,
    sessionId: extractOpenClawSessionId(raw) ?? session.sessionId ?? null,
  };
}
