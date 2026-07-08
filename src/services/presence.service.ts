const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const lastSeen = new Map<string, number>();

export function markUserActive(userId: string) {
  lastSeen.set(userId, Date.now());
}

export function isUserActive(userId: string) {
  const seen = lastSeen.get(userId);
  if (!seen) return false;
  return Date.now() - seen <= ACTIVE_WINDOW_MS;
}

