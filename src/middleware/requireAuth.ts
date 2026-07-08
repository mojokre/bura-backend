import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { markUserActive } from "../services/presence.service.js";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "მომხმარებელი არ არის ავტორიზებული.",
      });
    }

    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "არასწორი ავტორიზაციის სათაური.",
      });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "სესია არასწორია ან ვადაგასულია.",
      });
    }

    (req as any).userId = data.user.id;
    markUserActive(data.user.id);
    return next();
  } catch (_err) {
    return res.status(401).json({
      code: "UNAUTHORIZED",
      message: "სესია ვერ დადასტურდა.",
    });
  }
}

