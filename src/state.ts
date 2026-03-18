import { randomUUID } from 'node:crypto';

export type VoiceSessionState = {
  channelId: string;
  createdAt: number;
  createdByUserId: string;
  sessionKey: string;
  openClawSessionId: string | null;
  initializedAt: number | null;
  lastUsedAt: number | null;
  listenMode: 'slash' | 'auto';
  autoListenTextChannelId: string | null;
  botSpeaking: boolean;
};

const activeSessionByGuild = new Map<string, VoiceSessionState>();
const activeListenByGuild = new Map<string, string>();
const activeJoinByGuild = new Map<string, string>();

function resolveOpenClawAgentId(): string {
  return process.env.OPENCLAW_AGENT_ID?.trim() || 'main';
}

export function buildVoiceSessionKey(guildId: string, channelId: string): string {
  return `agent:${resolveOpenClawAgentId()}:discord:voice:guild:${guildId}:channel:${channelId}:join:${randomUUID()}`;
}

export function createVoiceSession(
  guildId: string,
  channelId: string,
  discordUserId: string,
  sessionRef: { sessionKey?: string | null; openClawSessionId?: string | null } = {},
): VoiceSessionState {
  const session: VoiceSessionState = {
    channelId,
    createdAt: Date.now(),
    createdByUserId: discordUserId,
    sessionKey: sessionRef.sessionKey?.trim() || buildVoiceSessionKey(guildId, channelId),
    openClawSessionId: sessionRef.openClawSessionId?.trim() || null,
    initializedAt: null,
    lastUsedAt: null,
    listenMode: 'slash',
    autoListenTextChannelId: null,
    botSpeaking: false,
  };

  activeSessionByGuild.set(guildId, session);
  return session;
}

export function markVoiceSessionUsed(
  guildId: string,
  updates: { openClawSessionId?: string | null; sessionKey?: string | null; initialized?: boolean } = {},
): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
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

export function getVoiceSession(guildId: string): VoiceSessionState | null {
  return activeSessionByGuild.get(guildId) ?? null;
}

export function setVoiceSessionListenMode(
  guildId: string,
  mode: 'slash' | 'auto',
  options: { textChannelId?: string | null } = {},
): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return null;

  session.listenMode = mode;
  session.autoListenTextChannelId = mode === 'auto' ? options.textChannelId?.trim() || session.autoListenTextChannelId : null;
  return session;
}

export function setVoiceSessionBotSpeaking(guildId: string, speaking: boolean): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return null;

  session.botSpeaking = speaking;
  return session;
}

export function beginGuildJoin(guildId: string, discordUserId: string): { ok: boolean; activeUserId: string | null } {
  const activeUserId = activeJoinByGuild.get(guildId) ?? null;
  if (activeUserId) {
    return { ok: false, activeUserId };
  }

  activeJoinByGuild.set(guildId, discordUserId);
  return { ok: true, activeUserId };
}

export function endGuildJoin(guildId: string, discordUserId: string): void {
  if (activeJoinByGuild.get(guildId) === discordUserId) {
    activeJoinByGuild.delete(guildId);
  }
}

export function getActiveGuildJoinUser(guildId: string): string | null {
  return activeJoinByGuild.get(guildId) ?? null;
}

export function clearVoiceSession(guildId: string): VoiceSessionState | null {
  const existing = activeSessionByGuild.get(guildId) ?? null;
  activeSessionByGuild.delete(guildId);
  return existing;
}

export function beginGuildListen(guildId: string, discordUserId: string): { ok: boolean; activeUserId: string | null } {
  const activeUserId = activeListenByGuild.get(guildId) ?? null;
  if (activeUserId) {
    return { ok: false, activeUserId };
  }

  activeListenByGuild.set(guildId, discordUserId);
  return { ok: true, activeUserId };
}

export function endGuildListen(guildId: string, discordUserId: string): void {
  if (activeListenByGuild.get(guildId) === discordUserId) {
    activeListenByGuild.delete(guildId);
  }
}

export function getActiveGuildListenUser(guildId: string): string | null {
  return activeListenByGuild.get(guildId) ?? null;
}

export function clearAllVoiceState(): void {
  activeSessionByGuild.clear();
  activeListenByGuild.clear();
  activeJoinByGuild.clear();
}

export function listVoiceSessions(): Array<{ guildId: string; session: VoiceSessionState }> {
  return Array.from(activeSessionByGuild.entries()).map(([guildId, session]) => ({ guildId, session }));
}
