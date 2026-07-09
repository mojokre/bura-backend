import express, { type Express } from "express";
import type { Server as HttpServer } from "http";
import { env } from "./config/env.js";
import { initRealtime } from "./realtime/gateway.js";
import { apiRouter } from "./routes/index.js";

export function mountApp(app: Express, httpServer: HttpServer) {
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", apiRouter);

  app.use((_req, res) => {
    res.status(404).json({
      code: "NOT_FOUND",
      message: "მარშრუტი ვერ მოიძებნა.",
    });
  });

  initRealtime(httpServer);

  console.log(`NODE_ENV=${env.NODE_ENV}`);
  console.log("API routes and realtime ready");
}
