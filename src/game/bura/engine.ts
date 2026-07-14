import { randomBytes } from "crypto";
import { build36Deck, isTrump, shuffleDeck } from "./deck.js";
import {
  RAISE_POINTS,
  nextRaiseLevel,
  nextSeat,
  nextSeatOfTeam,
  refusePointsForPending,
  sumCardPoints,
  suitColor,
  teamOf,
  type BuraDealState,
  type BuraMatchConfig,
  type BuraMatchState,
  type Card,
  type ColorChoice,
  type PlayerSeat,
  type RaiseLevel,
  type SeatIndex,
  type TeamId,
} from "./types.js";

const DEFAULT_CONFIG: BuraMatchConfig = {
  matchTo: 11,
  handSize: 5,
  malyutkaMode: "turn",
};

function cryptoSeat(): SeatIndex {
  return (randomBytes(1)[0]! % 4) as SeatIndex;
}

export function createMatch(
  roomId: string,
  seats: PlayerSeat[],
  config: Partial<BuraMatchConfig> = {},
): BuraMatchState {
  if (seats.length !== 4) {
    throw new Error("Bura 2v2 requires exactly 4 seated players.");
  }

  return {
    roomId,
    seats,
    scores: { 0: 0, 1: 0 },
    dealerSeat: 0,
    nextLeadSeat: null,
    dealNumber: 0,
    deal: null,
    config: { ...DEFAULT_CONFIG, ...config },
    status: "between",
    carryRaise: null,
    carryLastRaiseTeam: null,
  };
}

export function startDeal(match: BuraMatchState): BuraMatchState {
  const shuffled = shuffleDeck(build36Deck());
  const hands: Record<SeatIndex, Card[]> = {
    0: [],
    1: [],
    2: [],
    3: [],
  };

  let cursor = 0;
  for (let round = 0; round < match.config.handSize; round += 1) {
    for (let seat = 0; seat < 4; seat += 1) {
      hands[seat as SeatIndex].push(shuffled[cursor]!);
      cursor += 1;
    }
  }

  const trumpCard = shuffled[cursor]!;
  cursor += 1;
  // Trump is shown face-up but remains the LAST dealable card in the stock.
  const remaining = [...shuffled.slice(cursor), trumpCard];
  const dealNumber = match.dealNumber + 1;
  const isFirstDeal = dealNumber === 1;

  const provisionalLead =
    !isFirstDeal && match.nextLeadSeat !== null
      ? match.nextLeadSeat
      : (((match.dealerSeat + 1) % 4) as SeatIndex);

  const askedSeat = isFirstDeal ? cryptoSeat() : null;

  // 60–60 replay: same დავი/სე/ჩარი (and who may raise next) until someone hits 61.
  const carriedRaise = match.carryRaise ?? "none";
  const carriedLastRaiseTeam = match.carryLastRaiseTeam;

  const deal: BuraDealState = {
    deckRemaining: remaining,
    trump: trumpCard.suit,
    trumpCard,
    hands,
    takenByTeam: { 0: [], 1: [] },
    currentTrick: [],
    leadSeat: provisionalLead,
    turnSeat: provisionalLead,
    raise: carriedRaise,
    pendingRaise: null,
    pendingRaiseFrom: null,
    lastRaiseTeam: carriedLastRaiseTeam,
    // askedSeat 0 is valid — must not use truthiness (0 is falsy).
    colorAsk:
      askedSeat !== null
        ? { askedSeat, answer: null, resolvedLeadSeat: null }
        : null,
    finished: false,
    winnerTeam: null,
    endReason: null,
    winningSeat: null,
    pendingSettle: false,
    lastResolved: null,
  };

  if (isFirstDeal) {
    return {
      ...match,
      dealNumber,
      deal,
      status: "color_ask",
      carryRaise: null,
      carryLastRaiseTeam: null,
    };
  }

  const buraSeat = findBuraSeat(deal);
  if (buraSeat !== null) {
    return finishDealWithWinner(match, deal, teamOf(buraSeat), "bura", dealNumber);
  }

  return {
    ...match,
    dealNumber,
    deal,
    status: "playing",
    carryRaise: null,
    carryLastRaiseTeam: null,
  };
}

/**
 * First-deal only: random player answers red/black.
 * Match trump color → that player leads; else next opponent (clockwise).
 */
export function answerColorAsk(
  match: BuraMatchState,
  fromSeat: SeatIndex,
  answer: ColorChoice,
): BuraMatchState {
  const deal = match.deal;
  if (!deal?.colorAsk || match.status !== "color_ask") {
    throw new Error("No color ask pending.");
  }
  if (fromSeat !== deal.colorAsk.askedSeat) {
    throw new Error("Not your color question.");
  }
  if (deal.colorAsk.answer) {
    throw new Error("Already answered.");
  }

  const trumpIs = suitColor(deal.trump);
  const leadSeat = answer === trumpIs ? fromSeat : nextSeat(fromSeat);

  const nextDeal: BuraDealState = {
    ...deal,
    leadSeat,
    turnSeat: leadSeat,
    colorAsk: {
      ...deal.colorAsk,
      answer,
      resolvedLeadSeat: leadSeat,
    },
  };

  const buraSeat = findBuraSeat(nextDeal);
  if (buraSeat !== null) {
    return finishDealWithWinner(
      match,
      nextDeal,
      teamOf(buraSeat),
      "bura",
      match.dealNumber,
    );
  }

  return {
    ...match,
    deal: nextDeal,
    status: "playing",
  };
}

function findBuraSeat(deal: BuraDealState): SeatIndex | null {
  for (let seat = 0; seat < 4; seat += 1) {
    const hand = deal.hands[seat as SeatIndex];
    if (
      hand.length === 5 &&
      hand.every((card) => isTrump(card, deal.trump))
    ) {
      return seat as SeatIndex;
    }
  }
  return null;
}

/** Exported for post-refill bura checks. */
export { findBuraSeat };

export function finishDealWithWinner(
  match: BuraMatchState,
  deal: BuraDealState,
  winnerTeam: TeamId,
  endReason: "bura" | "points" | "refuse" | "draw",
  dealNumber = match.dealNumber,
  refuseAwardPoints?: number,
): BuraMatchState {
  const points =
    endReason === "draw"
      ? 0
      : endReason === "refuse"
        ? (refuseAwardPoints ??
          (deal.pendingRaise ? refusePointsForPending(deal.pendingRaise) : 1))
        : RAISE_POINTS[deal.raise];

  const scores = {
    ...match.scores,
    [winnerTeam]: match.scores[winnerTeam] + points,
  } as Record<TeamId, number>;

  const finishedDeal: BuraDealState = {
    ...deal,
    pendingRaise: null,
    pendingRaiseFrom: null,
    // Keep raise / lastRaiseTeam on a draw so UI + carry show same stake round.
    lastRaiseTeam: endReason === "draw" ? deal.lastRaiseTeam : null,
    finished: true,
    winnerTeam: endReason === "draw" ? null : winnerTeam,
    endReason: endReason === "draw" ? "draw" : endReason,
    winningSeat: null,
    pendingSettle: false,
    lastResolved: null,
  };

  const loserTeam = (winnerTeam === 0 ? 1 : 0) as TeamId;
  // Draw = same stake round replay: keep the same lead; otherwise losers lead.
  const nextLead =
    endReason === "draw"
      ? finishedDeal.leadSeat
      : nextSeatOfTeam(finishedDeal.leadSeat, loserTeam);

  const matchFinished =
    endReason !== "draw" &&
    (scores[0] >= match.config.matchTo || scores[1] >= match.config.matchTo);

  return {
    ...match,
    scores,
    deal: finishedDeal,
    dealNumber,
    nextLeadSeat: nextLead,
    status: matchFinished ? "finished" : "between",
    // Don't rotate dealer on a 60–60 replay of the same round.
    dealerSeat:
      endReason === "draw"
        ? match.dealerSeat
        : (((match.dealerSeat + 1) % 4) as SeatIndex),
    carryRaise: endReason === "draw" ? deal.raise : null,
    carryLastRaiseTeam: endReason === "draw" ? deal.lastRaiseTeam : null,
  };
}

/** All cards played — count taken piles: ≥61 wins, 60–60 draw. */
export function finishDealByTakenPoints(match: BuraMatchState): BuraMatchState {
  const deal = match.deal;
  if (!deal) return match;
  const p0 = sumCardPoints(deal.takenByTeam[0]);
  const p1 = sumCardPoints(deal.takenByTeam[1]);
  if (p0 === 60 && p1 === 60) {
    return finishDealWithWinner(match, deal, 0, "draw");
  }
  if (p0 >= 61 && p0 >= p1) {
    return finishDealWithWinner(match, deal, 0, "points");
  }
  if (p1 >= 61) {
    return finishDealWithWinner(match, deal, 1, "points");
  }
  // Fallback: higher score wins (shouldn't happen with standard deck).
  if (p0 !== p1) {
    return finishDealWithWinner(match, deal, p0 > p1 ? 0 : 1, "points");
  }
  return finishDealWithWinner(match, deal, 0, "draw");
}

export function canOfferRaise(current: RaiseLevel, next: RaiseLevel): boolean {
  return nextRaiseLevel(current) === next;
}

/**
 * Offer დავი / სე / ჩარი.
 * Sequence only: none→davi→se→chari.
 * After your team locked a raise, only the opposite team may raise next.
 */
export function offerRaise(
  match: BuraMatchState,
  fromSeat: SeatIndex,
  level: RaiseLevel,
): BuraMatchState {
  if (!match.deal || match.deal.finished || match.status !== "playing") {
    throw new Error("ხელი არ მიდის.");
  }
  if (match.deal.pendingSettle) {
    throw new Error("ცოტა დაიცადე.");
  }
  if (match.deal.turnSeat !== fromSeat) {
    throw new Error("შეთავაზება მხოლოდ შენს სვლაზე.");
  }
  if (match.deal.pendingRaise) {
    throw new Error("უკვე არის შეთავაზება — დაელოდე პასუხს.");
  }
  if (!canOfferRaise(match.deal.raise, level)) {
    throw new Error("ეს დონე ახლა არ შეიძლება.");
  }
  const myTeam = teamOf(fromSeat);
  if (
    match.deal.lastRaiseTeam !== null &&
    match.deal.lastRaiseTeam === myTeam
  ) {
    throw new Error("შენმა წყვილმა უკვე თქვა — მოწინააღმდეგეს ეხლა.");
  }

  return {
    ...match,
    deal: {
      ...match.deal,
      pendingRaise: level,
      pendingRaiseFrom: fromSeat,
    },
  };
}

export type RaiseResponse = "accept" | "refuse" | "counter";

/**
 * Opponent answers pending raise:
 * - accept → stake locks, play continues
 * - refuse → offering team scores previous stake, round ends
 * - counter → bump to next level (სე after დავი, ჩარი after სე)
 */
export function respondRaise(
  match: BuraMatchState,
  responderSeat: SeatIndex,
  response: RaiseResponse,
): BuraMatchState {
  const deal = match.deal;
  if (!deal || !deal.pendingRaise || deal.pendingRaiseFrom === null) {
    throw new Error("შეთავაზება არ არის.");
  }
  if (deal.finished || match.status !== "playing") {
    throw new Error("ხელი არ მიდის.");
  }
  // Only the next clockwise seat after the offerer answers (always opposite team).
  const responder = nextSeat(deal.pendingRaiseFrom);
  if (responderSeat !== responder) {
    throw new Error("პასუხი მხოლოდ შემდეგ მოწინააღმდეგეს შეუძლია.");
  }

  if (response === "accept") {
    return {
      ...match,
      deal: {
        ...deal,
        raise: deal.pendingRaise,
        lastRaiseTeam: teamOf(deal.pendingRaiseFrom),
        pendingRaise: null,
        pendingRaiseFrom: null,
      },
    };
  }

  if (response === "refuse") {
    const raisingTeam = teamOf(deal.pendingRaiseFrom);
    const award = refusePointsForPending(deal.pendingRaise);
    return finishDealWithWinner(
      match,
      deal,
      raisingTeam,
      "refuse",
      match.dealNumber,
      award,
    );
  }

  const counterLevel = nextRaiseLevel(deal.pendingRaise);
  if (!counterLevel) {
    throw new Error("ჩარის შემდეგ კონტრი აღარ არის.");
  }
  return {
    ...match,
    deal: {
      ...deal,
      pendingRaise: counterLevel,
      pendingRaiseFrom: responderSeat,
    },
  };
}

export function publicDealView(
  deal: BuraDealState,
  viewerSeat: SeatIndex,
  malyutkaMode: "turn" | "anytime" = "turn",
) {
  const trumpStillInStock = deal.deckRemaining.some(
    (c) => c.id === deal.trumpCard.id,
  );
  const nextLevel = nextRaiseLevel(deal.raise);
  const myTeam = teamOf(viewerSeat);
  const canOffer =
    !deal.finished &&
    !deal.pendingRaise &&
    !deal.pendingSettle &&
    deal.turnSeat === viewerSeat &&
    nextLevel !== null &&
    (deal.lastRaiseTeam === null || deal.lastRaiseTeam !== myTeam);
  const raiseResponder =
    deal.pendingRaiseFrom !== null ? nextSeat(deal.pendingRaiseFrom) : null;
  const canRespond =
    !deal.finished &&
    deal.pendingRaise !== null &&
    raiseResponder !== null &&
    viewerSeat === raiseResponder;
  const counterLevel =
    deal.pendingRaise !== null ? nextRaiseLevel(deal.pendingRaise) : null;

  const hand = deal.hands[viewerSeat];
  const isPlaying =
    !deal.finished &&
    !deal.pendingRaise &&
    !deal.pendingSettle &&
    deal.endReason === null;
  const leadCount = deal.currentTrick[0]?.cards.length ?? 0;
  const myTurn = deal.turnSeat === viewerSeat;
  const hasMalyutka =
    hand.length === 5 &&
    hand.every((c) => c.suit === hand[0]!.suit) &&
    hand[0]!.suit !== deal.trump;
  const hasBura =
    hand.length === 5 && hand.every((c) => c.suit === deal.trump);

  let canOfferMalyutka = false;
  if (isPlaying && hasMalyutka && leadCount !== 5) {
    if (malyutkaMode === "turn") {
      canOfferMalyutka = myTurn && deal.currentTrick.length === 0;
    } else {
      canOfferMalyutka =
        myTurn || deal.currentTrick.length > 0;
    }
  }

  return {
    trump: deal.trump,
    // Always show face for reference — even after the trump card was dealt from stock.
    trumpCard: deal.trumpCard,
    trumpInStock: trumpStillInStock,
    raise: deal.raise,
    pendingRaise: deal.pendingRaise,
    pendingRaiseFrom: deal.pendingRaiseFrom,
    lastRaiseTeam: deal.lastRaiseTeam,
    stakePoints: RAISE_POINTS[deal.raise],
    canOfferRaise: canOffer ? nextLevel : null,
    canRespondRaise: canRespond,
    canCounterRaise: canRespond ? counterLevel : null,
    canOfferMalyutka,
    canDeclareBura: isPlaying && hasBura,
    leadSeat: deal.leadSeat,
    turnSeat: deal.turnSeat,
    winningSeat: deal.winningSeat,
    pendingSettle: deal.pendingSettle,
    currentTrick: deal.currentTrick,
    lastResolved: deal.lastResolved,
    colorAsk: deal.colorAsk,
    finished: deal.finished,
    winnerTeam: deal.winnerTeam,
    endReason: deal.endReason,
    stockCount: trumpStillInStock
      ? Math.max(0, deal.deckRemaining.length - 1)
      : deal.deckRemaining.length,
    teamPoints: {
      0: sumCardPoints(deal.takenByTeam[0]),
      1: sumCardPoints(deal.takenByTeam[1]),
    },
    myHand: deal.hands[viewerSeat],
    handCounts: {
      0: deal.hands[0].length,
      1: deal.hands[1].length,
      2: deal.hands[2].length,
      3: deal.hands[3].length,
    },
    takenCounts: {
      0: deal.takenByTeam[0].length,
      1: deal.takenByTeam[1].length,
    },
  };
}

export function refillHandsAfterTrick(
  deal: BuraDealState,
  winnerSeat: SeatIndex,
  handSize = 5,
): BuraDealState {
  const hands: Record<SeatIndex, Card[]> = {
    0: [...deal.hands[0]],
    1: [...deal.hands[1]],
    2: [...deal.hands[2]],
    3: [...deal.hands[3]],
  };
  const stock = [...deal.deckRemaining];

  /**
   * Round-robin full rounds so hands stay equal.
   * Stock includes the face-up trump as its last card — it will be dealt.
   */
  for (;;) {
    const needy: SeatIndex[] = [];
    for (let offset = 0; offset < 4; offset += 1) {
      const seat = ((winnerSeat + offset) % 4) as SeatIndex;
      if (hands[seat].length < handSize) needy.push(seat);
    }
    if (needy.length === 0) break;
    if (stock.length < needy.length) break;

    for (const seat of needy) {
      hands[seat].push(stock.shift()!);
    }
  }

  return {
    ...deal,
    hands,
    deckRemaining: stock,
  };
}

export { build36Deck, shuffleDeck, cardAssetPath } from "./deck.js";
export * from "./types.js";
