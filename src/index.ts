import express from "express";
import { createServer } from "http";
import { env } from "./config/env.js";
import { initRealtime } from "./realtime/gateway.js";
import { apiRouter } from "./routes/index.js";

const app = express();
const httpServer = createServer(app);

// Health checks first — Railway probes before full middleware stack.
app.get(["/api/health", "/health"], (_req, res) => {
  res.status(200).json({ ok: true });
});

// Allow ANY origin. Reflect the incoming Origin so credentialed requests
// still work (the spec forbids "*" together with credentials).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin ?? "*");
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"]?.toString() ??
      "Content-Type, Authorization",
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: "32kb" }));

app.use("/api", apiRouter);

app.use((_req, res) => {
  res.status(404).json({
    code: "NOT_FOUND",
    message: "მარშრუტი ვერ მოიძებნა.",
  });
});

initRealtime(httpServer);

// 0.0.0.0 = reachable from phone / LAN, not only localhost
const port = env.PORT;
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Backend listening on http://0.0.0.0:${port}`);
  console.log(`NODE_ENV=${env.NODE_ENV}`);
  console.log(`Health: GET /api/health`);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  process.exit(1);
});
