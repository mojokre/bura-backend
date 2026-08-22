import { z } from "zod";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { AppError } from "../lib/errors.js";
import { usernameToAuthEmail } from "../lib/username.js";
import { leavePrivateLobbyIfAny } from "./friends-table.service.js";
import {
  isUserInGame,
  leaveGameRoom,
  leavePublicTableIfAny,
} from "./tables.service.js";

type ProfileRow = {
  id: string;
  username: string | null;
  icon_path?: string | null;
  display_name?: string | null;
  auth_provider?: string | null;
  pending_ad_after_match?: boolean | null;
  created_at: string;
};

export async function getMe(userId: string) {
  const withIcon = await supabaseAdmin
    .from("profiles")
    .select(
      "id, username, icon_path, display_name, auth_provider, pending_ad_after_match, created_at",
    )
    .eq("id", userId)
    .single<ProfileRow>();

  let profile: ProfileRow | null = null;

  if (!withIcon.error && withIcon.data) {
    profile = withIcon.data;
  } else if (
    withIcon.error &&
    /icon_path|pending_ad_after_match/i.test(withIcon.error.message)
  ) {
    const fallback = await supabaseAdmin
      .from("profiles")
      .select("id, username, created_at")
      .eq("id", userId)
      .single<ProfileRow>();

    if (!fallback.error && fallback.data) {
      profile = {
        ...fallback.data,
        icon_path: null,
        pending_ad_after_match: false,
      };
    }
  }

  if (!profile) {
    throw new AppError(500, "PROFILE_MISSING", "პროფილი ვერ მოიძებნა.");
  }

  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name ?? null,
    needsUsername: !profile.username,
    iconPath: profile.icon_path ?? null,
    iconUrl: profile.username
      ? profile.icon_path
        ? await resolveIconUrl(profile.icon_path)
        : getDefaultProfileIconUrl(profile.username)
      : profile.icon_path
        ? await resolveIconUrl(profile.icon_path)
        : getDefaultProfileIconUrl(),
    canSetIcon: Boolean(profile.username),
    pendingAdAfterMatch: Boolean(profile.pending_ad_after_match),
    authProvider: profile.auth_provider ?? "password",
    createdAt: profile.created_at,
  };
}

export function getDefaultProfileIconUrl(_username?: string) {
  // Shared default avatar in public bucket (file named username.png).
  return `${env.SUPABASE_URL}/storage/v1/object/public/${env.SUPABASE_STORAGE_BUCKET}/username.png`;
}

export async function getProfileIconUrl(
  _username: string,
  iconPath?: string | null,
) {
  if (iconPath) {
    const url = await resolveIconUrl(iconPath);
    if (url) return url;
  }

  // No custom upload → shared default file `username.png` in the public bucket.
  return getDefaultProfileIconUrl();
}

function allowedExtension(fileName: string) {
  const lower = fileName.toLowerCase();
  return /\.(png|jpe?g|webp|gif)$/i.test(lower);
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getFileExtension(fileName: string) {
  const clean = sanitizeFileName(fileName).toLowerCase();
  const match = clean.match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "png";
}

const usernameSchema = z
  .string()
  .trim()
  .min(3, "მომხმარებლის სახელი უნდა იყოს მინიმუმ 3 სიმბოლო.")
  .max(24, "მომხმარებლის სახელი უნდა იყოს მაქსიმუმ 24 სიმბოლო.")
  .regex(
    /^[a-zA-Z0-9_]+$/,
    "მომხმარებლის სახელი შეიძლება შეიცავდეს მხოლოდ ლათინურ ასოებს, ციფრებს და _.",
  );

async function resolveIconUrl(objectPath: string) {
  // Works best when bucket is public; for private buckets we try signed URLs.
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .createSignedUrl(objectPath, 60 * 60);

    if (!error && data?.signedUrl) return data.signedUrl;
  } catch {
    // ignore and fall back to publicUrl
  }

  const { data } = supabaseAdmin.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .getPublicUrl(objectPath);

  return data.publicUrl ?? null;
}

export async function listSuggestedIcons() {
  const prefix = env.SUPABASE_PROFILE_ICONS_PREFIX;

  const listPath = prefix || "";
  const { data, error } = await supabaseAdmin.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .list(listPath);

  if (error) {
    throw new AppError(
      500,
      "ICONS_LIST_FAILED",
      "შეცდომა მოხდა ხატულების (icons) ჩამოთვლაში.",
    );
  }

  const files = (data ?? []) as Array<{ name: string }>;

  // If icons are stored in nested paths, we only use direct file names here.
  const iconCandidates = files
    .map((f) => f.name)
    .filter((name) => allowedExtension(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 10);

  const icons = await Promise.all(
    iconCandidates.map(async (name) => {
      const objectPath = prefix ? `${prefix.replace(/\/$/, "")}/${name}` : name;
      return {
        path: objectPath,
        url: await resolveIconUrl(objectPath),
      };
    }),
  );

  return icons;
}

const selectIconSchema = z.object({
  iconPath: z.string().min(1),
});

export async function selectIcon(userId: string, iconPath: string) {
  await selectIconSchema.parse({ iconPath });

  const { error } = await supabaseAdmin.from("profiles").update({
    icon_path: iconPath,
    updated_at: new Date().toISOString(),
  }).eq("id", userId);

  if (error) {
    if (/icon_path/i.test(error.message)) {
      throw new AppError(
        500,
        "ICON_NOT_CONFIGURED",
        "icon_path სვეტი აკლია. გაუშვი migration 002_profiles_icon.sql.",
      );
    }
    throw new AppError(
      500,
      "ICON_SELECT_FAILED",
      "ხატულის არჩევა ვერ მოხერხდა.",
    );
  }

  return {
    iconPath,
    iconUrl: await resolveIconUrl(iconPath),
  };
}

export async function uploadIconToStorage(
  userId: string,
  file: { buffer: Buffer; originalName: string; contentType: string },
) {
  if (!allowedExtension(file.originalName)) {
    throw new AppError(400, "ICON_INVALID_TYPE", "მხოლოდ სურათები (png/jpg/webp/gif) არის დაშვებული.");
  }

  const fileName = sanitizeFileName(file.originalName);
  const objectPath = `${userId}/${Date.now()}-${fileName}`;

  const { error } = await supabaseAdmin.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(objectPath, file.buffer, {
      contentType: file.contentType || "application/octet-stream",
      upsert: false,
    });

  if (error) {
    throw new AppError(500, "ICON_UPLOAD_FAILED", "ატვირთვა ვერ მოხერხდა.");
  }

  await selectIcon(userId, objectPath);

  return {
    iconPath: objectPath,
    iconUrl: await resolveIconUrl(objectPath),
  };
}

export async function updateUsername(userId: string, nextUsernameRaw: string) {
  const nextUsername = usernameSchema.parse(nextUsernameRaw);

  const { data: me, error: meError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, auth_provider")
    .eq("id", userId)
    .single<{ id: string; username: string | null; auth_provider?: string | null }>();

  if (meError || !me || !me.username) {
    throw new AppError(
      403,
      "USERNAME_NOT_SET",
      "ჯერ აირჩიე მომხმარებლის სახელი.",
    );
  }

  if (me.username === nextUsername) {
    return {
      username: nextUsername,
      iconUrl: getDefaultProfileIconUrl(nextUsername),
    };
  }

  const { data: existing } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("username", nextUsername)
    .maybeSingle<{ id: string }>();

  if (existing && existing.id !== userId) {
    throw new AppError(409, "USERNAME_TAKEN", "ეს მომხმარებლის სახელი უკვე დაკავებულია.");
  }

  const oldDefaultPath = `${me.username}.png`;
  const nextDefaultPath = `${nextUsername}.png`;
  const isPasswordAuth = (me.auth_provider ?? "password") === "password";

  const authPatch: { email?: string; user_metadata: { username: string } } = {
    user_metadata: { username: nextUsername },
  };
  if (isPasswordAuth) {
    authPatch.email = usernameToAuthEmail(nextUsername);
  }

  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
    userId,
    authPatch,
  );

  if (authError) {
    if (/already|exists|registered/i.test(authError.message)) {
      throw new AppError(409, "USERNAME_TAKEN", "ეს მომხმარებლის სახელი უკვე დაკავებულია.");
    }
    throw new AppError(400, "USERNAME_UPDATE_FAILED", authError.message);
  }

  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({
      username: nextUsername,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (profileError) {
    throw new AppError(500, "USERNAME_UPDATE_FAILED", "მომხმარებლის სახელის შეცვლა ვერ მოხერხდა.");
  }

  if (oldDefaultPath !== nextDefaultPath) {
    await supabaseAdmin.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .move(oldDefaultPath, nextDefaultPath);
  }

  return {
    username: nextUsername,
    iconUrl: getDefaultProfileIconUrl(nextUsername),
  };
}

/** First-time username for OAuth / users without username yet. */
export async function setInitialUsername(userId: string, nextUsernameRaw: string) {
  const nextUsername = usernameSchema.parse(nextUsernameRaw);

  const { data: me, error: meError } = await supabaseAdmin
    .from("profiles")
    .select("id, username, auth_provider")
    .eq("id", userId)
    .single<{ id: string; username: string | null; auth_provider?: string | null }>();

  if (meError || !me) {
    throw new AppError(500, "PROFILE_MISSING", "პროფილი ვერ მოიძებნა.");
  }

  if (me.username) {
    throw new AppError(
      409,
      "USERNAME_ALREADY_SET",
      "მომხმარებლის სახელი უკვე გაქვს.",
    );
  }

  const { data: existing } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("username", nextUsername)
    .maybeSingle<{ id: string }>();

  if (existing) {
    throw new AppError(409, "USERNAME_TAKEN", "ეს მომხმარებლის სახელი უკვე დაკავებულია.");
  }

  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({
      username: nextUsername,
      username_set_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (profileError) {
    throw new AppError(500, "USERNAME_UPDATE_FAILED", "მომხმარებლის სახელის შენახვა ვერ მოხერხდა.");
  }

  await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: { username: nextUsername },
  });

  return {
    username: nextUsername,
    iconUrl: getDefaultProfileIconUrl(nextUsername),
    needsUsername: false,
  };
}

export async function uploadProfileImage(
  userId: string,
  file: { buffer: Buffer; originalName: string; contentType: string },
) {
  if (!allowedExtension(file.originalName)) {
    throw new AppError(
      400,
      "ICON_INVALID_TYPE",
      "მხოლოდ სურათები (png/jpg/webp/gif) არის დაშვებული.",
    );
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("username")
    .eq("id", userId)
    .single<{ username: string | null }>();

  if (profileError || !profile) {
    throw new AppError(500, "PROFILE_MISSING", "პროფილი ვერ მოიძებნა.");
  }

  const ext = getFileExtension(file.originalName);
  const objectPath = profile.username
    ? `${profile.username}.${ext}`
    : `${userId}/avatar.${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(objectPath, file.buffer, {
      contentType: file.contentType || "application/octet-stream",
      upsert: true,
    });

  if (error) {
    throw new AppError(500, "ICON_UPLOAD_FAILED", "ატვირთვა ვერ მოხერხდა.");
  }

  // Persist explicit icon path so uploaded custom image is used everywhere.
  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({
      icon_path: objectPath,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (updateError) {
    throw new AppError(500, "ICON_UPLOAD_FAILED", "პროფილის ფოტოს შენახვა ვერ მოხერხდა.");
  }

  return {
    iconUrl: await resolveIconUrl(objectPath),
  };
}

/** Permanently delete the user's account and linked database rows. */
export async function deleteAccount(userId: string) {
  if (isUserInGame(userId)) {
    throw new AppError(
      409,
      "ACCOUNT_IN_USE",
      "ჯერ გახვიე მიმდინარე თამაში, შემდეგ წაშალე ანგარიში.",
    );
  }

  leavePublicTableIfAny(userId);
  leavePrivateLobbyIfAny(userId);
  leaveGameRoom(userId);

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("icon_path")
    .eq("id", userId)
    .maybeSingle<{ icon_path: string | null }>();

  if (profile?.icon_path) {
    await supabaseAdmin.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .remove([profile.icon_path])
      .catch(() => undefined);
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    throw new AppError(
      500,
      "ACCOUNT_DELETE_FAILED",
      "ანგარიშის წაშლა ვერ მოხერხდა.",
    );
  }

  return { ok: true as const };
}

