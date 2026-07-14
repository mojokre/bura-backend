import { supabaseAdmin } from "../lib/supabase.js";

/** Mark players as owing a post-match interstitial (H5 Ad Placement). */
export async function markPendingAdsForUsers(userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return;

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      pending_ad_after_match: true,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[ads] mark pending failed", error.message);
  }
}

export async function clearPendingAd(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      pending_ad_after_match: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[ads] clear pending failed", error.message);
    throw error;
  }
}

export async function getPendingAd(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("pending_ad_after_match")
    .eq("id", userId)
    .maybeSingle<{ pending_ad_after_match?: boolean }>();

  if (error) {
    if (/pending_ad_after_match/i.test(error.message)) return false;
    // eslint-disable-next-line no-console
    console.error("[ads] read pending failed", error.message);
    return false;
  }
  return Boolean(data?.pending_ad_after_match);
}
