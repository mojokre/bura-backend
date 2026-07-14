import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { AppError } from "../lib/errors.js";
import {
  answerBuraColor,
  declareBuraCards,
  getBuraRoomView,
  offerBuraRaise,
  playBuraCards,
  respondBuraRaise,
} from "../services/bura-room.service.js";

export const buraRouter = Router();

function handleError(res: any, error: unknown) {
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
    message: "სერვერის შეცდომა.",
  });
}

buraRouter.get("/:roomId", requireAuth, (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { roomId } = req.params;
    if (!roomId || Array.isArray(roomId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი roomId.",
      });
    }
    const state = getBuraRoomView(roomId, userId);
    return res.json({ state });
  } catch (error) {
    return handleError(res, error);
  }
});

const colorSchema = z.object({
  answer: z.enum(["red", "black"]),
});

buraRouter.post("/:roomId/color", requireAuth, (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { roomId } = req.params;
    if (!roomId || Array.isArray(roomId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი roomId.",
      });
    }
    const parsed = colorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "პასუხი უნდა იყოს red ან black.",
      });
    }
    const state = answerBuraColor(roomId, userId, parsed.data.answer);
    return res.json({ state });
  } catch (error) {
    return handleError(res, error);
  }
});

const playSchema = z.object({
  cardIds: z.array(z.string().min(1)).min(1).max(5),
});

buraRouter.post("/:roomId/play", requireAuth, (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { roomId } = req.params;
    if (!roomId || Array.isArray(roomId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი roomId.",
      });
    }
    const parsed = playSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "აირჩიე კარტი.",
      });
    }
    const state = playBuraCards(roomId, userId, parsed.data.cardIds);
    return res.json({ state });
  } catch (error) {
    return handleError(res, error);
  }
});

buraRouter.post("/:roomId/bura", requireAuth, (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { roomId } = req.params;
    if (!roomId || Array.isArray(roomId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი roomId.",
      });
    }
    const state = declareBuraCards(roomId, userId);
    return res.json({ state });
  } catch (error) {
    return handleError(res, error);
  }
});

const offerSchema = z.object({
  level: z.enum(["davi", "se", "chari"]),
});

buraRouter.post("/:roomId/raise", requireAuth, (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { roomId } = req.params;
    if (!roomId || Array.isArray(roomId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი roomId.",
      });
    }
    const parsed = offerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "დონე უნდა იყოს davi, se ან chari.",
      });
    }
    const state = offerBuraRaise(roomId, userId, parsed.data.level);
    return res.json({ state });
  } catch (error) {
    return handleError(res, error);
  }
});

const respondSchema = z.object({
  response: z.enum(["accept", "refuse", "counter"]),
});

buraRouter.post("/:roomId/raise/respond", requireAuth, (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { roomId } = req.params;
    if (!roomId || Array.isArray(roomId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი roomId.",
      });
    }
    const parsed = respondSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "პასუხი უნდა იყოს accept, refuse ან counter.",
      });
    }
    const state = respondBuraRaise(roomId, userId, parsed.data.response);
    return res.json({ state });
  } catch (error) {
    return handleError(res, error);
  }
});
