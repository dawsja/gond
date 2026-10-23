export function botHome(botId: string) {
  return `.bots/${botId}`;
}

export function memoryPath(botId: string) {
  return `${botHome(botId)}/MEMORY.md`;
}

export function soulPath(botId: string) {
  return `${botHome(botId)}/SOUL.md`;
}

export function teamDir(userId: string) {
  return `.team/${userId}`;
}

export function teamMemoryPath(userId: string) {
  return `${teamDir(userId)}/MEMORY.md`;
}

export const LEGACY_TEAM_MEMORY_PATH = ".team/MEMORY.md";

export const MAX_MEMORY_BYTES = 24 * 1024;
