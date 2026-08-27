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
import { finishDealByTakenPoints, finishDealWithWinner, refillHandsAfterTrick } from "./engine.js";

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

/** Single-seat 5-trump play → round ends as ბურა after the usual collect animation. */
export function isBuraTrick(
  trick: Array<{ cards: Card[] }>,
  trump: Suit,
): boolean {
  if (trick.length !== 1) return false;
  const cards = trick[0]!.cards;
  return cards.length === 5 && cards.every((c) => c.suit === trump);
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

  if (isBuraTrick(trick, deal.trump)) {
    return finishDealWithWinner(
      match,
      {
        ...deal,
        hands: deal.hands,
        currentTrick: [],
        takenByTeam,
        leadSeat: winnerSeat,
        turnSeat: winnerSeat,
        winningSeat: winnerSeat,
        pendingSettle: false,
        buraReveal: false,
        lastResolved: { trick, winnerSeat, winnerTeam },
      },
      winnerTeam,
      "bura",
    );
  }

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
 * Player with 5 trump presses ბურა: lay all five, collect animation, then win the round.
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
  if (deal.turnSeat !== fromSeat) {
    throw new Error("არ არის შენი სვლა.");
  }
  const hand = deal.hands[fromSeat];
  if (!isBuraHand(hand, deal.trump)) {
    throw new Error("ბურა მხოლოდ 5 კოზირით.");
  }

  const hands: Record<SeatIndex, Card[]> = {
    0: [...deal.hands[0]],
    1: [...deal.hands[1]],
    2: [...deal.hands[2]],
    3: [...deal.hands[3]],
  };
  for (const play of deal.currentTrick) {
    if (play.seat === fromSeat) continue;
    hands[play.seat] = [...hands[play.seat], ...play.cards];
  }
  hands[fromSeat] = [];

  const cards = [...hand];
  const winnerTeam = teamOf(fromSeat, match.config.mode);
  const trick = [{ seat: fromSeat, cards }];
  return {
    ...match,
    deal: {
      ...deal,
      hands,
      currentTrick: trick,
      leadSeat: fromSeat,
      turnSeat: fromSeat,
      winningSeat: fromSeat,
      pendingSettle: true,
      buraReveal: false,
      lastResolved: {
        trick,
        winnerSeat: fromSeat,
        winnerTeam,
      },
    },
  };
}

/**
 * Bot / timeout auto-play: legal + elementary tactics.
 * Lead: same-suit 1–3 cards when dumping blanks is worth it; avoid wasteful trump.
 * Follow: cheapest beat of საჭრელი, else cheapest dump.
 * ბურა / მალიუტკა when the hand clearly allows it.
 */
export function autoPlayForSeat(match: BuraMatchState, seat: SeatIndex): BuraMatchState {
  const deal = match.deal;
  if (!deal || deal.turnSeat !== seat || deal.pendingSettle || deal.buraReveal) {
    return match;
  }
  const hand = deal.hands[seat];
  if (hand.length === 0) return match;

  if (!deal.pendingRaise && isBuraHand(hand, deal.trump)) {
    try {
      return declareBura(match, seat);
    } catch {
      // fall through
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
    // Clear მალიუტკა when we have it on lead.
    if (isMalyutkaHand(hand, trump)) {
      return [...hand];
    }
    return pickLeadCards(hand, trump);
  }

  return pickFollowCards(deal, hand, trump);
}

function pickLeadCards(hand: Card[], trump: Suit): Card[] {
  const bySuit = new Map<Suit, Card[]>();
  for (const card of hand) {
    const list = bySuit.get(card.suit) ?? [];
    list.push(card);
    bySuit.set(card.suit, list);
  }

  type Option = { cards: Card[]; score: number };
  const options: Option[] = [];

  for (const [suit, raw] of bySuit) {
    const weakFirst = [...raw].sort((a, b) => cardSortWeakFirst(a, b, trump));
    const strongFirst = [...weakFirst].reverse();
    const isTrumpSuit = suit === trump;
    const maxK = Math.min(weakFirst.length, isTrumpSuit ? 2 : 3);

    for (let k = 1; k <= maxK; k += 1) {
      const cards = weakFirst.slice(0, k);
      const pts = cards.reduce((s, c) => s + cardPointsOf(c), 0);
      let score = 0;

      // Prefer non-trump leads.
      score += isTrumpSuit ? -30 : 35;
      // Prefer dumping low / blank cards.
      score -= pts * 4;
      score -= cards.reduce((s, c) => s + rankValue(c.rank), 0);

      // Multi-card lead when blanks (or near-blanks) — forces others to spend cards.
      if (k >= 2 && pts === 0) score += 28 + k * 10;
      else if (k >= 2 && pts <= 4) score += 14 + k * 4;
      else if (k >= 2 && pts >= 14) score -= 18; // A+10 dump lead is usually bad

      // Clearing the whole suit is tidy.
      if (k === weakFirst.length && !isTrumpSuit && k >= 2) score += 12;

      // Leading a lone high trump is last resort.
      if (isTrumpSuit && k === 1 && pts >= 10) score -= 8;

      options.push({ cards, score });
    }

    // Sometimes lead Ace (or 10) alone to try and take — not mixed with weak.
    const top = strongFirst[0]!;
    if (top.rank === "A" || top.rank === "10") {
      let score = isTrumpSuit ? -5 : 32;
      score += cardPointsOf(top); // want those points home if we win
      if (top.rank === "A" && !isTrumpSuit) score += 6;
      options.push({ cards: [top], score });
    }
  }

  if (options.length === 0) return [hand[0]!];
  options.sort((a, b) => b.score - a.score);
  return options[0]!.cards;
}

function pickFollowCards(
  deal: NonNullable<BuraMatchState["deal"]>,
  hand: Card[],
  trump: Suit,
): Card[] | null {
  const need = deal.currentTrick[0]!.cards.length;
  if (hand.length < need) return null;

  const winSeat = winningPlaySeat(deal.currentTrick, trump);
  const winPlay = deal.currentTrick.find((p) => p.seat === winSeat)!;
  const target = winPlay.cards;
  const ledSuit = deal.currentTrick[0]!.cards[0]!.suit;
  const trickPoints =
    deal.currentTrick.reduce((s, p) => s + p.cards.reduce((t, c) => t + cardPointsOf(c), 0), 0) +
    target.reduce((s, c) => s + cardPointsOf(c), 0) / 2;

  const combos = combinations(hand, need);
  let bestBeat: Card[] | null = null;
  let bestBeatCost = Infinity;
  let bestDump: Card[] | null = null;
  let bestDumpCost = Infinity;

  for (const combo of combos) {
    const pts = combo.reduce((s, c) => s + cardPointsOf(c), 0);
    const trumps = combo.filter((c) => isTrump(c, trump)).length;
    const rankSum = combo.reduce((s, c) => s + rankValue(c.rank), 0);
    // Prefer same-suit overtrump; penalize spending trump / high points.
    const cost = pts * 100 + rankSum + trumps * 55;

    if (playBeatsLeadPlay(combo, target, trump, ledSuit)) {
      // Worth beating a bit more when the trick already has points.
      const adjusted = cost - Math.min(40, trickPoints);
      if (adjusted < bestBeatCost) {
        bestBeatCost = adjusted;
        bestBeat = combo;
      }
    } else if (cost < bestDumpCost) {
      bestDumpCost = cost;
      bestDump = combo;
    }
  }

  if (bestBeat) return bestBeat;
  if (bestDump) return bestDump;

  return [...hand]
    .sort((a, b) => cardSortWeakFirst(a, b, trump))
    .slice(0, need);
}

function combinations<T>(items: T[], k: number): T[][] {
  if (k <= 0) return [[]];
  if (k > items.length) return [];
  if (k === items.length) return [items.slice()];
  const out: T[][] = [];
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
