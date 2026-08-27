import { AppError } from "../lib/errors.js";
import { isSimBotUserId, simBotProfile } from "../lib/dev-bots.js";
import { emitToUser } from "../realtime/gateway.js";
import { getProfileIconUrl } from "./profile.service.js";
import { supabaseAdmin } from "../lib/supabase.js";
import {
  answerColorAsk,
  createMatch,
  offerRaise,
  publicDealView,
  respondRaise,
  startDeal,
  type RaiseResponse,
} from "../game/bura/engine.js";
import { autoPlayForSeat, declareBura, isBuraTrick, playCards, settleResolvedTrick } from "../game/bura/play.js";
import type {
  BuraDealState,
  BuraMatchState,
  Card,
  ColorChoice,
  PlayerSeat,
  RaiseLevel,
  SeatIndex,
} from "../game/bura/types.js";
import { activeSeatsForMode, teamOf, nextSeat } from "../game/bura/types.js";

const TURN_MS = 15_000;
/** Dev bot think/play delay (ms). */
const BOT_STEP_MS = 550;
/** Must exceed client collect (reveal ≥2s + gather/fly). */
const SETTLE_MS = 4_500;
/** Per dealt card — match mobile DEAL (~340ms fly + gap). */
const DEAL_CARD_MS = 420;
const DEAL_LOCK_MIN_MS = 400;
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

type LiveRoom = {
  roomId: string;
  game: "bura";
  players: RoomPlayer[];
  match: BuraMatchState;
  turnDeadline: number | null;
  /** Epoch ms when next deal starts (status between). */
  nextDealAt: number | null;
  /** Epoch ms until play/bots stay locked (client deal animation). */
  dealLockedUntil: number | null;
  turnTimer: ReturnType<typeof setTimeout> | null;
  botTimer: ReturnType<typeof setTimeout> | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  dealLockTimer: ReturnType<typeof setTimeout> | null;
  finishTimer: ReturnType<typeof setTimeout> | null;
  leaderboardAwarded?: boolean;
  /** dealNumber for which we already emitted chat "ბურა". */
  buraChatDeal?: number;
};

const rooms = new Map<string, LiveRoom>();

async function resolvePlayers(
  userIds: string[],
): Promise<Array<{ userId: string; username: string; iconUrl: string }>> {
  const realIds = userIds.filter((id) => !isSimBotUserId(id));
  const out: Array<{ userId: string; username: string; iconUrl: string }> = [];

  if (realIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, username, icon_path")
      .in("id", realIds);

    if (error || !data) {
      throw new AppError(500, "PROFILE_LOAD_FAILED", "პროფილები ვერ ჩაიტვირთა.");
    }

    const byId = new Map(
      (
        data as Array<{ id: string; username: string; icon_path?: string | null }>
      ).map((row) => [row.id, row]),
    );

    for (const id of realIds) {
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
  }

  const realById = new Map(out.map((p) => [p.userId, p]));
  const merged = [];
  let botIndex = 1;
  for (const id of userIds) {
    if (isSimBotUserId(id)) {
      merged.push(simBotProfile(id, botIndex++));
      continue;
    }
    const profile = realById.get(id);
    if (!profile) {
      throw new AppError(404, "PROFILE_NOT_FOUND", "მოთამაშე ვერ მოიძებნა.");
    }
    merged.push(profile);
  }
  return merged;
}

function isBotSeat(room: LiveRoom, seat: SeatIndex): boolean {
  const player = room.players.find((p) => p.seat === seat);
  return player ? isSimBotUserId(player.userId) : false;
}

function clearBotTimer(room: LiveRoom) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

function roomHasSimBots(room: LiveRoom): boolean {
  return room.players.some((p) => isSimBotUserId(p.userId));
}

/** Dev sim: auto-answer red/black when a bot is asked. */
function advanceSimColorAsk(room: LiveRoom): boolean {
  if (!roomHasSimBots(room)) return false;
  const deal = room.match.deal;
  if (room.match.status !== "color_ask" || !deal?.colorAsk || deal.colorAsk.answer) {
    return false;
  }
  const seat = deal.colorAsk.askedSeat;
  if (seat === null || seat === undefined) return false;
  if (!isBotSeat(room, seat)) return false;

  const answer: ColorChoice = Math.random() < 0.5 ? "red" : "black";
  room.match = answerColorAsk(room.match, seat, answer);
  return true;
}

/** Resolve first-deal color ask before sending state (bots answer sync). */
function resolveSimColorAsk(room: LiveRoom) {
  if (!roomHasSimBots(room)) return;
  ensureColorAsk(room);
  if (advanceSimColorAsk(room) && room.match.status === "playing") {
    scheduleTurnTimer(room);
  }
}

/** Schedule the next bot raise/play step without cancelling an pending bot timer. */
function scheduleBotSimFollowUp(room: LiveRoom) {
  if (!roomHasSimBots(room) || room.match.status === "finished") return;
  const deal = room.match.deal;
  if (!deal) return;

  if (
    room.match.status === "playing" &&
    deal.pendingRaise &&
    deal.pendingRaiseFrom !== null
  ) {
    const responder = nextSeat(deal.pendingRaiseFrom, room.match.config.mode);
    if (!isBotSeat(room, responder) || room.botTimer) return;
    room.botTimer = setTimeout(() => {
      try {
        room.match = respondRaise(room.match, responder, "accept");
        if (room.match.status === "between") {
          scheduleNextDealAfterBetween(room);
        } else if (room.match.status === "playing" && !room.match.deal?.pendingRaise) {
          scheduleTurnTimer(room);
        }
        broadcastRoom(room);
      } catch {
        // ignore bot raise failures
      }
    }, BOT_STEP_MS);
    return;
  }

  if (
    room.match.status === "playing" &&
    !deal.pendingSettle &&
    !deal.pendingRaise &&
    !isDealLocked(room)
  ) {
    const seat = deal.turnSeat;
    if (isBotSeat(room, seat) && !room.botTimer) {
      maybeScheduleBotTurn(room);
    }
  }
}

function advanceBotSimStepSync(room: LiveRoom): boolean {
  if (!roomHasSimBots(room)) return false;
  ensureColorAsk(room);
  if (room.match.status === "color_ask") {
    return advanceSimColorAsk(room);
  }

  const deal = room.match.deal;
  if (
    room.match.status !== "playing" ||
    !deal ||
    deal.pendingSettle ||
    deal.finished ||
    isDealLocked(room)
  ) {
    return false;
  }

  if (deal.pendingRaise && deal.pendingRaiseFrom !== null) {
    const responder = nextSeat(deal.pendingRaiseFrom, room.match.config.mode);
    if (!isBotSeat(room, responder)) return false;
    room.match = respondRaise(room.match, responder, "accept");
    return true;
  }

  const seat = deal.turnSeat;
  if (!isBotSeat(room, seat)) return false;
  room.match = autoPlayForSeat(room.match, seat);
  if (room.match.deal?.pendingSettle) {
    scheduleSettle(room);
  }
  return true;
}

function runBotPlayTurn(room: LiveRoom, seat: SeatIndex) {
  room.match = autoPlayForSeat(room.match, seat);
  if (room.match.deal?.pendingSettle) {
    broadcastRoom(room);
    scheduleSettle(room);
    return;
  }
  if (room.match.status === "playing") scheduleTurnTimer(room);
  broadcastRoom(room);
}

function maybeScheduleBotTurn(room: LiveRoom) {
  clearBotTimer(room);
  const deal = room.match.deal;
  if (
    room.match.status !== "playing" ||
    !deal ||
    deal.pendingSettle ||
    deal.pendingRaise ||
    isDealLocked(room)
  ) {
    return;
  }
  const seat = deal.turnSeat;
  if (!isBotSeat(room, seat)) return;

  room.botTimer = setTimeout(() => {
    try {
      runBotPlayTurn(room, seat);
    } catch {
      // ignore bot play failures
    }
  }, BOT_STEP_MS);
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

function clearDealLockTimer(room: LiveRoom) {
  if (room.dealLockTimer) {
    clearTimeout(room.dealLockTimer);
    room.dealLockTimer = null;
  }
}

function isDealLocked(room: LiveRoom): boolean {
  return room.dealLockedUntil != null && Date.now() < room.dealLockedUntil;
}

function assertNotDealLocked(room: LiveRoom) {
  if (isDealLocked(room)) {
    throw new AppError(400, "DEAL_IN_PROGRESS", "კარტები ჯერ რიგდება.");
  }
}

function dealLockMs(cardCount: number): number {
  if (cardCount <= 0) return 0;
  return Math.max(DEAL_LOCK_MIN_MS, cardCount * DEAL_CARD_MS);
}

function cardsDealtDelta(
  before: BuraDealState | null | undefined,
  after: BuraDealState | null | undefined,
  mode: "1v1" | "2v2",
): number {
  if (!before || !after) return 0;
  let n = 0;
  for (const seat of activeSeatsForMode(mode)) {
    n += Math.max(0, after.hands[seat].length - before.hands[seat].length);
  }
  return n;
}

function totalHandCards(deal: BuraDealState, mode: "1v1" | "2v2"): number {
  let n = 0;
  for (const seat of activeSeatsForMode(mode)) {
    n += deal.hands[seat].length;
  }
  return n;
}

/** Hold play/bots until client deal flights finish, then start the turn. */
function scheduleTurnAfterDeal(room: LiveRoom, cardsDealt: number) {
  clearDealLockTimer(room);
  clearTurnTimer(room);
  clearBotTimer(room);
  const ms = dealLockMs(cardsDealt);
  if (ms <= 0) {
    room.dealLockedUntil = null;
    scheduleTurnTimer(room);
    return;
  }
  room.dealLockedUntil = Date.now() + ms;
  room.dealLockTimer = setTimeout(() => {
    room.dealLockTimer = null;
    room.dealLockedUntil = null;
    if (room.match.status === "playing") {
      scheduleTurnTimer(room);
      broadcastRoom(room);
    }
  }, ms);
}

function scheduleNextDealAfterBetween(room: LiveRoom) {
  clearSettleTimer(room);
  clearTurnTimer(room);
  clearDealLockTimer(room);
  room.dealLockedUntil = null;
  room.nextDealAt = Date.now() + BETWEEN_DEALS_MS;
  room.settleTimer = setTimeout(() => {
    try {
      room.match = startDeal(room.match);
      room.settleTimer = null;
      room.nextDealAt = null;
      if (room.match.status === "playing" && room.match.deal) {
        scheduleTurnAfterDeal(
          room,
          totalHandCards(room.match.deal, room.match.config.mode),
        );
      }
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
  clearBotTimer(room);
  room.settleTimer = setTimeout(() => {
    try {
      const beforeDeal = room.match.deal;
      room.match = settleResolvedTrick(room.match);
      room.settleTimer = null;
      if (room.match.status === "between") {
        scheduleNextDealAfterBetween(room);
        broadcastRoom(room);
        return;
      }

      if (room.match.status === "playing") {
        const dealt = cardsDealtDelta(
          beforeDeal,
          room.match.deal,
          room.match.config.mode,
        );
        scheduleTurnAfterDeal(room, dealt);
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
  if (room.match.deal.pendingSettle) return;
  if (isDealLocked(room)) return;

  const seat = room.match.deal.turnSeat;
  if (isBotSeat(room, seat)) {
    maybeScheduleBotTurn(room);
    return;
  }

  room.turnDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    try {
      const seat = room.match.deal?.turnSeat;
      if (seat === undefined) return;
      room.match = autoPlayForSeat(room.match, seat);
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
    ? publicDealView(
        deal,
        me.seat,
        room.match.config.malyutkaMode,
        room.match.config.mode,
      )
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
    dealLockedUntil: room.dealLockedUntil,
    mySeat: me.seat,
    config: {
      matchTo: room.match.config.matchTo,
      malyutkaMode: room.match.config.malyutkaMode,
      mode: room.match.config.mode,
    },
    players: room.players.map((p) => ({
      seat: p.seat,
      userId: p.userId,
      username: p.username,
      iconUrl: p.iconUrl,
      team: teamOf(p.seat, room.match.config.mode),
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
  clearDealLockTimer(room);
  room.dealLockedUntil = null;

  if (!room.leaderboardAwarded) {
    room.leaderboardAwarded = true;
    const score0 = room.match.scores[0] ?? 0;
    const score1 = room.match.scores[1] ?? 0;
    const resolvedTeam = (score0 >= score1 ? 0 : 1) as 0 | 1;
    const winnerUserIds = room.players
      .filter((p) => teamOf(p.seat, room.match.config.mode) === resolvedTeam)
      .map((p) => p.userId)
      .filter((id) => !isSimBotUserId(id));
    const allUserIds = room.players
      .map((p) => p.userId)
      .filter((id) => !isSimBotUserId(id));
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
  if (!deal) return;
  if (room.buraChatDeal === room.match.dealNumber) return;

  const trick =
    deal.pendingSettle && deal.lastResolved
      ? deal.lastResolved.trick
      : deal.endReason === "bura" && deal.lastResolved
        ? deal.lastResolved.trick
        : null;
  if (!trick || !isBuraTrick(trick, deal.trump)) return;

  room.buraChatDeal = room.match.dealNumber;
  const seat = deal.lastResolved?.winnerSeat ?? trick[0]?.seat;
  const speaker = room.players.find((p) => p.seat === seat) ?? room.players[0];
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
  resolveSimColorAsk(room);
  for (const player of room.players) {
    if (isSimBotUserId(player.userId)) continue;
    emitToUser(player.userId, "bura:state", viewerPayload(room, player.userId));
  }
  scheduleBotSimFollowUp(room);
}

export async function createBuraLiveRoom(input: {
  roomId: string;
  game: "bura";
  userIds: string[];
  matchTo?: number;
  malyutkaMode?: "turn" | "anytime";
  mode?: "1v1" | "2v2";
}) {
  const mode = input.mode === "1v1" ? "1v1" : "2v2";
  const expected = mode === "1v1" ? 2 : 4;
  if (input.userIds.length !== expected) {
    throw new AppError(
      400,
      mode === "1v1" ? "NEED_2" : "NEED_4",
      mode === "1v1" ? "სჭირდება 2 მოთამაშე." : "სჭირდება 4 მოთამაშე.",
    );
  }

  const existing = rooms.get(input.roomId);
  if (existing) {
    broadcastRoom(existing);
    return existing;
  }

  const profiles = await resolvePlayers(input.userIds);
  // 1v1: opposite seats 0 and 2 (viewer sees opponent on top).
  // 2v2: classic join order → seats 0,1,2,3.
  const seatIndexes: SeatIndex[] =
    mode === "1v1" ? [0, 2] : [0, 1, 2, 3];

  const seats: PlayerSeat[] = profiles.map((p, index) => {
    const seat = seatIndexes[index]!;
    return {
      seat,
      userId: p.userId,
      username: p.username,
      team: teamOf(seat, mode),
    };
  });

  const players: RoomPlayer[] = profiles.map((p, index) => ({
    ...p,
    seat: seatIndexes[index]!,
  }));

  const matchTo = Math.min(11, Math.max(3, input.matchTo ?? 11));
  const malyutkaMode = input.malyutkaMode === "anytime" ? "anytime" : "turn";

  const match = startDeal(
    createMatch(input.roomId, seats, { matchTo, malyutkaMode, mode }),
  );

  const room: LiveRoom = {
    roomId: input.roomId,
    game: input.game,
    players,
    match,
    turnDeadline: null,
    nextDealAt: null,
    dealLockedUntil: null,
    turnTimer: null,
    botTimer: null,
    settleTimer: null,
    dealLockTimer: null,
    finishTimer: null,
  };
  rooms.set(input.roomId, room);

  broadcastRoom(room);
  return room;
}

export function getBuraLiveRoom(roomId: string) {
  return rooms.get(roomId) ?? null;
}

export function getBuraRoomView(roomId: string, userId: string) {
  const room = rooms.get(roomId);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "ოთახი ვერ მოიძებნა.");
  resolveSimColorAsk(room);
  // HTTP fallback: advance a few bot steps per poll (timers + socket may be missed on mobile).
  for (let i = 0; i < 8; i++) {
    if (!advanceBotSimStepSync(room)) break;
  }
  scheduleBotSimFollowUp(room);
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
  assertNotDealLocked(room);

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
  assertNotDealLocked(room);

  try {
    room.match = declareBura(room.match, player.seat);
  } catch (err) {
    throw new AppError(
      400,
      "BURA_FAILED",
      err instanceof Error ? err.message : "ბურა ვერ გამოცხადდა.",
    );
  }

  scheduleSettle(room);
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
  assertNotDealLocked(room);

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
    // Accepted raise resumes the same turn with a fresh 15s timer.
    scheduleTurnTimer(room);
  }
  broadcastRoom(room);
  return viewerPayload(room, userId);
}

export function destroyBuraLiveRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTurnTimer(room);
  clearBotTimer(room);
  clearSettleTimer(room);
  clearDealLockTimer(room);
  if (room.finishTimer) {
    clearTimeout(room.finishTimer);
    room.finishTimer = null;
  }
  rooms.delete(roomId);
}

/** Active matches in progress (excludes finished cleanup window). */
export function countActiveLiveGames(): number {
  let count = 0;
  for (const room of rooms.values()) {
    if (room.match.status !== "finished") count++;
  }
  return count;
}

export type { Card, RaiseLevel };
