import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase.js";

/** Blocks game/lobby actions until OAuth user picks a username. */
export async function requireUsername(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) {
    return res.status(401).json({
      code: "UNAUTHORIZED",
      message: "ავტორიზაცია საჭიროა.",
    });
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("username")
    .eq("id", userId)
    .maybeSingle<{ username: string | null }>();

  if (error || !data?.username) {
    return res.status(403).json({
      code: "USERNAME_REQUIRED",
      message: "ჯერ აირჩიე მომხმარებლის სახელი პროფილში.",
    });
  }

  return next();
}
