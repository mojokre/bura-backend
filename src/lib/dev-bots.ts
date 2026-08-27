/** Temporary dev bots for local 2v2 layout testing. */
export const SIM_BOT_PREFIX = "dev_bot_sim_";

export function isSimBotUserId(userId: string): boolean {
  return userId.startsWith(SIM_BOT_PREFIX);
}

export function makeSimBotIds(tableId: string): [string, string, string] {
  const safe = tableId.replace(/[^a-zA-Z0-9_]/g, "_");
  return [
    `${SIM_BOT_PREFIX}${safe}_1`,
    `${SIM_BOT_PREFIX}${safe}_2`,
    `${SIM_BOT_PREFIX}${safe}_3`,
  ];
}

export function simBotProfile(userId: string, displayIndex: number) {
  return {
    userId,
    username: `ბოტ ${displayIndex}`,
    iconUrl: "",
  };
}
