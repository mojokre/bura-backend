import express from "express";
import { createServer } from "http";
import { applyCors } from "./cors.js";
import { readPort } from "./port.js";

const app = express();
applyCors(app);

const httpServer = createServer(app);
const port = readPort();

// Health must work before env validation / Supabase imports.
app.get(["/api/health", "/health", "/"], (_req, res) => {
  res.status(200).json({ ok: true, service: "bura-backend" });
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Health listening on http://0.0.0.0:${port}`);
  void bootstrap();
});

async function bootstrap() {
  try {
    await import("./config/env.js");
    const { mountApp } = await import("./mount-app.js");
    mountApp(app, httpServer);
    console.log(`Backend fully ready on http://0.0.0.0:${port}`);
  } catch (error) {
    console.error("STARTUP FAILED — check Railway Variables:");
    console.error(error);
    app.use((_req, res) => {
      res.status(503).json({
        code: "SERVER_MISCONFIGURED",
        message: "Backend env vars missing or invalid — check Railway deploy logs.",
      });
    });
  }
}

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
