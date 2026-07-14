import { AppError } from "../lib/errors.js";
import { emitToUser } from "../realtime/gateway.js";
import { getProfileIconUrl } from "./profile.service.js";
import { supabaseAdmin } from "../lib/supabase.js";
import {
  answerColorAsk,
  createMatch,
  finishDealWithWinner,
  offerRaise,
  publicDealView,
  respondRaise,
  startDeal,
  type RaiseResponse,
} from "../game/bura/engine.js";
import { autoPlayForSeat, declareBura, playCards, settleResolvedTrick } from "../game/bura/play.js";
import type {
  BuraMatchState,
  Card,
  ColorChoice,
  PlayerSeat,
  RaiseLevel,
  SeatIndex,
} from "../game/bura/types.js";
import { teamOf } from "../game/bura/types.js";

const TURN_MS = 60_000;
/** Reveal (1.5s) + gather + flip + fly animation on the client. */
const SETTLE_MS = 3_200;
/** Time to show round result before next deal (~3s + countdown). */
const BETWEEN_DEALS_MS = 3_500;
/** After match end: winner overlay + 3-2-1 countdown on clients, then free everyone. */
const MATCH_END_CLEANUP_MS = 7_000;

type RoomPlayer = {
  userId: string;
  username: string;
  iconUrl: string;
  seat: SeatIndex;
};

/** Show 5 trump on table before scoring the round. */
const BURA_REVEAL_MS = 2_800;

type LiveRoom = {
  roomId: string;
  game: "bura";
  players: RoomPlayer[];
  match: BuraMatchState;
  turnDeadline: number | null;
  /** Epoch ms when next deal starts (status between). */
  nextDealAt: number | null;
  turnTimer: ReturnType<typeof setTimeout> | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  finishTimer: ReturnType<typeof setTimeout> | null;
  buraRevealTimer: ReturnType<typeof setTimeout> | null;
  leaderboardAwarded?: boolean;
  /** dealNumber for which we already emitted chat "ბურა". */
  buraChatDeal?: number;
};

const rooms = new Map<string, LiveRoom>();

async function resolvePlayers(
  userIds: string[],
): Promise<Array<{ userId: string; username: string; iconUrl: string }>> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .in("id", userIds);

  if (error || !data) {
    throw new AppError(500, "PROFILE_LOAD_FAILED", "პროფილები ვერ ჩაიტვირთა.");
  }

  const byId = new Map(
    (
      data as Array<{ id: string; username: string; icon_path?: string | null }>
    ).map((row) => [row.id, row]),
  );

  const out = [];
  for (const id of userIds) {
    const row = byId.get(id);
    if (!row) {
      throw new AppError(404, "PROFILE_NOT_FOUND", "მოთამაშე ვერ მოიძებნა.");
    }
    out.push({
      userId: row.id,
      username: row.username,
      iconUrl: await getProfileIconUrl(row.username, row.icon_path),
    });
  }
  return out;
}

function clearTurnTimer(room: LiveRoom) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

function clearSettleTimer(room: LiveRoom) {
  if (room.settleTimer) {
    clearTimeout(room.settleTimer);
    room.settleTimer = null;
  }
}

function clearBuraRevealTimer(room: LiveRoom) {
  if (room.buraRevealTimer) {
    clearTimeout(room.buraRevealTimer);
    room.buraRevealTimer = null;
  }
}

function scheduleBuraRevealFinish(room: LiveRoom) {
  clearTurnTimer(room);
  clearSettleTimer(room);
  clearBuraRevealTimer(room);
  room.turnDeadline = null;
  room.buraRevealTimer = setTimeout(() => {
    try {
      const deal = room.match.deal;
      if (!deal?.buraReveal) return;
      const declarer = deal.currentTrick[0]?.seat;
      if (declarer === undefined) return;
      room.match = finishDealWithWinner(
        room.match,
        deal,
        teamOf(declarer),
        "bura",
      );
      room.buraRevealTimer = null;
      if (room.match.status === "between") {
        scheduleNextDealAfterBetween(room);
      } else if (room.match.status === "finished") {
        // match cleanup via broadcastRoom
      }
      broadcastRoom(room);
    } catch {
      // ignore
    }
  }, BURA_REVEAL_MS);
}

function scheduleNextDealAfterBetween(room: LiveRoom) {
  clearSettleTimer(room);
  clearTurnTimer(room);
  room.nextDealAt = Date.now() + BETWEEN_DEALS_MS;
  room.settleTimer = setTimeout(() => {
    try {
      room.match = startDeal(room.match);
      room.settleTimer = null;
      room.nextDealAt = null;
      if (room.match.status === "playing") scheduleTurnTimer(room);
      broadcastRoom(room);
    } catch {
      // ignore
    }
  }, BETWEEN_DEALS_MS);
}

function scheduleSettle(room: LiveRoom) {
  clearSettleTimer(room);
  if (!room.match.deal?.pendingSettle) return;

  // Pause turn timer while cards fly to pile.
  clearTurnTimer(room);
  room.settleTimer = setTimeout(() => {
    try {
      room.match = settleResolvedTrick(room.match);
      room.settleTimer = null;
      if (room.match.status === "between") {
        scheduleNextDealAfterBetween(room);
        broadcastRoom(room);
        return;
      }

      if (room.match.status === "playing") {
        scheduleTurnTimer(room);
      }
      broadcastRoom(room);
    } catch {
      // ignore
    }
  }, SETTLE_MS);
}

function scheduleTurnTimer(room: LiveRoom) {
  clearTurnTimer(room);
  if (room.match.status !== "playing" || !room.match.deal || room.match.deal.finished) {
    return;
  }
  if (room.match.deal.pendingSettle || room.match.deal.buraReveal) return;
  room.turnDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    try {
      const seat = room.match.deal?.turnSeat;
      if (seat === undefined) return;
      room.match = autoPlayForSeat(room.match, seat);
      if (room.match.deal?.buraReveal) {
        broadcastRoom(room);
        scheduleBuraRevealFinish(room);
        return;
      }
      if (room.match.deal?.pendingSettle) {
        broadcastRoom(room);
        scheduleSettle(room);
        return;
      }
      scheduleTurnTimer(room);
      broadcastRoom(room);
    } catch {
      // ignore timeout failures
    }
  }, TURN_MS);
}

function ensureColorAsk(room: LiveRoom) {
  const deal = room.match.deal;
  if (room.match.status !== "color_ask" || !deal) return;
  if (deal.colorAsk && deal.colorAsk.askedSeat !== null) return;

  const askedSeat = (Math.floor(Math.random() * 4) as SeatIndex);
  room.match = {
    ...room.match,
    deal: {
      ...deal,
      colorAsk: { askedSeat, answer: null, resolvedLeadSeat: null },
    },
  };
}

function viewerPayload(room: LiveRoom, userId: string) {
  ensureColorAsk(room);
  const me = room.players.find((p) => p.userId === userId);
  if (!me) throw new AppError(403, "FORBIDDEN", "ამ ოთახში არ ხარ.");

  const deal = room.match.deal;
  const dealView = deal
    ? publicDealView(deal, me.seat, room.match.config.malyutkaMode)
    : null;
  const hideTrump = room.match.status === "color_ask";

  return {
    roomId: room.roomId,
    game: room.game,
    status: room.match.status,
    scores: room.match.scores,
    dealNumber: room.match.dealNumber,
    turnDeadline: room.turnDeadline,
    nextDealAt: room.nextDealAt,
    mySeat: me.seat,
    config: {
      matchTo: room.match.config.matchTo,
      malyutkaMode: room.match.config.malyutkaMode,
    },
    players: room.players.map((p) => ({
      seat: p.seat,
      userId: p.userId,
      username: p.username,
      iconUrl: p.iconUrl,
      team: teamOf(p.seat),
      handCount: deal ? deal.hands[p.seat].length : 0,
      isMe: p.userId === userId,
    })),
    deal: dealView
      ? {
          ...dealView,
          // Until color is answered, nobody sees the koziri.
          trump: hideTrump ? null : dealView.trump,
          trumpCard: hideTrump ? null : dealView.trumpCard,
        }
      : null,
  };
}

/**
 * Match reached 11 points: give clients time for the winner overlay +
 * countdown, then dissolve the room so presence/statuses go back to normal.
 */
function maybeScheduleMatchCleanup(room: LiveRoom) {
  if (room.match.status !== "finished" || room.finishTimer) return;
  clearTurnTimer(room);
  clearSettleTimer(room);

  if (!room.leaderboardAwarded) {
    room.leaderboardAwarded = true;
    const score0 = room.match.scores[0] ?? 0;
    const score1 = room.match.scores[1] ?? 0;
    const resolvedTeam = (score0 >= score1 ? 0 : 1) as 0 | 1;
    const winnerUserIds = room.players
      .filter((p) => teamOf(p.seat) === resolvedTeam)
      .map((p) => p.userId);
    const allUserIds = room.players.map((p) => p.userId);
    void import("./leaderboard.service.js")
      .then(({ awardMatchWin }) =>
        awardMatchWin({
          roomId: room.roomId,
          winnerTeam: resolvedTeam,
          winnerUserIds,
        }),
      )
      .catch(() => {});
    // Every player owes a post-match interstitial (refresh / other browser still blocked).
    void import("./ads.service.js")
      .then(({ markPendingAdsForUsers }) => markPendingAdsForUsers(allUserIds))
      .catch(() => {});
  }

  room.finishTimer = setTimeout(() => {
    void (async () => {
      try {
        const { dissolveFinishedGameRoom } = await import("./tables.service.js");
        dissolveFinishedGameRoom(room.roomId);
      } catch {
        // ignore
      }
    })();
  }, MATCH_END_CLEANUP_MS);
}

function maybeAnnounceBura(room: LiveRoom) {
  const deal = room.match.deal;
  if (!deal || deal.endReason !== "bura") return;
  if (room.buraChatDeal === room.match.dealNumber) return;
  room.buraChatDeal = room.match.dealNumber;
  const winnerTeam = deal.winnerTeam;
  const speaker =
    room.players.find((p) => teamOf(p.seat) === winnerTeam) ?? room.players[0];
  if (!speaker) return;
  const ts = Date.now();
  for (const p of room.players) {
    emitToUser(p.userId, "game:chat", {
      roomId: room.roomId,
      userId: speaker.userId,
      text: "ბურა",
      ts,
    });
  }
}

function broadcastRoom(room: LiveRoom) {
  maybeAnnounceBura(room);
  maybeScheduleMatchCleanup(room);
  for (const player of room.players) {
    emitToUser(player.userId, "bura:state", viewerPayload(room, player.userId));
  }
}

export async function createBuraLiveRoom(input: {
  roomId: string;
  game: "bura";
  userIds: string[];
  matchTo?: number;
  malyutkaMode?: "turn" | "anytime";
}) {
  if (input.userIds.length !== 4) {
    throw new AppError(400, "NEED_4", "სჭირდება 4 მოთამაშე.");
  }

  const existing = rooms.get(input.roomId);
  if (existing) {
    broadcastRoom(existing);
    return existing;
  }

  const profiles = await resolvePlayers(input.userIds);
  const seats: PlayerSeat[] = profiles.map((p, index) => ({
    seat: index as SeatIndex,
    userId: p.userId,
    username: p.username,
    team: teamOf(index as SeatIndex),
  }));

  const players: RoomPlayer[] = profiles.map((p, index) => ({
    ...p,
    seat: index as SeatIndex,
  }));

  const matchTo = Math.min(11, Math.max(3, input.matchTo ?? 11));
  const malyutkaMode = input.malyutkaMode === "anytime" ? "anytime" : "turn";

  const match = startDeal(
    createMatch(input.roomId, seats, { matchTo, malyutkaMode }),
  );

  const room: LiveRoom = {
    roomId: input.roomId,
    game: input.game,
    players,
    match,
    turnDeadline: null,
    nextDealAt: null,
    turnTimer: null,
    settleTimer: null,
    finishTimer: null,
    buraRevealTimer: null,
  };
  rooms.set(input.roomId, room);

  if (match.status === "playing") scheduleTurnTimer(room);
  broadcastRoom(room);
  return room;
}

export function getBuraLiveRoom(roomId: string) {
  return rooms.get(roomId) ?? null;
}

export function getBuraRoomView(roomId: string, userId: string) {
  const room = rooms.get(roomId);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "ოთახი ვერ მოიძებნა.");
  return viewerPayload(room, userId);
}

export function answerBuraColor(
  roomId: string,
  userId: string,
  answer: ColorChoice,
) {
  const room = rooms.get(roomId);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "ოთახი ვერ მოიძებნა.");
  const player = room.players.find((p) => p.userId === userId);
  if (!player) throw new AppError(403, "FORBIDDEN", "ამ ოთახში არ ხარ.");

  try {
    room.match = answerColorAsk(room.match, player.seat, answer);
  } catch (err) {
    throw new AppError(
      400,
      "COLOR_ASK_FAILED",
      err instanceof Error ? err.message : "ფერის პასუხი ვერ შესრულდა.",
    );
  }

  if (room.match.status === "playing") scheduleTurnTimer(room);
  broadcastRoom(room);
  return viewerPayload(room, userId);
}

export function playBuraCards(roomId: string, userId: string, cardIds: string[]) {
  const room = rooms.get(roomId);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "ოთახი ვერ მოიძებნა.");
  const player = room.players.find((p) => p.userId === userId);
  if (!player) throw new AppError(403, "FORBIDDEN", "ამ ოთახში არ ხარ.");

  try {
    room.match = playCards(room.match, player.seat, cardIds);
  } catch (err) {
    throw new AppError(
      400,
      "PLAY_FAILED",
      err instanceof Error ? err.message : "სვლა ვერ შესრულდა.",
    );
  }

  if (room.match.deal?.pendingSettle) {
    scheduleSettle(room);
  } else {
    scheduleTurnTimer(room);
  }
  broadcastRoom(room);
  return viewerPayload(room, userId);
}

export function declareBuraCards(roomId: string, userId: string) {
  const room = rooms.get(roomId);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "ოთახი ვერ მოიძებნა.");
  const player = room.players.find((p) => p.userId === userId);
  if (!player) throw new AppError(403, "FORBIDDEN", "ამ ოთახში არ ხარ.");

  try {
    room.match = declareBura(room.match, player.seat);
  } catch (err) {
    throw new AppError(
      400,
      "BURA_FAILED",
      err instanceof Error ? err.message : "ბურა ვერ გამოცხადდა.",
    );
  }

  scheduleBuraRevealFinish(room);
  broadcastRoom(room);
  return viewerPayload(room, userId);
}

export function offerBuraRaise(
  roomId: string,
  userId: string,
  level: RaiseLevel,
) {
  const room = rooms.get(roomId);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "ოთახი ვერ მოიძებნა.");
  const player = room.players.find((p) => p.userId === userId);
  if (!player) throw new AppError(403, "FORBIDDEN", "ამ ოთახში არ ხარ.");

  try {
    room.match = offerRaise(room.match, player.seat, level);
  } catch (err) {
    throw new AppError(
      400,
      "RAISE_FAILED",
      err instanceof Error ? err.message : "შეთავაზება ვერ შესრულდა.",
    );
  }

  // Pause the active turn timer while the next opponent decides on the raise.
  clearTurnTimer(room);
  broadcastRoom(room);
  return viewerPayload(room, userId);
}

export function respondBuraRaise(
  roomId: string,
  userId: string,
  response: RaiseResponse,
) {
  const room = rooms.get(roomId);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "ოთახი ვერ მოიძებნა.");
  const player = room.players.find((p) => p.userId === userId);
  if (!player) throw new AppError(403, "FORBIDDEN", "ამ ოთახში არ ხარ.");

  try {
    room.match = respondRaise(room.match, player.seat, response);
  } catch (err) {
    throw new AppError(
      400,
      "RAISE_RESPONSE_FAILED",
      err instanceof Error ? err.message : "პასუხი ვერ შესრულდა.",
    );
  }

  if (room.match.status === "between") {
    scheduleNextDealAfterBetween(room);
  } else if (room.match.status === "playing" && room.match.deal?.pendingRaise) {
    // Counter-raise still waits for a response, so keep the timer paused.
    clearTurnTimer(room);
  } else if (room.match.status === "playing") {
    // Accepted raise resumes the same turn with a fresh 60s timer.
    scheduleTurnTimer(room);
  }
  broadcastRoom(room);
  return viewerPayload(room, userId);
}

export function destroyBuraLiveRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTurnTimer(room);
  clearSettleTimer(room);
  clearBuraRevealTimer(room);
  if (room.finishTimer) {
    clearTimeout(room.finishTimer);
    room.finishTimer = null;
  }
  rooms.delete(roomId);
}

export type { Card, RaiseLevel };
