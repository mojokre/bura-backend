import { randomBytes } from "crypto";
import {
  RANK_ORDER,
  SUITS,
  type Card,
  type Rank,
  type Suit,
} from "./types.js";

export function build36Deck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANK_ORDER) {
      deck.push({
        id: `${rank}_${suit}`,
        suit,
        rank,
      });
    }
  }
  return deck;
}

/**
 * Fair shuffle: Fisher–Yates with crypto random bytes.
 * No weighting / no "logic" dealing — just uniform randomness.
 */
export function shuffleDeck<T>(input: T[]): T[] {
  const cards = input.slice();
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = cryptoUniformInt(i + 1);
    const tmp = cards[i]!;
    cards[i] = cards[j]!;
    cards[j] = tmp;
  }
  return cards;
}

function cryptoUniformInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  // Rejection sampling to avoid modulo bias.
  const limit = 256 - (256 % maxExclusive);
  for (;;) {
    const byte = randomBytes(1)[0]!;
    if (byte < limit) return byte % maxExclusive;
  }
}

export function rankSvgName(rank: Rank): string {
  if (rank === "A") return "ace";
  if (rank === "K") return "king";
  if (rank === "Q") return "queen";
  if (rank === "J") return "jack";
  return rank;
}

export function cardAssetPath(card: Card): string {
  return `/svg/${rankSvgName(card.rank)}_of_${card.suit}.svg`;
}

export function isTrump(card: Card, trump: Suit): boolean {
  return card.suit === trump;
}
