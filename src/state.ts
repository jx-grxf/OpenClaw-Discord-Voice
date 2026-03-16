export type VoiceSessionState = {
  sessionKey: string;
  openClawSessionId: string | null;
  initializedAt: number | null;
  lastUsedAt: number | null;
};

const activeSessionByUser = new Map<string, VoiceSessionState>();

function buildVoiceSessionKey(guildId: string, discordUserId: string): string {
  return `discord-voice-${guildId}-${discordUserId}`;
}

export function getOrCreateVoiceSession(
  guildId: string,
  discordUserId: string,
): { session: VoiceSessionState; created: boolean } {
  const existing = activeSessionByUser.get(discordUserId);
  if (existing) return { session: existing, created: false };

  const session: VoiceSessionState = {
    sessionKey: buildVoiceSessionKey(guildId, discordUserId),
    openClawSessionId: null,
    initializedAt: null,
    lastUsedAt: null,
  };

  activeSessionByUser.set(discordUserId, session);
  return { session, created: true };
}

export function markVoiceSessionUsed(
  discordUserId: string,
  updates: { openClawSessionId?: string | null; sessionKey?: string | null; initialized?: boolean } = {},
): VoiceSessionState | null {
  const session = activeSessionByUser.get(discordUserId);
  if (!session) return null;

  session.lastUsedAt = Date.now();

  if (typeof updates.sessionKey === 'string' && updates.sessionKey.trim()) {
    session.sessionKey = updates.sessionKey.trim();
  }

  if (typeof updates.openClawSessionId === 'string' && updates.openClawSessionId.trim()) {
    session.openClawSessionId = updates.openClawSessionId.trim();
  }

  if (updates.initialized && !session.initializedAt) {
    session.initializedAt = Date.now();
  }

  return session;
}

export function getVoiceSession(discordUserId: string): VoiceSessionState | null {
  return activeSessionByUser.get(discordUserId) ?? null;
}
