import { z } from "zod";

export type MalyutkaMode = "turn" | "anytime";

export type TableMode = "1v1" | "2v2";

export type TableRules = {
  malyutkaMode: MalyutkaMode;
  matchTo: number;
  mode: TableMode;
};

export const malyutkaModeSchema = z.enum(["turn", "anytime"]);
export const tableModeSchema = z.enum(["1v1", "2v2"]);

export const tableRulesSchema = z.object({
  malyutkaMode: malyutkaModeSchema,
  matchTo: z.number().int().min(3).max(11),
  mode: tableModeSchema.optional().default("2v2"),
});

export const DEFAULT_TABLE_RULES: TableRules = {
  malyutkaMode: "turn",
  matchTo: 11,
  mode: "2v2",
};

export function malyutkaModeLabelKa(mode: MalyutkaMode): string {
  return mode === "turn" ? "მალიუტკა რიგით" : "მალიუტკა ურიგოდ";
}
