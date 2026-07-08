import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { AppError } from "../lib/errors.js";
import {
  createFriendsTable,
  getFriendsTable,
  getPrivateLobbyForUser,
  joinFriendsTableTeam,
  leaveFriendsTable,
  respondFriendsTableInvite,
  startFriendsTable,
} from "../services/friends-table.service.js";

export const friendsTableRouter = Router();

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

friendsTableRouter.get("/mine", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const lobby = getPrivateLobbyForUser(userId);
    return res.json({ lobby });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsTableRouter.post("/create", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const lobby = await createFriendsTable(userId, req.body);
    return res.json({ lobby });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsTableRouter.get("/:lobbyId", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { lobbyId } = req.params;
    if (!lobbyId || Array.isArray(lobbyId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი lobbyId.",
      });
    }
    const lobby = getFriendsTable(lobbyId, userId);
    return res.json({ lobby });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsTableRouter.post("/:lobbyId/accept", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { lobbyId } = req.params;
    if (!lobbyId || Array.isArray(lobbyId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი lobbyId.",
      });
    }
    const lobby = await respondFriendsTableInvite(userId, lobbyId, "accept");
    return res.json({ lobby });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsTableRouter.post("/:lobbyId/reject", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { lobbyId } = req.params;
    if (!lobbyId || Array.isArray(lobbyId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი lobbyId.",
      });
    }
    const lobby = await respondFriendsTableInvite(userId, lobbyId, "reject");
    return res.json({ lobby });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsTableRouter.post("/:lobbyId/join-team", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { lobbyId } = req.params;
    if (!lobbyId || Array.isArray(lobbyId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი lobbyId.",
      });
    }
    const lobby = await joinFriendsTableTeam(userId, lobbyId, req.body);
    return res.json({ lobby });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsTableRouter.post("/:lobbyId/start", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { lobbyId } = req.params;
    if (!lobbyId || Array.isArray(lobbyId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი lobbyId.",
      });
    }
    const lobby = await startFriendsTable(userId, lobbyId);
    return res.json({ lobby });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsTableRouter.post("/:lobbyId/leave", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { lobbyId } = req.params;
    if (!lobbyId || Array.isArray(lobbyId)) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "არასწორი lobbyId.",
      });
    }
    const result = await leaveFriendsTable(userId, lobbyId);
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
});
