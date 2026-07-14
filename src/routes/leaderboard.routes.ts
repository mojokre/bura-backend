import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  fetchLeaderboard,
  fetchMyLeaderboardStats,
} from "../services/leaderboard.service.js";

export const leaderboardRouter = Router();

leaderboardRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as { userId?: string }).userId as string;
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    const [entries, me] = await Promise.all([
      fetchLeaderboard(limit),
      fetchMyLeaderboardStats(userId),
    ]);
    return res.json({ entries, me });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    return res.status(500).json({
      code: "INTERNAL_ERROR",
      message: "ლიდერბორდი ვერ ჩაიტვირთა.",
    });
  }
});
