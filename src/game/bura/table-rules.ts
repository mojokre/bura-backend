import { z } from "zod";

/** რიგით = lead only; ურიგოდ = can interrupt mid-trick (even off-turn). */
export type MalyutkaMode = "turn" | "anytime";

export type TableRules = {
  malyutkaMode: MalyutkaMode;
  matchTo: number;
};

export const malyutkaModeSchema = z.enum(["turn", "anytime"]);

export const tableRulesSchema = z.object({
  malyutkaMode: malyutkaModeSchema,
  matchTo: z.number().int().min(3).max(11),
});

export const DEFAULT_TABLE_RULES: TableRules = {
  malyutkaMode: "turn",
  matchTo: 11,
};

export function malyutkaModeLabelKa(mode: MalyutkaMode): string {
  return mode === "turn" ? "მალიუტკა რიგით" : "მალიუტკა ურიგოდ";
}
