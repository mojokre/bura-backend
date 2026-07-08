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

export type GameType = "bura" | "joker";

export type PublicTable = {
  id: string;
  game: GameType;
  label: string;
  playersCount: number;
  maxPlayers: number;
  joinedUsers: Array<{
    id: string;
    username: string;
    iconUrl: string;
  }>;
};

const tableTemplates: Array<{
  id: string;
  game: GameType;
  label: string;
  maxPlayers: number;
}> = [
  // Bura tables
  { id: "bura-1", game: "bura", label: "ბურა • მაგიდა 1", maxPlayers: 4 },
  { id: "bura-2", game: "bura", label: "ბურა • მაგიდა 2", maxPlayers: 4 },
  { id: "bura-3", game: "bura", label: "ბურა • მაგიდა 3", maxPlayers: 4 },
  { id: "bura-4", game: "bura", label: "ბურა • მაგიდა 4", maxPlayers: 4 },

  // Joker tables
  { id: "joker-1", game: "joker", label: "ჯოკერი • მაგიდა 1", maxPlayers: 4 },
  { id: "joker-2", game: "joker", label: "ჯოკერი • მაგიდა 2", maxPlayers: 4 },
  { id: "joker-3", game: "joker", label: "ჯოკერი • მაგიდა 3", maxPlayers: 4 },
  { id: "joker-4", game: "joker", label: "ჯოკერი • მაგიდა 4", maxPlayers: 4 },
];

const joinParamsSchema = z.object({
  tableId: z.string().min(1),
});

type TableMember = { id: string; username: string; iconUrl: string };
type Room = { roomId: string; tableId: string; game: GameType; createdAt: number };

const rooms = new Map<string, Room>();
const tableMembers = new Map<string, Map<string, TableMember>>();
const currentRoomByUser = new Map<string, string>();

function getTableMembers(tableId: string): TableMember[] {
  return Array.from(tableMembers.get(tableId)?.values() ?? []);
}

export function getPublicTables(game: GameType): PublicTable[] {
  return tableTemplates
    .filter((table) => table.game === game)
    .map((table) => {
      const joined = getTableMembers(table.id);
      return {
        id: table.id,
        game: table.game,
        label: table.label,
        maxPlayers: table.maxPlayers,
        playersCount: joined.length,
        joinedUsers: joined,
      };
    });
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

export async function joinPublicTable(userId: string, tableId: string) {
  const parsed = joinParamsSchema.safeParse({ tableId });
  if (!parsed.success) {
    throw new AppError(400, "INVALID_TABLE", "არასწორი მაგიდა.");
  }

  const table = tableTemplates.find((t) => t.id === tableId);
  if (!table) {
    throw new AppError(404, "TABLE_NOT_FOUND", "მაგიდა ვერ მოიძებნა.");
  }

  const user = await resolveUser(userId);
  const existing = tableMembers.get(tableId) ?? new Map<string, TableMember>();

  // Already seated at this table — return existing room.
  if (existing.has(user.id)) {
    const roomId = currentRoomByUser.get(user.id);
    if (roomId) {
      return {
        roomId,
        started: Boolean(getBuraLiveRoom(roomId)),
      };
    }
  }

  // Moving from another table first.
  const leftGame = leaveCurrentTable(user.id);

  const members = tableMembers.get(tableId) ?? new Map<string, TableMember>();
  if (members.size >= table.maxPlayers) {
    notifyTablesUpdated(leftGame);
    throw new AppError(409, "TABLE_FULL", "მაგიდა სავსეა.");
  }

  members.set(user.id, user);
  tableMembers.set(tableId, members);

  // All seats at this public table share one roomId.
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
  // Full table → start shared Bura match for everyone.
  if (members.size >= table.maxPlayers && table.game === "bura") {
    const userIds = Array.from(members.keys());
    await createBuraLiveRoom({
      roomId,
      game: "bura",
      userIds,
    });
    started = true;
    for (const memberId of userIds) {
      emitToUser(memberId, "public-table:started", { roomId, tableId });
    }
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

  const table = tableTemplates.find((t) => t.id === tableId);
  if (!table) {
    throw new AppError(404, "TABLE_NOT_FOUND", "მაგიდა ვერ მოიძებნა.");
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

  for (const memberId of memberIds) {
    currentRoomByUser.delete(memberId);
  }

  if (room) {
    tableMembers.delete(room.tableId);
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
  };
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

