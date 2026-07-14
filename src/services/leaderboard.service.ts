import { supabaseAdmin } from "../lib/supabase.js";
import { getProfileIconUrl } from "./profile.service.js";

export const POINTS_PER_MATCH_WIN = 3;

export type LeaderboardEntry = {
  rank: number;
  userId: string;
  username: string;
  iconUrl: string;
  points: number;
  wins: number;
};

/**
 * Award +3 to each player on the winning team for a finished match.
 * Public and friends tables share this. Idempotent per roomId.
 */
export async function awardMatchWin(input: {
  roomId: string;
  winnerTeam: 0 | 1;
  winnerUserIds: string[];
}): Promise<void> {
  const winners = [...new Set(input.winnerUserIds)].filter(Boolean);
  if (winners.length === 0) return;

  const { error: awardErr } = await supabaseAdmin
    .from("leaderboard_match_awards")
    .insert({
      room_id: input.roomId,
      winner_team: input.winnerTeam,
      winner_user_ids: winners,
      points_each: POINTS_PER_MATCH_WIN,
    });

  // Unique violation → already awarded for this room.
  if (awardErr) {
    if (
      awardErr.code === "23505" ||
      /duplicate|unique/i.test(awardErr.message)
    ) {
      return;
    }
    // Table missing in some environments — don't crash the match.
    // eslint-disable-next-line no-console
    console.error("[leaderboard] award insert failed", awardErr.message);
    return;
  }

  for (const userId of winners) {
    const { data: existing, error: readErr } = await supabaseAdmin
      .from("leaderboard")
      .select("points, wins")
      .eq("user_id", userId)
      .maybeSingle<{ points: number; wins: number }>();

    if (readErr) {
      // eslint-disable-next-line no-console
      console.error("[leaderboard] read failed", readErr.message);
      continue;
    }

    if (existing) {
      const { error: updErr } = await supabaseAdmin
        .from("leaderboard")
        .update({
          points: existing.points + POINTS_PER_MATCH_WIN,
          wins: existing.wins + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      if (updErr) {
        // eslint-disable-next-line no-console
        console.error("[leaderboard] update failed", updErr.message);
      }
    } else {
      const { error: insErr } = await supabaseAdmin.from("leaderboard").insert({
        user_id: userId,
        points: POINTS_PER_MATCH_WIN,
        wins: 1,
        updated_at: new Date().toISOString(),
      });
      if (insErr) {
        // eslint-disable-next-line no-console
        console.error("[leaderboard] insert failed", insErr.message);
      }
    }
  }
}

export async function fetchLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("leaderboard")
    .select("user_id, points, wins")
    .order("points", { ascending: false })
    .order("wins", { ascending: false })
    .limit(Math.min(100, Math.max(1, limit)));

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[leaderboard] list failed", error.message);
    return [];
  }

  const rows =
    (data as Array<{ user_id: string; points: number; wins: number }> | null) ??
    [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.user_id);
  const { data: profiles } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .in("id", ids);

  const byId = new Map(
    (
      (profiles as Array<{
        id: string;
        username: string;
        icon_path?: string | null;
      }> | null) ?? []
    ).map((p) => [p.id, p]),
  );

  const out: LeaderboardEntry[] = [];
  let rank = 1;
  for (const row of rows) {
    const profile = byId.get(row.user_id);
    if (!profile) continue;
    out.push({
      rank: rank++,
      userId: row.user_id,
      username: profile.username,
      iconUrl: await getProfileIconUrl(profile.username, profile.icon_path),
      points: row.points,
      wins: row.wins,
    });
  }
  return out;
}

export async function fetchMyLeaderboardStats(userId: string): Promise<{
  points: number;
  wins: number;
  rank: number | null;
} | null> {
  const { data } = await supabaseAdmin
    .from("leaderboard")
    .select("points, wins")
    .eq("user_id", userId)
    .maybeSingle<{ points: number; wins: number }>();

  if (!data) {
    return { points: 0, wins: 0, rank: null };
  }

  const { count } = await supabaseAdmin
    .from("leaderboard")
    .select("user_id", { count: "exact", head: true })
    .or(
      `points.gt.${data.points},and(points.eq.${data.points},wins.gt.${data.wins})`,
    );

  return {
    points: data.points,
    wins: data.wins,
    rank: (count ?? 0) + 1,
  };
}
