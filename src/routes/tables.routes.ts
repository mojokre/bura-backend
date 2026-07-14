import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { AppError } from "../lib/errors.js";
import {
  createPublicTable,
  getActiveLiveGameRoomId,
  getPublicTables,
  joinPublicTable,
  leaveGameRoom,
  leavePublicTable,
} from "../services/tables.service.js";
import { isUserInPrivateLobby } from "../services/friends-table.service.js";
import { emitToUser } from "../realtime/gateway.js";
import { supabaseAdmin } from "../lib/supabase.js";

export const tablesRouter = Router();

const gameQuerySchema = z.object({
  game: z.literal("bura"),
});

tablesRouter.get("/public", (req, res) => {
  const parsed = gameQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      message: "game უნდა იყოს bura.",
    });
  }

  const tables = getPublicTables(parsed.data.game);
  return res.json({ tables });
});

tablesRouter.get("/active-game", requireAuth, (req, res) => {
  const userId = (req as any).userId as string;
  // Only report rooms with a started live match — not public-table lobby seats.
  const roomId = getActiveLiveGameRoomId(userId);
  return res.json({ roomId });
});

tablesRouter.post("/public/create", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const result = await createPublicTable(userId, req.body);
    return res.json(result);
  } catch (error) {
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
});

tablesRouter.post("/:tableId/join", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { tableId } = req.params;

    if (!tableId || Array.isArray(tableId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი tableId.",
      });
    }

    if (isUserInPrivateLobby(userId)) {
      return res.status(409).json({
        code: "IN_PRIVATE_LOBBY",
        message: "ჯერ დატოვე მეგობრების ლობი.",
      });
    }

    const result = await joinPublicTable(userId, tableId);
    return res.json(result);
  } catch (error) {
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
});

tablesRouter.post("/leave-game", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const result = leaveGameRoom(userId);

    if (result.dissolved) {
      let leftUsername = "მოთამაშე";
      const { data } = await supabaseAdmin
        .from("profiles")
        .select("username")
        .eq("id", userId)
        .maybeSingle<{ username: string }>();
      if (data?.username) leftUsername = data.username;

      for (const memberId of result.memberIds) {
        emitToUser(memberId, "game:abandoned", {
          roomId: result.roomId,
          leftUserId: result.leftUserId,
          leftUsername,
          message: `${leftUsername} გავიდა მაგიდიდან. თამაში გაუქმდა.`,
        });
      }
    }

    return res.json(result);
  } catch (error) {
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
});

tablesRouter.post("/:tableId/leave", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { tableId } = req.params;

    if (!tableId || Array.isArray(tableId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი tableId.",
      });
    }

    const result = await leavePublicTable(userId, tableId);
    return res.json(result);
  } catch (error) {
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
});

