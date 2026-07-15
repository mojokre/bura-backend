import { z } from "zod";
import { AppError } from "../lib/errors.js";
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
};

type Room = {
  roomId: string;
  tableId: string;
  game: GameType;
  createdAt: number;
};

const MAX_PLAYERS_2V2 = 4;
const MAX_PLAYERS_1V1 = 2;

const joinParamsSchema = z.object({
  tableId: z.string().min(1),
});

const createPublicSchema = tableRulesSchema;

const rooms = new Map<string, Room>();
const publicTables = new Map<string, PublicTableMeta>();
const tableMembers = new Map<string, Map<string, TableMember>>();
const currentRoomByUser = new Map<string, string>();

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
    joinedUsers: joined,
  };
}

export function getPublicTables(
  game: GameType,
  mode?: TableMode,
): PublicTable[] {
  return Array.from(publicTables.values())
    .filter((t) => t.game === game)
    .filter((t) => (mode ? t.mode === mode : true))
    .sort((a, b) => b.createdAt - a.createdAt)
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

function leaveCurrentTable(userId: string): GameType | null {
  const roomId = currentRoomByUser.get(userId);
  if (!roomId) return null;

  const room = rooms.get(roomId);
  let leftGame: GameType | null = null;

  if (room) {
    leftGame = room.game;
    const members = tableMembers.get(room.tableId);
    members?.delete(userId);
    if (members && members.size === 0) {
      tableMembers.delete(room.tableId);
      publicTables.delete(room.tableId);
    } else if (members) {
      // If host left before start, promote next member.
      const meta = publicTables.get(room.tableId);
      if (meta && meta.hostId === userId) {
        const nextHost = members.values().next().value as TableMember | undefined;
        if (nextHost) meta.hostId = nextHost.id;
      }
    }
  }

  currentRoomByUser.delete(userId);

  const roomStillUsed = Array.from(currentRoomByUser.values()).includes(roomId);
  if (!roomStillUsed) {
    rooms.delete(roomId);
  }

  return leftGame;
}

function notifyTablesUpdated(...games: Array<GameType | null | undefined>) {
  const unique = new Set(games.filter((game): game is GameType => Boolean(game)));
  for (const game of unique) {
    emitBroadcast("tables:updated", { game });
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

  // Anyone can create — leave waiting seats first. Block only mid-match.
  const existingRoomId = currentRoomByUser.get(userId);
  if (existingRoomId && getBuraLiveRoom(existingRoomId)) {
    throw new AppError(
      409,
      "ALREADY_IN_GAME",
      "ჯერ დაასრულე მიმდინარე თამაში.",
    );
  }
  if (existingRoomId) {
    leaveCurrentTable(userId);
  }

  // Soft-leave friends lobby if sitting there (exported helper avoids circular import issues).
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
  };
  publicTables.set(tableId, meta);

  const members = new Map<string, TableMember>();
  members.set(user.id, user);
  tableMembers.set(tableId, members);

  const roomId = `room_${tableId}`;
  rooms.set(roomId, {
    roomId,
    tableId,
    game: "bura",
    createdAt: Date.now(),
  });
  currentRoomByUser.set(user.id, roomId);

  notifyTablesUpdated("bura");
  emitBroadcast("presence:updated", {});

  return { table: serializePublicTable(meta), roomId, started: false as const };
}

export async function joinPublicTable(userId: string, tableId: string) {
  const parsed = joinParamsSchema.safeParse({ tableId });
  if (!parsed.success) {
    throw new AppError(400, "INVALID_TABLE", "არასწორი მაგიდა.");
  }

  const table = publicTables.get(tableId);
  if (!table) {
    throw new AppError(404, "TABLE_NOT_FOUND", "მაგიდა ვერ მოიძებნა.");
  }

  const user = await resolveUser(userId);
  const existing = tableMembers.get(tableId) ?? new Map<string, TableMember>();

  if (existing.has(user.id)) {
    const roomId = currentRoomByUser.get(user.id);
    if (roomId) {
      return {
        roomId,
        started: Boolean(getBuraLiveRoom(roomId)),
      };
    }
  }

  const leftGame = leaveCurrentTable(user.id);

  const members = tableMembers.get(tableId) ?? new Map<string, TableMember>();
  if (members.size >= table.maxPlayers) {
    notifyTablesUpdated(leftGame);
    throw new AppError(409, "TABLE_FULL", "მაგიდა სავსეა.");
  }

  members.set(user.id, user);
  tableMembers.set(tableId, members);

  let roomId =
    Array.from(rooms.values()).find((r) => r.tableId === tableId)?.roomId ??
    null;
  if (!roomId) {
    roomId = `room_${tableId}_${Date.now()}`;
    rooms.set(roomId, {
      roomId,
      tableId,
      game: table.game,
      createdAt: Date.now(),
    });
  }
  currentRoomByUser.set(user.id, roomId);

  let started = false;
  if (members.size >= table.maxPlayers && table.game === "bura") {
    const userIds = Array.from(members.keys());
    await createBuraLiveRoom({
      roomId,
      game: "bura",
      userIds,
      matchTo: table.matchTo,
      malyutkaMode: table.malyutkaMode,
      mode: table.mode,
    });
    started = true;
    for (const memberId of userIds) {
      emitToUser(memberId, "public-table:started", { roomId, tableId });
    }
    // Lobby row disappears once the match starts.
    publicTables.delete(tableId);
  }

  notifyTablesUpdated(table.game, leftGame);
  emitBroadcast("presence:updated", {});
  return { roomId, started };
}

export async function leavePublicTable(userId: string, tableId: string) {
  const parsed = joinParamsSchema.safeParse({ tableId });
  if (!parsed.success) {
    throw new AppError(400, "INVALID_TABLE", "არასწორი მაგიდა.");
  }

  const table = publicTables.get(tableId);
  if (!table) {
    // Already started/removed — still clear membership if any.
    leaveCurrentTable(userId);
    return { ok: true as const };
  }

  const members = tableMembers.get(tableId);
  if (!members?.has(userId)) {
    return { ok: true as const };
  }

  leaveCurrentTable(userId);
  notifyTablesUpdated(table.game);
  emitBroadcast("presence:updated", {});
  return { ok: true as const };
}

export function leavePublicTableIfAny(userId: string) {
  const leftGame = leaveCurrentTable(userId);
  if (leftGame) notifyTablesUpdated(leftGame);
}

export function registerUsersInGameRoom(input: {
  roomId: string;
  tableId: string;
  game: GameType;
  userIds: string[];
}) {
  rooms.set(input.roomId, {
    roomId: input.roomId,
    tableId: input.tableId,
    game: input.game,
    createdAt: Date.now(),
  });

  for (const userId of input.userIds) {
    leaveCurrentTable(userId);
    currentRoomByUser.set(userId, input.roomId);
  }
}

export function getUsersInGameRoom(roomId: string): string[] {
  return Array.from(currentRoomByUser.entries())
    .filter(([, id]) => id === roomId)
    .map(([userId]) => userId);
}

/**
 * One player leaving dissolves the whole table:
 * everyone is cleared from the room and notified.
 */
export function leaveGameRoom(userId: string) {
  const roomId = currentRoomByUser.get(userId);
  if (!roomId) return { ok: true as const, dissolved: false as const };

  const room = rooms.get(roomId);
  const memberIds = getUsersInGameRoom(roomId);
  // Live room exists only after the match started — mid-game leave still owes ads.
  const hadLiveMatch = Boolean(getBuraLiveRoom(roomId));

  for (const memberId of memberIds) {
    currentRoomByUser.delete(memberId);
  }

  if (room) {
    tableMembers.delete(room.tableId);
    publicTables.delete(room.tableId);
    rooms.delete(roomId);
    notifyTablesUpdated(room.game);
  } else {
    rooms.delete(roomId);
  }

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
  const room = rooms.get(roomId);
  const memberIds = getUsersInGameRoom(roomId);

  for (const memberId of memberIds) {
    currentRoomByUser.delete(memberId);
  }

  if (room) {
    tableMembers.delete(room.tableId);
    publicTables.delete(room.tableId);
    rooms.delete(roomId);
    notifyTablesUpdated(room.game);
  }

  destroyBuraLiveRoom(roomId);
  emitBroadcast("presence:updated", {});
}

export function isUserInPublicTable(userId: string) {
  return currentRoomByUser.has(userId);
}

export function isUserInGame(userId: string) {
  return currentRoomByUser.has(userId);
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
