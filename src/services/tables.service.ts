import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { makeSimBotIds } from "../lib/dev-bots.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { emitBroadcast, emitToUser } from "../realtime/gateway.js";
import { getProfileIconUrl } from "./profile.service.js";
import {
  createBuraLiveRoom,
  destroyBuraLiveRoom,
  getBuraLiveRoom,
} from "./bura-room.service.js";
import {
  malyutkaModeLabelKa,
  tableRulesSchema,
  type MalyutkaMode,
  type TableMode,
} from "../game/bura/table-rules.js";

export type GameType = "bura";

export const DEFAULT_PUBLIC_TABLE_IDS = {
  "1v1": {
    turn: "default_bura_1v1",
    anytime: "default_bura_1v1_anytime",
  },
  "2v2": {
    turn: "default_bura_2v2",
    anytime: "default_bura_2v2_anytime",
  },
} as const;

const MAX_PLAYERS_2V2 = 4;
const MAX_PLAYERS_1V1 = 2;

const DEFAULT_MALYUTKA_MODES: MalyutkaMode[] = ["turn", "anytime"];
const DEFAULT_TABLE_MODES: TableMode[] = ["1v1", "2v2"];

const DEFAULT_PUBLIC_TABLES: Array<{
  id: string;
  mode: TableMode;
  malyutkaMode: MalyutkaMode;
  matchTo: number;
  maxPlayers: number;
  label: string;
}> = DEFAULT_TABLE_MODES.flatMap((mode) =>
  DEFAULT_MALYUTKA_MODES.map((malyutkaMode) => {
    const maxPlayers = mode === "1v1" ? MAX_PLAYERS_1V1 : MAX_PLAYERS_2V2;
    const malyutkaShort = malyutkaMode === "turn" ? "რიგით" : "ურიგოდ";
    const id =
      malyutkaMode === "turn"
        ? DEFAULT_PUBLIC_TABLE_IDS[mode].turn
        : DEFAULT_PUBLIC_TABLE_IDS[mode].anytime;
    return {
      id,
      mode,
      malyutkaMode,
      matchTo: 11,
      maxPlayers,
      label: `${mode} · ${malyutkaShort} · 11`,
    };
  }),
);

export type PublicTable = {
  id: string;
  game: GameType;
  label: string;
  hostId: string;
  playersCount: number;
  maxPlayers: number;
  malyutkaMode: MalyutkaMode;
  matchTo: number;
  mode: TableMode;
  isDefault?: boolean;
  joinedUsers: Array<{
    id: string;
    username: string;
    iconUrl: string;
  }>;
};

type TableMember = { id: string; username: string; iconUrl: string };

type PublicTableMeta = {
  id: string;
  game: GameType;
  hostId: string;
  label: string;
  maxPlayers: number;
  malyutkaMode: MalyutkaMode;
  matchTo: number;
  mode: TableMode;
  createdAt: number;
  isDefault?: boolean;
};

type LiveRoom = {
  roomId: string;
  tableId: string;
  game: GameType;
  createdAt: number;
};

const joinParamsSchema = z.object({
  tableId: z.string().min(1),
});

const createPublicSchema = tableRulesSchema;

const liveRooms = new Map<string, LiveRoom>();
const publicTables = new Map<string, PublicTableMeta>();
const tableMembers = new Map<string, Map<string, TableMember>>();
const waitingTableByUser = new Map<string, string>();
/** Live Bura match room ids only — not public-table lobby seats. */
const currentRoomByUser = new Map<string, string>();

function ensureDefaultPublicTables() {
  for (const d of DEFAULT_PUBLIC_TABLES) {
    if (!publicTables.has(d.id)) {
      publicTables.set(d.id, {
        id: d.id,
        game: "bura",
        hostId: "system",
        label: d.label,
        maxPlayers: d.maxPlayers,
        malyutkaMode: d.malyutkaMode,
        matchTo: d.matchTo,
        mode: d.mode,
        createdAt: 0,
        isDefault: true,
      });
    } else {
      const meta = publicTables.get(d.id)!;
      meta.isDefault = true;
      meta.label = d.label;
      meta.malyutkaMode = d.malyutkaMode;
      meta.matchTo = d.matchTo;
      meta.mode = d.mode;
      meta.maxPlayers = d.maxPlayers;
    }
    if (!tableMembers.has(d.id)) {
      tableMembers.set(d.id, new Map());
    }
  }
}

/** Seed permanent lobby tables on server boot. */
export function initDefaultPublicTables() {
  ensureDefaultPublicTables();
}

function getTableMembers(tableId: string): TableMember[] {
  return Array.from(tableMembers.get(tableId)?.values() ?? []);
}

function serializePublicTable(meta: PublicTableMeta): PublicTable {
  const joined = getTableMembers(meta.id);
  return {
    id: meta.id,
    game: meta.game,
    label: meta.label,
    hostId: meta.hostId,
    maxPlayers: meta.maxPlayers,
    playersCount: joined.length,
    malyutkaMode: meta.malyutkaMode,
    matchTo: meta.matchTo,
    mode: meta.mode,
    isDefault: meta.isDefault,
    joinedUsers: joined,
  };
}

export function getPublicTables(
  game: GameType,
  mode?: TableMode,
): PublicTable[] {
  ensureDefaultPublicTables();
  return Array.from(publicTables.values())
    .filter((t) => t.game === game)
    .filter((t) => (mode ? t.mode === mode : true))
    .sort((a, b) => {
      if (Boolean(a.isDefault) !== Boolean(b.isDefault)) {
        return a.isDefault ? -1 : 1;
      }
      if (a.isDefault && b.isDefault) {
        if (a.malyutkaMode !== b.malyutkaMode) {
          return a.malyutkaMode === "turn" ? -1 : 1;
        }
      }
      return b.createdAt - a.createdAt;
    })
    .map(serializePublicTable);
}

async function resolveUser(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .eq("id", userId)
    .single<{ id: string; username: string; icon_path?: string | null }>();

  if (error || !data) {
    throw new AppError(404, "PROFILE_NOT_FOUND", "მომხმარებელი ვერ მოიძებნა.");
  }

  return {
    id: data.id,
    username: data.username,
    iconUrl: await getProfileIconUrl(data.username, data.icon_path),
  };
}

function leaveWaitingTable(userId: string): GameType | null {
  const tableId = waitingTableByUser.get(userId);
  if (!tableId) return null;

  waitingTableByUser.delete(userId);
  const members = tableMembers.get(tableId);
  members?.delete(userId);

  const meta = publicTables.get(tableId);
  if (members && members.size === 0) {
    tableMembers.set(tableId, new Map());
    if (meta && !meta.isDefault) {
      publicTables.delete(tableId);
      tableMembers.delete(tableId);
    }
  } else if (members && meta && meta.hostId === userId) {
    const nextHost = members.values().next().value as TableMember | undefined;
    if (nextHost) meta.hostId = nextHost.id;
  }

  return meta?.game ?? "bura";
}

function notifyTablesUpdated(...games: Array<GameType | null | undefined>) {
  const unique = new Set(games.filter((game): game is GameType => Boolean(game)));
  for (const game of unique) {
    emitBroadcast("tables:updated", { game });
  }
}

function assertNotInLiveGame(userId: string) {
  const liveRoomId = currentRoomByUser.get(userId);
  if (liveRoomId && getBuraLiveRoom(liveRoomId)) {
    throw new AppError(
      409,
      "ALREADY_IN_GAME",
      "ჯერ დაასრულე მიმდინარე თამაში.",
    );
  }
}

export async function createPublicTable(userId: string, body: unknown) {
  const parsed = createPublicSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "აირჩიე მალიუტკა რეჟიმი და ქულა 3–11.",
    );
  }

  ensureDefaultPublicTables();
  assertNotInLiveGame(userId);
  leaveWaitingTable(userId);

  try {
    const { leavePrivateLobbyIfAny } = await import("./friends-table.service.js");
    leavePrivateLobbyIfAny(userId);
  } catch {
    // ignore
  }

  const user = await resolveUser(userId);
  const { malyutkaMode, matchTo, mode } = parsed.data;
  const tableMode: TableMode = mode === "1v1" ? "1v1" : "2v2";
  const maxPlayers =
    tableMode === "1v1" ? MAX_PLAYERS_1V1 : MAX_PLAYERS_2V2;
  const tableId = `pub_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const modeLabel = tableMode === "1v1" ? "1v1" : "2v2";
  const label = `${modeLabel} · ${malyutkaModeLabelKa(malyutkaMode)} · ${matchTo}`;

  const meta: PublicTableMeta = {
    id: tableId,
    game: "bura",
    hostId: user.id,
    label,
    maxPlayers,
    malyutkaMode,
    matchTo,
    mode: tableMode,
    createdAt: Date.now(),
    isDefault: false,
  };
  publicTables.set(tableId, meta);

  const members = new Map<string, TableMember>();
  members.set(user.id, user);
  tableMembers.set(tableId, members);
  waitingTableByUser.set(user.id, tableId);

  notifyTablesUpdated("bura");
  emitBroadcast("presence:updated", {});

  return {
    table: serializePublicTable(meta),
    roomId: null,
    started: false as const,
  };
}

export async function joinPublicTable(userId: string, tableId: string) {
  const parsed = joinParamsSchema.safeParse({ tableId });
  if (!parsed.success) {
    throw new AppError(400, "INVALID_TABLE", "არასწორი მაგიდა.");
  }

  ensureDefaultPublicTables();

  const table = publicTables.get(tableId);
  if (!table) {
    throw new AppError(404, "TABLE_NOT_FOUND", "მაგიდა ვერ მოიძებნა.");
  }

  const user = await resolveUser(userId);
  const members = tableMembers.get(tableId) ?? new Map<string, TableMember>();

  if (members.has(user.id)) {
    const liveRoomId = currentRoomByUser.get(user.id);
    if (liveRoomId && getBuraLiveRoom(liveRoomId)) {
      return { roomId: liveRoomId, started: true };
    }
    return { roomId: null, started: false };
  }

  assertNotInLiveGame(user.id);
  const leftGame = leaveWaitingTable(user.id);

  if (members.size >= table.maxPlayers) {
    notifyTablesUpdated(leftGame);
    throw new AppError(409, "TABLE_FULL", "მაგიდა სავსეა.");
  }

  members.set(user.id, user);
  tableMembers.set(tableId, members);
  waitingTableByUser.set(user.id, tableId);

  let started = false;
  let liveRoomId: string | null = null;

  if (members.size >= table.maxPlayers && table.game === "bura") {
    const userIds = Array.from(members.keys());
    liveRoomId = `live_${tableId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

    await createBuraLiveRoom({
      roomId: liveRoomId,
      game: "bura",
      userIds,
      matchTo: table.matchTo,
      malyutkaMode: table.malyutkaMode,
      mode: table.mode,
    });

    liveRooms.set(liveRoomId, {
      roomId: liveRoomId,
      tableId,
      game: table.game,
      createdAt: Date.now(),
    });

    for (const memberId of userIds) {
      waitingTableByUser.delete(memberId);
      currentRoomByUser.set(memberId, liveRoomId);
      emitToUser(memberId, "public-table:started", {
        roomId: liveRoomId,
        tableId,
      });
    }

    tableMembers.set(tableId, new Map());
    started = true;
  }

  notifyTablesUpdated(table.game, leftGame);
  emitBroadcast("presence:updated", {});
  return { roomId: liveRoomId, started };
}

/** Dev-only: start a 2v2 match with the caller + 3 sim bots. */
export async function simulate2v2WithBots(userId: string, tableId: string) {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_BOT_SIM !== "1") {
    throw new AppError(403, "BOT_SIM_DISABLED", "ბოტ სიმულაცია გამორთულია.");
  }

  const parsed = joinParamsSchema.safeParse({ tableId });
  if (!parsed.success) {
    throw new AppError(400, "INVALID_TABLE", "არასწორი მაგიდა.");
  }

  ensureDefaultPublicTables();

  const table = publicTables.get(tableId);
  if (!table) {
    throw new AppError(404, "TABLE_NOT_FOUND", "მაგიდა ვერ მოიძებნა.");
  }
  if (table.mode !== "2v2") {
    throw new AppError(400, "NOT_2V2", "ბოტ სიმულაცია მხოლოდ 2v2-ზეა.");
  }
  if (table.game !== "bura") {
    throw new AppError(400, "INVALID_GAME", "არასწორი თამაში.");
  }

  await resolveUser(userId);
  assertNotInLiveGame(userId);
  const leftGame = leaveWaitingTable(userId);

  const botIds = makeSimBotIds(tableId);
  const userIds = [userId, ...botIds];
  const liveRoomId = `live_sim_${tableId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  await createBuraLiveRoom({
    roomId: liveRoomId,
    game: "bura",
    userIds,
    matchTo: table.matchTo,
    malyutkaMode: table.malyutkaMode,
    mode: "2v2",
  });

  liveRooms.set(liveRoomId, {
    roomId: liveRoomId,
    tableId,
    game: table.game,
    createdAt: Date.now(),
  });

  currentRoomByUser.set(userId, liveRoomId);
  emitToUser(userId, "public-table:started", { roomId: liveRoomId, tableId });
  notifyTablesUpdated(table.game, leftGame);
  emitBroadcast("presence:updated", {});

  return { roomId: liveRoomId, started: true as const };
}

export async function leavePublicTable(userId: string, tableId: string) {
  const parsed = joinParamsSchema.safeParse({ tableId });
  if (!parsed.success) {
    throw new AppError(400, "INVALID_TABLE", "არასწორი მაგიდა.");
  }

  ensureDefaultPublicTables();

  const table = publicTables.get(tableId);
  if (!table) {
    leaveWaitingTable(userId);
    return { ok: true as const };
  }

  if (waitingTableByUser.get(userId) !== tableId) {
    return { ok: true as const };
  }

  leaveWaitingTable(userId);
  notifyTablesUpdated(table.game);
  emitBroadcast("presence:updated", {});
  return { ok: true as const };
}

export function leavePublicTableIfAny(userId: string) {
  const leftGame = leaveWaitingTable(userId);
  if (leftGame) notifyTablesUpdated(leftGame);
}

export function registerUsersInGameRoom(input: {
  roomId: string;
  tableId: string;
  game: GameType;
  userIds: string[];
}) {
  liveRooms.set(input.roomId, {
    roomId: input.roomId,
    tableId: input.tableId,
    game: input.game,
    createdAt: Date.now(),
  });

  for (const userId of input.userIds) {
    leaveWaitingTable(userId);
    currentRoomByUser.set(userId, input.roomId);
  }
}

export function getUsersInGameRoom(roomId: string): string[] {
  return Array.from(currentRoomByUser.entries())
    .filter(([, id]) => id === roomId)
    .map(([userId]) => userId);
}

/**
 * One player leaving dissolves the whole live match:
 * everyone is cleared from the room and notified.
 * The public lobby table slot stays available for the next group.
 */
export function leaveGameRoom(userId: string) {
  const roomId = currentRoomByUser.get(userId);
  if (!roomId) return { ok: true as const, dissolved: false as const };

  const liveRoom = liveRooms.get(roomId);
  const memberIds = getUsersInGameRoom(roomId);
  const hadLiveMatch = Boolean(getBuraLiveRoom(roomId));

  for (const memberId of memberIds) {
    currentRoomByUser.delete(memberId);
  }

  liveRooms.delete(roomId);
  if (liveRoom) notifyTablesUpdated(liveRoom.game);

  destroyBuraLiveRoom(roomId);
  emitBroadcast("presence:updated", {});

  return {
    ok: true as const,
    dissolved: true as const,
    roomId,
    memberIds,
    leftUserId: userId,
    hadLiveMatch,
  };
}

/**
 * Match finished normally: free all members without the
 * "player left" notification so their statuses return to normal.
 */
export function dissolveFinishedGameRoom(roomId: string) {
  const liveRoom = liveRooms.get(roomId);
  const memberIds = getUsersInGameRoom(roomId);

  for (const memberId of memberIds) {
    currentRoomByUser.delete(memberId);
  }

  liveRooms.delete(roomId);
  if (liveRoom) notifyTablesUpdated(liveRoom.game);

  destroyBuraLiveRoom(roomId);
  emitBroadcast("presence:updated", {});
}

export function isUserInPublicTable(userId: string) {
  return waitingTableByUser.has(userId);
}

export function isUserInGame(userId: string) {
  if (waitingTableByUser.has(userId)) return true;
  const roomId = currentRoomByUser.get(userId);
  return Boolean(roomId && getBuraLiveRoom(roomId));
}

export function getUserGameRoomId(userId: string) {
  return currentRoomByUser.get(userId) ?? null;
}

/**
 * Room id only when a live Bura match is still playable.
 * Lobby seats and finished matches must NOT redirect /main → /table
 * (finished would flash winners ↔ ad gate).
 */
export function getActiveLiveGameRoomId(userId: string) {
  const roomId = currentRoomByUser.get(userId);
  if (!roomId) return null;
  const live = getBuraLiveRoom(roomId);
  if (!live) return null;
  if (live.match.status === "finished") return null;
  return roomId;
}
