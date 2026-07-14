import { Router } from "express";
import { authRouter } from "./auth.routes.js";
import { buraRouter } from "./bura.routes.js";
import { friendsRouter } from "./friends.routes.js";
import { friendsTableRouter } from "./friends-table.routes.js";
import { profileRouter } from "./profile.routes.js";
import { tablesRouter } from "./tables.routes.js";
import { leaderboardRouter } from "./leaderboard.routes.js";
import { adsRouter } from "./ads.routes.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/profile", profileRouter);
apiRouter.use("/tables", tablesRouter);
apiRouter.use("/friends-table", friendsTableRouter);
apiRouter.use("/friends", friendsRouter);
apiRouter.use("/bura", buraRouter);
apiRouter.use("/leaderboard", leaderboardRouter);
apiRouter.use("/ads", adsRouter);
