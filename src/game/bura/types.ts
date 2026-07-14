export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank = "A" | "10" | "K" | "Q" | "J" | "9" | "8" | "7" | "6";

export type Card = {
  id: string;
  suit: Suit;
  rank: Rank;
};

export type RaiseLevel = "none" | "davi" | "se" | "chari";

export type SeatIndex = 0 | 1 | 2 | 3;

/** Partners: 0+2 vs 1+3 */
export type TeamId = 0 | 1;

export type PlayerSeat = {
  seat: SeatIndex;
  userId: string;
  username: string;
  team: TeamId;
};

export type BuraMatchConfig = {
  /** Match ends when a team reaches this score (3–11). */
  matchTo: number;
  handSize: 5;
  /** turn = რიგით (lead only); anytime = ურიგოდ (can interrupt). */
  malyutkaMode: "turn" | "anytime";
};

export type TrickPlay = {
  seat: SeatIndex;
  cards: Card[];
};

export type ColorChoice = "red" | "black";

export type ColorAskState = {
  askedSeat: SeatIndex;
  /** Set after answer; null while waiting */
  answer: ColorChoice | null;
  resolvedLeadSeat: SeatIndex | null;
};

export type BuraDealState = {
  deckRemaining: Card[];
  trump: Suit;
  trumpCard: Card;
  hands: Record<SeatIndex, Card[]>;
  takenByTeam: Record<TeamId, Card[]>;
  currentTrick: TrickPlay[];
  leadSeat: SeatIndex;
  turnSeat: SeatIndex;
  raise: RaiseLevel;
  pendingRaise: RaiseLevel | null;
  pendingRaiseFrom: SeatIndex | null;
  /** Team that last successfully locked a raise; they cannot raise next — only opponents. */
  lastRaiseTeam: TeamId | null;
  /** First deal only: red/black question before play starts */
  colorAsk: ColorAskState | null;
  finished: boolean;
  winnerTeam: TeamId | null;
  endReason: "bura" | "points" | "refuse" | "draw" | null;
  /** Whose cards are currently საჭრელი on the table */
  winningSeat: SeatIndex | null;
  /** Trick finished; waiting for collect animation then settle */
  pendingSettle: boolean;
  /** 5 trump laid on table — waiting short reveal before scoring */
  buraReveal: boolean;
  /** Just-resolved trick (for client animation); cleared after settle broadcast */
  lastResolved: {
    trick: TrickPlay[];
    winnerSeat: SeatIndex;
    winnerTeam: TeamId;
  } | null;
};

export type BuraMatchState = {
  roomId: string;
  seats: PlayerSeat[];
  scores: Record<TeamId, number>;
  dealerSeat: SeatIndex;
  /** Who should lead the next deal (set from prior deal loser pair) */
  nextLeadSeat: SeatIndex | null;
  dealNumber: number;
  deal: BuraDealState | null;
  config: BuraMatchConfig;
  status: "dealing" | "playing" | "between" | "finished" | "color_ask";
  /**
   * After a 60–60 draw the round is replayed with the same raise state
   * (დავი/სე/ჩარი) until a team scores ≥61 hand points.
   */
  carryRaise: RaiseLevel | null;
  carryLastRaiseTeam: TeamId | null;
};

export const RANK_ORDER: Rank[] = ["A", "10", "K", "Q", "J", "9", "8", "7", "6"];
export const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];

export const CARD_POINTS: Record<Rank, number> = {
  A: 11,
  "10": 10,
  K: 4,
  Q: 3,
  J: 2,
  "9": 0,
  "8": 0,
  "7": 0,
  "6": 0,
};

export const RAISE_POINTS: Record<RaiseLevel, number> = {
  none: 1,
  davi: 2,
  se: 3,
  chari: 4,
};

/** Points awarded to offering team when the pending raise is refused. */
export function refusePointsForPending(pending: RaiseLevel): number {
  if (pending === "davi") return 1;
  if (pending === "se") return 2;
  if (pending === "chari") return 3;
  return 1;
}

export function nextRaiseLevel(current: RaiseLevel): RaiseLevel | null {
  if (current === "none") return "davi";
  if (current === "davi") return "se";
  if (current === "se") return "chari";
  return null;
}

export function teamOf(seat: SeatIndex): TeamId {
  return (seat % 2) as TeamId;
}

export function suitColor(suit: Suit): ColorChoice {
  return suit === "hearts" || suit === "diamonds" ? "red" : "black";
}

export function nextSeat(seat: SeatIndex): SeatIndex {
  return ((seat + 1) % 4) as SeatIndex;
}

/** Next member of `team` after `from` (exclusive), clockwise. */
export function nextSeatOfTeam(from: SeatIndex, team: TeamId): SeatIndex {
  let seat = nextSeat(from);
  for (let i = 0; i < 4; i += 1) {
    if (teamOf(seat) === team) return seat;
    seat = nextSeat(seat);
  }
  return seat;
}

export function cardPoints(card: Card): number {
  return CARD_POINTS[card.rank];
}

export function sumCardPoints(cards: Card[]): number {
  return cards.reduce((sum, card) => sum + cardPoints(card), 0);
}
