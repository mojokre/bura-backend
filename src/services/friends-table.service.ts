import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { emitToUser, emitBroadcast } from "../realtime/gateway.js";
import { getProfileIconUrl } from "./profile.service.js";
import type { GameType } from "./tables.service.js";
import {
  isUserInGame,
  leavePublicTableIfAny,
  registerUsersInGameRoom,
} from "./tables.service.js";
import { createBuraLiveRoom } from "./bura-room.service.js";

export type PrivateSeatStatus = "pending" | "accepted" | "rejected";

export type PrivateSeat = {
  id: string;
  username: string;
  iconUrl: string;
  status: PrivateSeatStatus;
  isHost: boolean;
  /** Chosen side: 0 = გუნდი 1 (seats 0+2), 1 = გუნდი 2 (seats 1+3). Null until picked. */
  team: 0 | 1 | null;
};

export type PrivateLobby = {
  id: string;
  game: GameType;
  hostId: string;
  status: "waiting" | "ready" | "started";
  maxPlayers: number;
  seats: PrivateSeat[];
  roomId: string | null;
  createdAt: number;
};

type PrivateLobbyInternal = {
  id: string;
  game: GameType;
  hostId: string;
  status: "waiting" | "ready" | "started";
  maxPlayers: number;
  seats: Map<string, PrivateSeat>;
  roomId: string | null;
  createdAt: number;
};

const MAX_PLAYERS = 4;
const INVITE_COUNT = 3;

const createSchema = z.object({
  game: z.literal("bura"),
  friendIds: z.array(z.string().uuid()).length(INVITE_COUNT),
});

const joinTeamSchema = z.object({
  team: z.union([z.literal(0), z.literal(1)]),
});

const privateLobbies = new Map<string, PrivateLobbyInternal>();
const privateLobbyByUser = new Map<string, string>();

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

async function assertAreFriends(hostId: string, friendIds: string[]) {
  const { data, error } = await supabaseAdmin
    .from("friendships")
    .select("requester_id, addressee_id, status")
    .eq("status", "accepted")
    .or(`requester_id.eq.${hostId},addressee_id.eq.${hostId}`);

  if (error) {
    throw new AppError(500, "FRIENDS_CHECK_FAILED", "მეგობრების შემოწმება ვერ მოხერხდა.");
  }

  const friendSet = new Set(
    ((data ?? []) as Array<{ requester_id: string; addressee_id: string }>).map(
      (row) => (row.requester_id === hostId ? row.addressee_id : row.requester_id),
    ),
  );

  for (const id of friendIds) {
    if (!friendSet.has(id)) {
      throw new AppError(400, "NOT_FRIENDS", "მხოლოდ მეგობრების მოწვევა შეიძლება.");
    }
  }
}

function serializeLobby(lobby: PrivateLobbyInternal): PrivateLobby {
  const seats = Array.from(lobby.seats.values());
  seats.sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    return a.username.localeCompare(b.username);
  });

  return {
    id: lobby.id,
    game: lobby.game,
    hostId: lobby.hostId,
    status: lobby.status,
    maxPlayers: lobby.maxPlayers,
    seats,
    roomId: lobby.roomId,
    createdAt: lobby.createdAt,
  };
}

function acceptedCount(lobby: PrivateLobbyInternal) {
  return Array.from(lobby.seats.values()).filter((seat) => seat.status === "accepted")
    .length;
}

function refreshLobbyStatus(lobby: PrivateLobbyInternal) {
  if (lobby.status === "started") return;
  lobby.status = acceptedCount(lobby) >= MAX_PLAYERS ? "ready" : "waiting";
}

function emitLobbyToMembers(lobby: PrivateLobbyInternal, event: string, extra: Record<string, unknown> = {}) {
  const payload = { lobby: serializeLobby(lobby), ...extra };
  for (const seat of lobby.seats.values()) {
    emitToUser(seat.id, event, payload);
  }
}

function clearUserPrivateLobby(userId: string) {
  privateLobbyByUser.delete(userId);
}

function destroyLobby(lobbyId: string) {
  const lobby = privateLobbies.get(lobbyId);
  if (!lobby) return;
  for (const seat of lobby.seats.values()) {
    if (privateLobbyByUser.get(seat.id) === lobbyId) {
      clearUserPrivateLobby(seat.id);
    }
  }
  privateLobbies.delete(lobbyId);
}

export function isUserInPrivateLobby(userId: string) {
  return privateLobbyByUser.has(userId);
}

export function getPrivateLobbyForUser(userId: string): PrivateLobby | null {
  const lobbyId = privateLobbyByUser.get(userId);
  if (!lobbyId) return null;
  const lobby = privateLobbies.get(lobbyId);
  if (!lobby) return null;
  return serializeLobby(lobby);
}

export async function createFriendsTable(hostId: string, body: unknown) {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `ზუსტად ${INVITE_COUNT} მეგობარი უნდა მოიწვიო (სულ ${MAX_PLAYERS} მოთამაშე).`,
    );
  }

  const { game, friendIds } = parsed.data;
  const uniqueFriends = new Set(friendIds);
  if (uniqueFriends.size !== INVITE_COUNT) {
    throw new AppError(400, "DUPLICATE_INVITES", "მეგობრები არ უნდა გამეორდეს.");
  }
  if (uniqueFriends.has(hostId)) {
    throw new AppError(400, "INVALID_INVITE", "საკუთარ თავს ვერ მოიწვევ.");
  }

  if (isUserInPrivateLobby(hostId) || isUserInGame(hostId)) {
    throw new AppError(409, "ALREADY_IN_TABLE", "უკვე ხარ მაგიდაზე ან ლობიში.");
  }

  for (const friendId of friendIds) {
    if (isUserInPrivateLobby(friendId) || isUserInGame(friendId)) {
      throw new AppError(409, "FRIEND_BUSY", "ერთ-ერთი მეგობარი თამაშშია ან ლობიშია.");
    }
  }

  await assertAreFriends(hostId, friendIds);

  const host = await resolveUser(hostId);
  const invited = await Promise.all(friendIds.map((id) => resolveUser(id)));

  leavePublicTableIfAny(hostId);

  const lobbyId = `friends_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const seats = new Map<string, PrivateSeat>();
  seats.set(host.id, {
    ...host,
    status: "accepted",
    isHost: true,
    team: 0,
  });
  for (const friend of invited) {
    seats.set(friend.id, {
      ...friend,
      status: "pending",
      isHost: false,
      team: null,
    });
  }

  const lobby: PrivateLobbyInternal = {
    id: lobbyId,
    game,
    hostId,
    status: "waiting",
    maxPlayers: MAX_PLAYERS,
    seats,
    roomId: null,
    createdAt: Date.now(),
  };

  privateLobbies.set(lobbyId, lobby);
  privateLobbyByUser.set(hostId, lobbyId);
  for (const friend of invited) {
    privateLobbyByUser.set(friend.id, lobbyId);
  }

  const serialized = serializeLobby(lobby);

  for (const friend of invited) {
    emitToUser(friend.id, "friends-table:invite", {
      lobby: serialized,
      host,
    });
  }

  emitToUser(hostId, "friends-table:updated", { lobby: serialized });

  return serialized;
}

export async function respondFriendsTableInvite(
  userId: string,
  lobbyId: string,
  action: "accept" | "reject",
) {
  const lobby = privateLobbies.get(lobbyId);
  if (!lobby) {
    throw new AppError(404, "LOBBY_NOT_FOUND", "ლობი ვერ მოიძებნა.");
  }
  if (lobby.status === "started") {
    throw new AppError(409, "ALREADY_STARTED", "თამაში უკვე დაიწყო.");
  }

  const seat = lobby.seats.get(userId);
  if (!seat || seat.isHost) {
    throw new AppError(403, "NOT_INVITED", "შენ არ ხარ ამ მოწვევაში.");
  }
  if (seat.status !== "pending") {
    throw new AppError(409, "ALREADY_RESPONDED", "უკვე უპასუხე ამ მოწვევას.");
  }

  if (action === "accept") {
    leavePublicTableIfAny(userId);
    seat.status = "accepted";
    // Do NOT auto-join a team — player must pick გუნდი 1 / გუნდი 2 manually.
    seat.team = null;
    refreshLobbyStatus(lobby);

    emitLobbyToMembers(lobby, "friends-table:updated", {
      message: `${seat.username} შეუერთდა მაგიდას`,
    });
    emitToUser(userId, "friends-table:invite:resolved", {
      lobbyId,
      action: "accept",
      lobby: serializeLobby(lobby),
    });

    return serializeLobby(lobby);
  }

  seat.status = "rejected";
  refreshLobbyStatus(lobby);
  clearUserPrivateLobby(userId);

  emitLobbyToMembers(lobby, "friends-table:updated", {
    message: `${seat.username}-მა უარყო მოწვევა`,
  });
  emitToUser(userId, "friends-table:invite:resolved", {
    lobbyId,
    action: "reject",
    lobby: serializeLobby(lobby),
  });
  emitToUser(lobby.hostId, "friends-table:rejected", {
    lobby: serializeLobby(lobby),
    username: seat.username,
  });

  return serializeLobby(lobby);
}

export async function startFriendsTable(userId: string, lobbyId: string) {
  const lobby = privateLobbies.get(lobbyId);
  if (!lobby) {
    throw new AppError(404, "LOBBY_NOT_FOUND", "ლობი ვერ მოიძებნა.");
  }
  if (lobby.hostId !== userId) {
    throw new AppError(403, "NOT_HOST", "მხოლოდ ჰოსტს შეუძლია დაწყება.");
  }
  if (lobby.status === "started") {
    return serializeLobby(lobby);
  }

  const accepted = Array.from(lobby.seats.values()).filter(
    (seat) => seat.status === "accepted",
  );
  if (accepted.length < MAX_PLAYERS) {
    throw new AppError(
      409,
      "NOT_READY",
      `დაწყება შეიძლება მხოლოდ როცა ${MAX_PLAYERS} მოთამაშე დათანხმდება.`,
    );
  }

  const teamA = accepted.filter((s) => s.team === 0);
  const teamB = accepted.filter((s) => s.team === 1);
  if (teamA.length !== 2 || teamB.length !== 2) {
    throw new AppError(
      409,
      "TEAMS_NOT_READY",
      "თითო გუნდში უნდა იყოს 2 მოთამაშე.",
    );
  }

  const pending = Array.from(lobby.seats.values()).filter(
    (seat) => seat.status === "pending",
  );
  for (const seat of pending) {
    clearUserPrivateLobby(seat.id);
    lobby.seats.delete(seat.id);
    emitToUser(seat.id, "friends-table:invite:resolved", {
      lobbyId,
      action: "cancelled",
    });
  }

  const roomId = `room_${lobbyId}_${Date.now()}`;
  lobby.roomId = roomId;
  lobby.status = "started";

  // Seat order: 0+2 = team 0, 1+3 = team 1 (partners opposite each other).
  const acceptedIds = [teamA[0]!.id, teamB[0]!.id, teamA[1]!.id, teamB[1]!.id];
  registerUsersInGameRoom({
    roomId,
    tableId: lobbyId,
    game: lobby.game,
    userIds: acceptedIds,
  });

  if (lobby.game === "bura") {
    await createBuraLiveRoom({
      roomId,
      game: "bura",
      userIds: acceptedIds,
    });
  }

  const startedLobby = serializeLobby(lobby);

  emitLobbyToMembers(lobby, "friends-table:started", {
    roomId,
    lobby: startedLobby,
  });

  // Lobby list disappears from main; players are now in-game.
  destroyLobby(lobbyId);
  emitBroadcast("presence:updated", {});

  return startedLobby;
}

export async function joinFriendsTableTeam(
  userId: string,
  lobbyId: string,
  body: unknown,
) {
  const parsed = joinTeamSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "გუნდი უნდა იყოს 0 ან 1.");
  }
  const team = parsed.data.team as 0 | 1;

  const lobby = privateLobbies.get(lobbyId);
  if (!lobby) {
    throw new AppError(404, "LOBBY_NOT_FOUND", "ლობი ვერ მოიძებნა.");
  }
  if (lobby.status === "started") {
    throw new AppError(409, "ALREADY_STARTED", "თამაში უკვე დაიწყო.");
  }

  const seat = lobby.seats.get(userId);
  if (!seat) {
    throw new AppError(403, "NOT_IN_LOBBY", "შენ ამ ლობიში არ ხარ.");
  }
  if (seat.status !== "accepted") {
    throw new AppError(409, "NOT_ACCEPTED", "ჯერ მიიღე მოწვევა.");
  }

  const onTeam = Array.from(lobby.seats.values()).filter(
    (s) => s.status === "accepted" && s.team === team && s.id !== userId,
  );
  if (onTeam.length >= 2) {
    throw new AppError(409, "TEAM_FULL", "ეს გუნდი უკვე სავსეა (2/2).");
  }

  seat.team = team;
  emitLobbyToMembers(lobby, "friends-table:updated", {
    message: `${seat.username} გადავიდა გუნდში ${team + 1}`,
  });

  return serializeLobby(lobby);
}

export async function leaveFriendsTable(userId: string, lobbyId: string) {
  const lobby = privateLobbies.get(lobbyId);
  if (!lobby) {
    return { ok: true as const };
  }

  const seat = lobby.seats.get(userId);
  if (!seat) {
    return { ok: true as const };
  }

  if (lobby.hostId === userId) {
    const serialized = serializeLobby(lobby);
    for (const member of lobby.seats.values()) {
      emitToUser(member.id, "friends-table:cancelled", {
        lobbyId,
        message: "ჰოსტმა გააუქმა მაგიდა",
      });
    }
    destroyLobby(lobbyId);
    return { ok: true as const, lobby: serialized };
  }

  if (seat.status === "pending") {
    seat.status = "rejected";
  }
  lobby.seats.delete(userId);
  clearUserPrivateLobby(userId);
  refreshLobbyStatus(lobby);

  emitLobbyToMembers(lobby, "friends-table:updated", {
    message: `${seat.username} გავიდა ლობიდან`,
  });

  if (lobby.seats.size <= 1) {
    for (const member of lobby.seats.values()) {
      emitToUser(member.id, "friends-table:cancelled", {
        lobbyId,
        message: "ლობი დაიხურა",
      });
    }
    destroyLobby(lobbyId);
  }

  return { ok: true as const };
}

export function getFriendsTable(lobbyId: string, userId: string) {
  const lobby = privateLobbies.get(lobbyId);
  if (!lobby) {
    throw new AppError(404, "LOBBY_NOT_FOUND", "ლობი ვერ მოიძებნა.");
  }
  if (!lobby.seats.has(userId)) {
    throw new AppError(403, "FORBIDDEN", "ამ ლობის ნახვა არ შეგიძლია.");
  }
  return serializeLobby(lobby);
}
