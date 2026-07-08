import { Router } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import {
  loginSchema,
  loginUser,
  refreshSchema,
  refreshSession,
  registerSchema,
  registerUser,
} from "../services/auth.service.js";

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  try {
    const body = registerSchema.parse(req.body);
    const result = await registerUser(body);
    return res.status(201).json(result);
  } catch (error) {
    return sendAuthError(res, error);
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const body = loginSchema.parse(req.body);
    const result = await loginUser(body);
    return res.status(200).json(result);
  } catch (error) {
    return sendAuthError(res, error);
  }
});

authRouter.post("/refresh", async (req, res) => {
  try {
    const body = refreshSchema.parse(req.body);
    const session = await refreshSession(body);
    return res.status(200).json({ session });
  } catch (error) {
    return sendAuthError(res, error);
  }
});

function sendAuthError(
  res: import("express").Response,
  error: unknown,
) {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return res.status(400).json({
      code: "VALIDATION_ERROR",
      message: first?.message ?? "არასწორი მონაცემები.",
      field: first?.path[0] ?? null,
    });
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
    });
  }

  console.error(error);
  return res.status(500).json({
    code: "INTERNAL_ERROR",
    message: "სერვერის შეცდომა.",
  });
}
