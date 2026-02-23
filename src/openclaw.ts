import { spawn } from 'node:child_process';

export async function askOpenClaw(transcript: string, sessionId: string, mode: 'talk' | 'action'): Promise<string> {
  const t = transcript.trim();
  if (!t) return 'Ich habe leider nichts verstanden. Versuch es bitte nochmal.';

  const prompt = [
    'Du bist Claw im Voice-Bridge-Modus.',
    `Aktueller Modus: ${mode === 'action' ? 'ACTION' : 'TALK'}.`,
    mode === 'action'
      ? 'ACTION-Regel: Behandle die nächste Nutzeräußerung als echten Auftrag. Nutze verfügbare Tools, um die Aktion wirklich auszuführen. Behaupte NIEMALS Erfolg ohne Ausführung. Wenn etwas fehlschlägt, sag klar was fehlgeschlagen ist.'
      : 'TALK-Regel: Nur normal antworten, keine Tools ausführen.',
    'Antwortstil: Deutsch, natürlich, kurz (max. 2 Sätze), keine Markdown-Formatierung.',
    '',
    `Nutzeräußerung: ${t}`,
  ].join('\n');

  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn('openclaw', [
      'agent',
      '--session-id',
      sessionId,
      '--thinking',
      'off',
      '--message',
      prompt,
      '--json',
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`openclaw agent exited with code ${code}: ${stderr}`));
      resolve(stdout);
    });
  });

  try {
    const data = JSON.parse(raw) as {
      result?: { payloads?: Array<{ text?: string | null }>; meta?: { summaryText?: string } };
      summary?: string;
    };

    const text = data?.result?.payloads?.find((p) => (p.text ?? '').trim().length > 0)?.text?.trim();
    if (text) return text;

    const fallback = data?.result?.meta?.summaryText || data?.summary;
    if (fallback?.trim()) return fallback.trim();
    return 'Ich habe gerade keine gute Antwort bekommen. Versuch es bitte nochmal.';
  } catch {
    return 'Antwort konnte nicht geparst werden. Versuch es bitte nochmal.';
  }
}

export async function listOpenClawSessions(): Promise<Array<{ sessionId: string; key: string; kind: string; ageMs: number }>> {
  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn('openclaw', ['sessions', '--json']);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`openclaw sessions failed (${code}): ${stderr}`));
      resolve(stdout);
    });
  });

  const parsed = JSON.parse(raw) as {
    sessions?: Array<{ sessionId?: string; key?: string; kind?: string; ageMs?: number }>;
  };

  return (parsed.sessions ?? [])
    .filter((s) => !!s.sessionId && !!s.key)
    .map((s) => ({ sessionId: s.sessionId!, key: s.key!, kind: s.kind ?? 'unknown', ageMs: s.ageMs ?? 0 }))
    .sort((a, b) => a.ageMs - b.ageMs);
}

