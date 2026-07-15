import {
  CARD_POINTS,
  activeSeatsForMode,
  nextSeat,
  playerCountForMode,
  RANK_ORDER,
  teamOf,
  type BuraDealState,
  type BuraMatchState,
  type Card,
  type Rank,
  type SeatIndex,
  type Suit,
} from "./types.js";
import { isTrump } from "./deck.js";
import { finishDealByTakenPoints, refillHandsAfterTrick } from "./engine.js";

function rankValue(rank: Rank): number {
  return RANK_ORDER.length - RANK_ORDER.indexOf(rank);
}

function cardSortWeakFirst(a: Card, b: Card, trump: Suit): number {
  const aT = isTrump(a, trump) ? 1 : 0;
  const bT = isTrump(b, trump) ? 1 : 0;
  if (aT !== bT) return aT - bT;
  return rankValue(a.rank) - rankValue(b.rank);
}

function cardPointsOf(card: Card): number {
  return CARD_POINTS[card.rank];
}

/** Does `a` beat `b`? `ledSuit` = suit of the card being answered. */
function beats(a: Card, b: Card, trump: Suit, ledSuit: Suit): boolean {
  const aTrump = isTrump(a, trump);
  const bTrump = isTrump(b, trump);
  if (aTrump && !bTrump) return true;
  if (!aTrump && bTrump) return false;
  if (aTrump && bTrump) return rankValue(a.rank) > rankValue(b.rank);
  if (a.suit === ledSuit && b.suit !== ledSuit) return true;
  if (a.suit !== ledSuit && b.suit === ledSuit) return false;
  if (a.suit === b.suit) return rankValue(a.rank) > rankValue(b.rank);
  return false;
}

/**
 * Multi-card beat: response can pair cards in any order.
 */
export function playBeatsLeadPlay(
  response: Card[],
  target: Card[],
  trump: Suit,
  ledSuit: Suit,
): boolean {
  if (response.length !== target.length) return false;
  if (response.length === 0) return false;

  const targets = [...target].sort((a, b) => {
    const aT = isTrump(a, trump) ? 1 : 0;
    const bT = isTrump(b, trump) ? 1 : 0;
    if (aT !== bT) return bT - aT;
    return rankValue(b.rank) - rankValue(a.rank);
  });

  const available = response.map((card, index) => ({ card, index }));
  for (const need of targets) {
    let bestIdx = -1;
    let bestRank = Infinity;
    for (let i = 0; i < available.length; i += 1) {
      const candidate = available[i]!;
      if (!beats(candidate.card, need, trump, ledSuit)) continue;
      const rv = rankValue(candidate.card.rank);
      if (rv < bestRank) {
        bestRank = rv;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return false;
    available.splice(bestIdx, 1);
  }
  return true;
}

export function winningPlaySeat(
  trick: BuraDealState["currentTrick"],
  trump: Suit,
): SeatIndex {
  const lead = trick[0]!;
  let winner = lead.seat;
  let winningCards = lead.cards;
  const ledSuit = lead.cards[0]!.suit;
  for (let i = 1; i < trick.length; i += 1) {
    const play = trick[i]!;
    if (playBeatsLeadPlay(play.cards, winningCards, trump, ledSuit)) {
      winner = play.seat;
      winningCards = play.cards;
    }
  }
  return winner;
}

export function assertSameSuit(cards: Card[]) {
  if (cards.length === 0) throw new Error("აირჩიე კარტი.");
  const suit = cards[0]!.suit;
  if (!cards.every((c) => c.suit === suit)) {
    throw new Error("პირველ სვლაზე მხოლოდ ერთი მასტი.");
  }
}

/** 5 same-suit cards from a 5-card hand → მალიუტკა (not trump-bura). */
export function isMalyutkaPlay(hand: Card[], cards: Card[]): boolean {
  return hand.length === 5 && cards.length === 5 && cards.every((c) => c.suit === cards[0]!.suit);
}

export function isMalyutkaHand(hand: Card[], trump: Suit): boolean {
  return (
    hand.length === 5 &&
    hand.every((c) => c.suit === hand[0]!.suit) &&
    hand[0]!.suit !== trump
  );
}

export function isBuraHand(hand: Card[], trump: Suit): boolean {
  return hand.length === 5 && hand.every((c) => c.suit === trump);
}

function applyMalyutkaLead(
  match: BuraMatchState,
  deal: NonNullable<BuraMatchState["deal"]>,
  fromSeat: SeatIndex,
  handAfterPlay: Card[],
  cards: Card[],
): BuraMatchState {
  const returnedTrick = [...deal.currentTrick];
  const hands: Record<SeatIndex, Card[]> = {
    0: [...deal.hands[0]],
    1: [...deal.hands[1]],
    2: [...deal.hands[2]],
    3: [...deal.hands[3]],
  };
  for (const play of returnedTrick) {
    hands[play.seat] = [...hands[play.seat], ...play.cards];
  }
  hands[fromSeat] = handAfterPlay;

  return {
    ...match,
    deal: {
      ...deal,
      hands,
      currentTrick: [{ seat: fromSeat, cards }],
      leadSeat: fromSeat,
      turnSeat: nextSeat(fromSeat, match.config.mode),
      winningSeat: fromSeat,
      pendingSettle: false,
      lastResolved: null,
    },
  };
}

export function playCards(
  match: BuraMatchState,
  fromSeat: SeatIndex,
  cardIds: string[],
): BuraMatchState {
  if (match.status !== "playing" || !match.deal || match.deal.finished) {
    throw new Error("თამაში არ მიდის.");
  }
  const deal = match.deal;
  if (deal.buraReveal) {
    throw new Error("ბურა უკვე გამოცხადებულია.");
  }
  if (deal.pendingSettle) {
    throw new Error("ცოტა დაიცადე — კარტები იღება.");
  }

  const hand = [...deal.hands[fromSeat]];
  const cards: Card[] = [];
  for (const id of cardIds) {
    const idx = hand.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error("კარტი ხელში არ გაქვს.");
    cards.push(hand[idx]!);
    hand.splice(idx, 1);
  }

  if (deal.pendingRaise) {
    throw new Error("ჯერ შეთავაზებას უპასუხე.");
  }

  const mode = match.config.malyutkaMode;
  const leadCardCount = deal.currentTrick[0]?.cards.length ?? 0;
  const isMyTurn = deal.turnSeat === fromSeat;
  const wantsMalyutka =
    leadCardCount !== 5 && isMalyutkaPlay(deal.hands[fromSeat], cards);

  if (wantsMalyutka) {
    // 5 trump is ბურა — handled separately; reject as malyutka.
    if (cards.every((c) => c.suit === deal.trump)) {
      throw new Error("5 კოზირი ბურაა — არა მალიუტკა.");
    }

    if (mode === "turn") {
      // რიგით: only when you are leading (empty table + your turn).
      if (!isMyTurn || deal.currentTrick.length > 0) {
        throw new Error("რიგით მალიუტკა მხოლოდ შენს ლიდზე.");
      }
      return applyMalyutkaLead(match, deal, fromSeat, hand, cards);
    }

    // ურიგოდ: your turn (lead or mid-trick), OR off-turn after someone played.
    if (isMyTurn) {
      return applyMalyutkaLead(match, deal, fromSeat, hand, cards);
    }
    if (deal.currentTrick.length > 0) {
      return applyMalyutkaLead(match, deal, fromSeat, hand, cards);
    }
    throw new Error("ურიგოდ მალიუტკა — დაელოდე სანამ სხვები ჩამოვლენ.");
  }

  if (!isMyTurn) {
    throw new Error("შენი სვლა არაა.");
  }

  const isLead = deal.currentTrick.length === 0;
  if (isLead) {
    assertSameSuit(cards);
  } else {
    const leadCount = deal.currentTrick[0]!.cards.length;
    if (cards.length !== leadCount) {
      throw new Error(`უნდა ითამაშო ${leadCount} კარტი.`);
    }
  }

  const hands = { ...deal.hands, [fromSeat]: hand };
  const currentTrick = [...deal.currentTrick, { seat: fromSeat, cards }];
  const winningSeat = winningPlaySeat(currentTrick, deal.trump);
  const seatsInTrick = playerCountForMode(match.config.mode);

  if (currentTrick.length < seatsInTrick) {
    return {
      ...match,
      deal: {
        ...deal,
        hands,
        currentTrick,
        turnSeat: nextSeat(fromSeat, match.config.mode),
        lastResolved: null,
        pendingSettle: false,
        winningSeat,
      },
    };
  }

  const winnerTeam = teamOf(winningSeat, match.config.mode);
  return {
    ...match,
    deal: {
      ...deal,
      hands,
      currentTrick,
      leadSeat: winningSeat,
      turnSeat: winningSeat,
      winningSeat,
      pendingSettle: true,
      lastResolved: {
        trick: currentTrick,
        winnerSeat: winningSeat,
        winnerTeam,
      },
    },
  };
}

export function settleResolvedTrick(match: BuraMatchState): BuraMatchState {
  const deal = match.deal;
  if (!deal?.pendingSettle || !deal.lastResolved) return match;

  const { winnerSeat, winnerTeam, trick } = deal.lastResolved;
  const captured = trick.flatMap((p) => p.cards);
  const takenByTeam = {
    ...deal.takenByTeam,
    [winnerTeam]: [...deal.takenByTeam[winnerTeam], ...captured],
  };

  let nextDeal: BuraDealState = {
    ...deal,
    hands: deal.hands,
    currentTrick: [],
    takenByTeam,
    leadSeat: winnerSeat,
    turnSeat: winnerSeat,
    winningSeat: winnerSeat,
    pendingSettle: false,
    lastResolved: {
      trick,
      winnerSeat,
      winnerTeam,
    },
  };
  nextDeal = refillHandsAfterTrick(
    nextDeal,
    winnerSeat,
    match.config.handSize,
    match.config.mode,
  );

  const active = activeSeatsForMode(match.config.mode);
  const allHandsEmpty = active.every((s) => nextDeal.hands[s].length === 0);
  if (allHandsEmpty) {
    return finishDealByTakenPoints({
      ...match,
      deal: nextDeal,
    });
  }

  return {
    ...match,
    // Winner of the trick always leads after refill — do not jump turn to a ბურა holder.
    deal: nextDeal,
  };
}

/**
 * Player with 5 trump presses ბურა on their turn: lay all five face-up.
 * Room service waits ~2.8s then scores the round.
 */
export function declareBura(
  match: BuraMatchState,
  fromSeat: SeatIndex,
): BuraMatchState {
  if (match.status !== "playing" || !match.deal || match.deal.finished) {
    throw new Error("თამაში არ მიდის.");
  }
  const deal = match.deal;
  if (deal.buraReveal) {
    throw new Error("ბურა უკვე გამოცხადებულია.");
  }
  if (deal.pendingSettle || deal.pendingRaise) {
    throw new Error("ახლა ბურა ვერ გამოცხადდება.");
  }
  if (deal.currentTrick.length > 0) {
    throw new Error("ჯერ მაგიდა უნდა იყოს ცარიელი.");
  }
  if (deal.turnSeat !== fromSeat) {
    throw new Error("არ არის შენი სვლა.");
  }
  const hand = deal.hands[fromSeat];
  if (!isBuraHand(hand, deal.trump)) {
    throw new Error("ბურა მხოლოდ 5 კოზირით.");
  }

  const cards = [...hand];
  return {
    ...match,
    deal: {
      ...deal,
      hands: {
        ...deal.hands,
        [fromSeat]: [],
      },
      currentTrick: [{ seat: fromSeat, cards }],
      turnSeat: fromSeat,
      winningSeat: fromSeat,
      pendingSettle: false,
      lastResolved: null,
      buraReveal: true,
    },
  };
}

/**
 * Timeout auto-play: legal + reasonably advantageous.
 * Lead: prefer longest same-suit that isn't pure trump waste; lowest ranks.
 * Follow: beat if possible with cheapest combo; else dump lowest points/rank.
 * If the seat holds ბურა, auto-declare instead of playing a card.
 */
export function autoPlayForSeat(match: BuraMatchState, seat: SeatIndex): BuraMatchState {
  const deal = match.deal;
  if (!deal || deal.turnSeat !== seat || deal.pendingSettle || deal.buraReveal) {
    return match;
  }
  const hand = deal.hands[seat];
  if (hand.length === 0) return match;

  if (
    deal.currentTrick.length === 0 &&
    !deal.pendingRaise &&
    isBuraHand(hand, deal.trump)
  ) {
    try {
      return declareBura(match, seat);
    } catch {
      // fall through to normal auto-play
    }
  }

  const chosen = pickAutoCards(deal, seat, hand);
  if (!chosen || chosen.length === 0) return match;

  try {
    return playCards(
      match,
      seat,
      chosen.map((c) => c.id),
    );
  } catch {
    return match;
  }
}

function pickAutoCards(
  deal: NonNullable<BuraMatchState["deal"]>,
  seat: SeatIndex,
  hand: Card[],
): Card[] | null {
  const trump = deal.trump;
  const isLead = deal.currentTrick.length === 0;

  if (isLead) {
    // Prefer longest non-trump suit; else longest trump; play lowest of that suit (1 or more? lead often 1 for safety when timeout).
    // Advantageous: dump point-less multi only if all same suit — keep simple: lead 1 weakest non-trump if any.
    const bySuit = new Map<Suit, Card[]>();
    for (const card of hand) {
      const list = bySuit.get(card.suit) ?? [];
      list.push(card);
      bySuit.set(card.suit, list);
    }
    let bestSuit: Suit | null = null;
    let bestScore = -Infinity;
    for (const [suit, list] of bySuit) {
      list.sort((a, b) => cardSortWeakFirst(a, b, trump));
      const nonTrumpBonus = suit === trump ? 0 : 10;
      const lowPoints = -list.reduce((s, c) => s + cardPointsOf(c), 0);
      const score = nonTrumpBonus * 100 + list.length * 10 + lowPoints;
      if (score > bestScore) {
        bestScore = score;
        bestSuit = suit;
      }
    }
    if (!bestSuit) return [hand[0]!];
    const suitCards = bySuit.get(bestSuit)!;
    // Lead only 1 on timeout — safest and still legal
    return [suitCards[0]!];
  }

  const need = deal.currentTrick[0]!.cards.length;
  if (hand.length < need) return null;

  const target = (() => {
    // Beat whoever is currently winning (საჭრელი), not only original lead.
    const winSeat = winningPlaySeat(deal.currentTrick, trump);
    const winPlay = deal.currentTrick.find((p) => p.seat === winSeat)!;
    return winPlay.cards;
  })();
  const ledSuit = deal.currentTrick[0]!.cards[0]!.suit;

  const combos = combinations(hand, need);
  let bestBeat: Card[] | null = null;
  let bestBeatCost = Infinity;
  let bestDump: Card[] | null = null;
  let bestDumpCost = Infinity;

  for (const combo of combos) {
    const cost =
      combo.reduce((s, c) => s + cardPointsOf(c), 0) * 100 +
      combo.reduce((s, c) => s + rankValue(c.rank), 0) +
      combo.filter((c) => isTrump(c, trump)).length * 50;

    if (playBeatsLeadPlay(combo, target, trump, ledSuit)) {
      if (cost < bestBeatCost) {
        bestBeatCost = cost;
        bestBeat = combo;
      }
    } else if (cost < bestDumpCost) {
      bestDumpCost = cost;
      bestDump = combo;
    }
  }

  if (bestBeat) return bestBeat;
  if (bestDump) return bestDump;

  // Fallback: weakest N cards (may mix suits — legal dump)
  return [...hand]
    .sort((a, b) => cardSortWeakFirst(a, b, trump))
    .slice(0, need);
}

function combinations<T>(items: T[], k: number): T[][] {
  if (k <= 0) return [[]];
  if (k > items.length) return [];
  if (k === items.length) return [items.slice()];
  const out: T[][] = [];
  // Keep search bounded for 5-choose-3 etc.
  function rec(start: number, acc: T[]) {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      acc.push(items[i]!);
      rec(i + 1, acc);
      acc.pop();
      if (out.length > 120) return;
    }
  }
  rec(0, []);
  return out;
}

export function cardPointsSum(cards: Card[]): number {
  return cards.reduce((s, c) => s + CARD_POINTS[c.rank], 0);
}
