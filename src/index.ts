import cors from "cors";
import express from "express";
import { createServer } from "http";
import { env } from "./config/env.js";
import { initRealtime } from "./realtime/gateway.js";
import { apiRouter } from "./routes/index.js";

const app = express();
const httpServer = createServer(app);

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (env.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && env.ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  cors(corsOptions),
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
