import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { supabaseAdmin, supabaseAnon } from "../lib/supabase.js";
import { usernameToAuthEmail } from "../lib/username.js";
import { getProfileIconUrl } from "./profile.service.js";
import { markUserActive } from "./presence.service.js";
import { isUserInGame } from "./tables.service.js";

const usernameSchema = z
  .string()
  .trim()
  .min(3, "მომხმარებლის სახელი უნდა იყოს მინიმუმ 3 სიმბოლო.")
  .max(24, "მომხმარებლის სახელი უნდა იყოს მაქსიმუმ 24 სიმბოლო.")
  .regex(
    /^[a-zA-Z0-9_]+$/,
    "მომხმარებლის სახელი შეიძლება შეიცავდეს მხოლოდ ლათინურ ასოებს, ციფრებს და _.",
  );

const passwordSchema = z
  .string()
  .min(6, "პაროლი უნდა იყოს მინიმუმ 6 სიმბოლო.")
  .max(72, "პაროლი ძალიან გრძელია.");

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token საჭიროა."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;

type ProfileRow = {
  id: string;
  username: string;
  icon_path?: string | null;
  created_at: string;
};

export async function registerUser(input: RegisterInput) {
  const username = input.username.trim();
  const email = usernameToAuthEmail(username);

  const { data: existing } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (existing) {
    throw new AppError(409, "USERNAME_TAKEN", "ეს მომხმარებლის სახელი უკვე დაკავებულია.");
  }

  const { data: created, error: createError } =
    await supabaseAdmin.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
      user_metadata: { username },
    });

  if (createError || !created.user) {
    const message = createError?.message ?? "რეგისტრაცია ვერ მოხერხდა.";

    if (/already|exists|registered/i.test(message)) {
      throw new AppError(
        409,
        "USERNAME_TAKEN",
        "ეს მომხმარებლის სახელი უკვე დაკავებულია.",
      );
    }

    throw new AppError(400, "REGISTER_FAILED", message);
  }

  const userId = created.user.id;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .insert({
      id: userId,
      username,
    })
    .select("id, username, created_at")
    .single<ProfileRow>();

  if (profileError || !profile) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new AppError(
      500,
      "PROFILE_CREATE_FAILED",
      "პროფილის შექმნა ვერ მოხერხდა. სცადე თავიდან.",
    );
  }

  const { data: sessionData, error: signInError } =
    await supabaseAnon.auth.signInWithPassword({
      email,
      password: input.password,
    });

  if (signInError || !sessionData.session) {
    return {
      user: {
        id: profile.id,
        username: profile.username,
        createdAt: profile.created_at,
        iconPath: profile.icon_path ?? null,
        iconUrl: await getProfileIconUrl(profile.username, profile.icon_path),
      },
      session: null,
    };
  }

  markUserActive(profile.id);

  return {
    user: {
      id: profile.id,
      username: profile.username,
      createdAt: profile.created_at,
      iconPath: profile.icon_path ?? null,
      iconUrl: await getProfileIconUrl(profile.username, profile.icon_path),
    },
    session: {
      accessToken: sessionData.session.access_token,
      refreshToken: sessionData.session.refresh_token,
      expiresAt: sessionData.session.expires_at,
    },
  };
}

export async function loginUser(input: LoginInput) {
  const username = input.username.trim();
  const email = usernameToAuthEmail(username);

  // Resolve profile first so we can refuse an in-game account WITHOUT
  // creating a new Supabase session (which would kick the in-game player).
  const preCheck = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle<{ id: string }>();

  if (preCheck.data?.id && isUserInGame(preCheck.data.id)) {
    throw new AppError(
      409,
      "ACCOUNT_IN_USE",
      "ამ ანგარიშს უკვე იყენებს ვინმე თამაშში.",
    );
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({
    email,
    password: input.password,
  });

  if (error || !data.user || !data.session) {
    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "მომხმარებლის სახელი ან პაროლი არასწორია.",
    );
  }

  let profile: ProfileRow | null = null;

  const withIcon = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path, created_at")
    .eq("id", data.user.id)
    .single<ProfileRow>();

  if (!withIcon.error && withIcon.data) {
    profile = withIcon.data;
  } else if (withIcon.error && /icon_path/i.test(withIcon.error.message)) {
    const fallback = await supabaseAdmin
      .from("profiles")
      .select("id, username, created_at")
      .eq("id", data.user.id)
      .single<ProfileRow>();

    if (!fallback.error && fallback.data) {
      profile = { ...fallback.data, icon_path: null };
    }
  }

  if (!profile) {
    throw new AppError(500, "PROFILE_MISSING", "პროფილი ვერ მოიძებნა.");
  }

  // Race: joined a game between pre-check and sign-in — still refuse.
  if (isUserInGame(profile.id)) {
    throw new AppError(
      409,
      "ACCOUNT_IN_USE",
      "ამ ანგარიშს უკვე იყენებს ვინმე თამაშში.",
    );
  }

  markUserActive(profile.id);

  return {
    user: {
      id: profile.id,
      username: profile.username,
      createdAt: profile.created_at,
      iconPath: profile.icon_path ?? null,
      iconUrl: await getProfileIconUrl(profile.username, profile.icon_path),
    },
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
    },
  };
}

export async function refreshSession(input: RefreshInput) {
  const { data, error } = await supabaseAnon.auth.refreshSession({
    refresh_token: input.refreshToken,
  });

  if (error || !data.session) {
    throw new AppError(
      401,
      "SESSION_EXPIRED",
      "სესია არასწორია ან ვადაგასულია.",
    );
  }

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
  };
}
