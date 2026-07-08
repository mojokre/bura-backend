import cors from "cors";
import express from "express";
import { createServer } from "http";
import { env } from "./config/env.js";
import { initRealtime } from "./realtime/gateway.js";
import { apiRouter } from "./routes/index.js";

const app = express();
const httpServer = createServer(app);

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
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
httpServer.listen(env.PORT, "0.0.0.0", () => {
  console.log(`Backend listening on http://0.0.0.0:${env.PORT}`);
  console.log(`CORS allowed: ${env.ALLOWED_ORIGINS.join(", ")}`);
  console.log(`Dev: private LAN origins on :3000 are also allowed`);
});
