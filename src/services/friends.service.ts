import { AppError } from "../lib/errors.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { getProfileIconUrl } from "./profile.service.js";
import { isUserActive } from "./presence.service.js";
import { isUserInGame } from "./tables.service.js";
import { isUserInPrivateLobby } from "./friends-table.service.js";

type ProfileRow = { id: string; username: string; icon_path?: string | null };
type FriendshipRow = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: "pending" | "accepted" | "rejected";
};

function normalizePair(a: string, b: string) {
  return a < b ? [a, b] : [b, a];
}

async function mapProfileIcon(profile: ProfileRow) {
  const inGame = isUserInGame(profile.id) || isUserInPrivateLobby(profile.id);
  return {
    id: profile.id,
    username: profile.username,
    iconUrl: await getProfileIconUrl(profile.username, profile.icon_path),
    isActive: isUserActive(profile.id),
    isInGame: inGame,
  };
}

async function getProfileById(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .eq("id", userId)
    .single<ProfileRow>();

  if (error || !data) {
    throw new AppError(404, "PROFILE_NOT_FOUND", "მომხმარებელი ვერ მოიძებნა.");
  }

  return data;
}

export async function searchUsersForFriend(userId: string, query: string) {
  const q = query.trim();
  if (q.length < 2) return [];

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .ilike("username", `%${q}%`)
    .limit(10);

  if (error) {
    throw new AppError(500, "SEARCH_FAILED", "მომხმარებლის ძებნა ვერ მოხერხდა.");
  }

  const rows = ((data ?? []) as ProfileRow[]).filter((row) => row.id !== userId);
  return Promise.all(rows.map((row) => mapProfileIcon(row)));
}

export async function sendFriendRequestByUsername(userId: string, username: string) {
  const next = username.trim();
  if (!next) {
    throw new AppError(400, "VALIDATION_ERROR", "username აუცილებელია.");
  }

  const me = await getProfileById(userId);

  if (me.username.toLowerCase() === next.toLowerCase()) {
    throw new AppError(400, "INVALID_FRIEND", "საკუთარ თავს მეგობრად ვერ დაამატებ.");
  }

  const { data: friend, error: friendError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .ilike("username", next)
    .maybeSingle<ProfileRow>();

  if (friendError || !friend) {
    throw new AppError(404, "FRIEND_NOT_FOUND", "ასეთი მომხმარებელი ვერ მოიძებნა.");
  }

  if (isUserInGame(friend.id) || isUserInPrivateLobby(friend.id)) {
    throw new AppError(
      409,
      "FRIEND_IN_GAME",
      "ეს მოთამაშე თამაშშია. მოწვევა შეუძლებელია.",
    );
  }

  const [a, b] = normalizePair(userId, friend.id);
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("friendships")
    .select("id, requester_id, addressee_id, status")
    .eq("requester_id", a)
    .eq("addressee_id", b)
    .maybeSingle<FriendshipRow>();

  if (existingError) {
    throw new AppError(500, "FRIEND_REQUEST_FAILED", "მეგობრობის მოთხოვნა ვერ გაიგზავნა.");
  }

  if (existing) {
    if (existing.status === "accepted") {
      throw new AppError(409, "ALREADY_FRIENDS", "უკვე მეგობრები ხართ.");
    }
    if (existing.status === "pending") {
      if (existing.requester_id === userId) {
        throw new AppError(409, "REQUEST_ALREADY_SENT", "მოთხოვნა უკვე გაგზავნილია.");
      }
      throw new AppError(
        409,
        "REQUEST_WAITING_APPROVAL",
        "ამ მომხმარებლის მოთხოვნა უკვე გელოდება დასამტკიცებლად.",
      );
    }
  }

  const { error: insertError } = await supabaseAdmin
    .from("friendships")
    .insert({
      requester_id: userId,
      addressee_id: friend.id,
      status: "pending",
    });

  if (insertError) {
    if (/duplicate|unique/i.test(insertError.message)) {
      throw new AppError(409, "REQUEST_ALREADY_SENT", "მოთხოვნა უკვე გაგზავნილია.");
    }
    throw new AppError(500, "FRIEND_REQUEST_FAILED", "მეგობრობის მოთხოვნა ვერ გაიგზავნა.");
  }

  const mapped = await mapProfileIcon(friend);
  return {
    requesterId: userId,
    addresseeId: friend.id,
    ...mapped,
  };
}

export async function listFriends(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("friendships")
    .select("id, requester_id, addressee_id, status")
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq("status", "accepted");

  if (error) {
    throw new AppError(500, "FRIENDS_LIST_FAILED", "მეგობრების წამოღება ვერ მოხერხდა.");
  }

  const rows = (data ?? []) as FriendshipRow[];
  const friendIds = rows
    .map((row) => (row.requester_id === userId ? row.addressee_id : row.requester_id))
    .filter(Boolean);

  if (friendIds.length === 0) return [];

  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .in("id", friendIds);

  if (profilesError) {
    throw new AppError(500, "FRIENDS_LIST_FAILED", "მეგობრების წამოღება ვერ მოხერხდა.");
  }

  const items = await Promise.all(
    ((profiles ?? []) as ProfileRow[]).map((profile) => mapProfileIcon(profile)),
  );

  items.sort((a, b) => a.username.localeCompare(b.username));
  return items;
}

export async function listIncomingFriendRequests(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("friendships")
    .select("id, requester_id, addressee_id, status")
    .eq("addressee_id", userId)
    .eq("status", "pending");

  if (error) {
    throw new AppError(500, "REQUESTS_LIST_FAILED", "მოთხოვნების წამოღება ვერ მოხერხდა.");
  }

  const rows = (data ?? []) as FriendshipRow[];
  if (rows.length === 0) return [];

  const requesterIds = rows.map((row) => row.requester_id);
  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path")
    .in("id", requesterIds);

  if (profilesError) {
    throw new AppError(500, "REQUESTS_LIST_FAILED", "მოთხოვნების წამოღება ვერ მოხერხდა.");
  }

  const map = new Map(((profiles ?? []) as ProfileRow[]).map((p) => [p.id, p]));
  const mapped = await Promise.all(
    rows.map(async (row) => {
      const requester = map.get(row.requester_id);
      if (!requester) return null;
      const icon = await mapProfileIcon(requester);
      return {
        requestId: row.id,
        ...icon,
      };
    }),
  );

  return mapped.filter(Boolean);
}

export async function approveFriendRequest(userId: string, requestId: string) {
  const { data: row, error } = await supabaseAdmin
    .from("friendships")
    .select("id, requester_id, addressee_id, status")
    .eq("id", requestId)
    .single<FriendshipRow>();

  if (error || !row) {
    throw new AppError(404, "REQUEST_NOT_FOUND", "მოთხოვნა ვერ მოიძებნა.");
  }
  if (row.addressee_id !== userId) {
    throw new AppError(403, "FORBIDDEN", "ამ მოთხოვნაზე წვდომა არ გაქვს.");
  }
  if (row.status !== "pending") {
    throw new AppError(409, "REQUEST_NOT_PENDING", "მოთხოვნა უკვე დამუშავებულია.");
  }

  const { error: updateError } = await supabaseAdmin
    .from("friendships")
    .update({ status: "accepted", updated_at: new Date().toISOString() })
    .eq("id", requestId);

  if (updateError) {
    throw new AppError(500, "REQUEST_APPROVE_FAILED", "დადასტურება ვერ მოხერხდა.");
  }

  return { requesterId: row.requester_id, addresseeId: row.addressee_id };
}

export async function rejectFriendRequest(userId: string, requestId: string) {
  const { data: row, error } = await supabaseAdmin
    .from("friendships")
    .select("id, requester_id, addressee_id, status")
    .eq("id", requestId)
    .single<FriendshipRow>();

  if (error || !row) {
    throw new AppError(404, "REQUEST_NOT_FOUND", "მოთხოვნა ვერ მოიძებნა.");
  }
  if (row.addressee_id !== userId) {
    throw new AppError(403, "FORBIDDEN", "ამ მოთხოვნაზე წვდომა არ გაქვს.");
  }
  if (row.status !== "pending") {
    throw new AppError(409, "REQUEST_NOT_PENDING", "მოთხოვნა უკვე დამუშავებულია.");
  }

  const { error: deleteError } = await supabaseAdmin
    .from("friendships")
    .delete()
    .eq("id", requestId);

  if (deleteError) {
    throw new AppError(500, "REQUEST_REJECT_FAILED", "უარყოფა ვერ მოხერხდა.");
  }

  return { requesterId: row.requester_id, addresseeId: row.addressee_id };
}
