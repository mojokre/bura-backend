import { Router } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { AppError } from "../lib/errors.js";
import {
  getMe,
  listSuggestedIcons,
  selectIcon,
  updateUsername,
  uploadIconToStorage,
  uploadProfileImage,
} from "../services/profile.service.js";

export const profileRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
});

profileRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const me = await getMe(userId);
    return res.json(me);
  } catch (error) {
    return sendProfileError(res, error);
  }
});

profileRouter.get("/icons", requireAuth, async (_req, res) => {
  try {
    const icons = await listSuggestedIcons();
    return res.json({ icons });
  } catch (error) {
    return sendProfileError(res, error);
  }
});

profileRouter.post("/icon/select", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { iconPath } = req.body as { iconPath?: string };

    if (!iconPath) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "iconPath აუცილებელია.",
      });
    }

    const result = await selectIcon(userId, iconPath);
    return res.json(result);
  } catch (error) {
    return sendProfileError(res, error);
  }
});

profileRouter.post(
  "/icon/upload",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = (req as any).userId as string;
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "ატვირთვის ფაილი არ არის.",
        });
      }

      const result = await uploadIconToStorage(userId, {
        buffer: file.buffer,
        originalName: file.originalname,
        contentType: file.mimetype,
      });

      return res.json(result);
    } catch (error) {
      return sendProfileError(res, error);
    }
  },
);

profileRouter.patch("/username", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { username } = req.body as { username?: string };

    if (!username) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "username აუცილებელია.",
      });
    }

    const result = await updateUsername(userId, username);
    return res.json(result);
  } catch (error) {
    return sendProfileError(res, error);
  }
});

profileRouter.post(
  "/image/upload",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = (req as any).userId as string;
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "ატვირთვის ფაილი არ არის.",
        });
      }

      const result = await uploadProfileImage(userId, {
        buffer: file.buffer,
        originalName: file.originalname,
        contentType: file.mimetype,
      });

      return res.json(result);
    } catch (error) {
      return sendProfileError(res, error);
    }
  },
);

function sendProfileError(res: import("express").Response, error: unknown) {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      message: first?.message ?? "არასწორი მონაცემები.",
    });
  }

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

