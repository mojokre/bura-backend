import { Router } from "express";
import { AppError } from "../lib/errors.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { emitToUser } from "../realtime/gateway.js";
import {
  approveFriendRequest,
  listFriends,
  listIncomingFriendRequests,
  rejectFriendRequest,
  searchUsersForFriend,
  sendFriendRequestByUsername,
} from "../services/friends.service.js";

export const friendsRouter = Router();

friendsRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const friends = await listFriends(userId);
    const incomingRequests = await listIncomingFriendRequests(userId);
    return res.json({ friends, incomingRequests });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsRouter.get("/search", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const users = await searchUsersForFriend(userId, q);
    return res.json({ users });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsRouter.post("/request", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { username } = req.body as { username?: string };
    if (!username) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "username აუცილებელია.",
      });
    }

    const request = await sendFriendRequestByUsername(userId, username);
    emitToUser(request.addresseeId, "friends:request:incoming", {
      fromUserId: request.requesterId,
    });
    return res.status(201).json(request);
  } catch (error) {
    return handleError(res, error);
  }
});

friendsRouter.post("/request/:id/approve", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const raw = req.params.id;
    const requestId = Array.isArray(raw) ? raw[0] : raw;
    if (!requestId) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "requestId აუცილებელია.",
      });
    }
    const result = await approveFriendRequest(userId, requestId);
    emitToUser(result.requesterId, "friends:changed", {});
    emitToUser(result.addresseeId, "friends:changed", {});
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

friendsRouter.post("/request/:id/reject", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const raw = req.params.id;
    const requestId = Array.isArray(raw) ? raw[0] : raw;
    if (!requestId) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "requestId აუცილებელია.",
      });
    }
    const result = await rejectFriendRequest(userId, requestId);
    emitToUser(result.requesterId, "friends:request:rejected", {});
    emitToUser(result.addresseeId, "friends:changed", {});
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error);
  }
});

function handleError(res: import("express").Response, error: unknown) {
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

