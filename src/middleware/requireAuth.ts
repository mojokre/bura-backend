import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { markUserActive } from "../services/presence.service.js";

/** Short TTL cache — avoids calling Supabase auth.getUser on every lobby request. */
const AUTH_CACHE_TTL_MS = 45_000;
const authCache = new Map<string, { userId: string; expiresAt: number }>();

function getCachedUserId(token: string): string | null {
  const hit = authCache.get(token);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    authCache.delete(token);
    return null;
  }
  return hit.userId;
}

function setCachedUserId(token: string, userId: string) {
  authCache.set(token, { userId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  // Bound memory if many tokens churn.
  if (authCache.size > 2_000) {
    const now = Date.now();
    for (const [key, value] of authCache) {
      if (value.expiresAt <= now) authCache.delete(key);
    }
  }
}

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

    const cached = getCachedUserId(token);
    if (cached) {
      (req as any).userId = cached;
      markUserActive(cached);
      return next();
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      authCache.delete(token);
      return res.status(401).json({
        code: "UNAUTHORIZED",
        message: "სესია არასწორია ან ვადაგასულია.",
      });
    }

    setCachedUserId(token, data.user.id);
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
