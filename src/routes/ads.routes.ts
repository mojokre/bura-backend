import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { AppError } from "../lib/errors.js";
import { clearPendingAd, getPendingAd } from "../services/ads.service.js";

export const adsRouter = Router();

adsRouter.get("/pending", requireAuth, async (req, res) => {
  try {
    const userId = (req as { userId?: string }).userId as string;
    const pending = await getPendingAd(userId);
    return res.json({ pending });
  } catch (error) {
    return sendAdsError(res, error);
  }
});

/** Called only after Ad Placement adBreakDone with a watched/dismissed break. */
adsRouter.post("/complete", requireAuth, async (req, res) => {
  try {
    const userId = (req as { userId?: string }).userId as string;
    await clearPendingAd(userId);
    return res.json({ ok: true, pending: false });
  } catch (error) {
    return sendAdsError(res, error);
  }
});

function sendAdsError(res: import("express").Response, error: unknown) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
    });
  }
  // eslint-disable-next-line no-console
  console.error(error);
  return res.status(500).json({
    code: "INTERNAL_ERROR",
    message: "რეკლამის სტატუსი ვერ განახლდა.",
  });
}
