import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { supabaseAdmin, supabaseAnon } from "../lib/supabase.js";
import {
  getDefaultProfileIconUrl,
  getProfileIconUrl,
} from "./profile.service.js";
import { markUserActive } from "./presence.service.js";
import { isUserInGame } from "./tables.service.js";

export const oauthProviderSchema = z.enum(["google", "facebook"]);

export const oauthSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

type ProfileRow = {
  id: string;
  username: string | null;
  icon_path?: string | null;
  display_name?: string | null;
  auth_provider?: string | null;
  created_at: string;
};

function inferProvider(
  appMetadata: Record<string, unknown> | undefined,
  providerHint?: string,
): string {
  const fromMeta = appMetadata?.provider;
  if (typeof fromMeta === "string") return fromMeta;
  if (providerHint) return providerHint;
  return "oauth";
}

async function findOrCreateOAuthProfile(
  userId: string,
  metadata: {
    fullName?: string | null;
    provider: string;
  },
): Promise<ProfileRow> {
  const withIcon = await supabaseAdmin
    .from("profiles")
    .select("id, username, icon_path, display_name, auth_provider, created_at")
    .eq("id", userId)
    .maybeSingle<ProfileRow>();

  if (withIcon.data) return withIcon.data;

  const displayName = metadata.fullName?.trim() || null;
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .insert({
      id: userId,
      username: null,
      display_name: displayName,
      auth_provider: metadata.provider,
    })
    .select("id, username, icon_path, display_name, auth_provider, created_at")
    .single<ProfileRow>();

  if (error || !data) {
    throw new AppError(
      500,
      "PROFILE_CREATE_FAILED",
      "OAuth პროფილის შექმნა ვერ მოხერხდა.",
    );
  }

  return data;
}

async function profileToAuthUser(profile: ProfileRow) {
  const iconUrl = profile.username
    ? await getProfileIconUrl(profile.username, profile.icon_path)
    : profile.icon_path
      ? await getProfileIconUrl("", profile.icon_path)
      : getDefaultProfileIconUrl();

  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name ?? null,
    needsUsername: !profile.username,
    createdAt: profile.created_at,
    iconPath: profile.icon_path ?? null,
    iconUrl,
    authProvider: profile.auth_provider ?? "oauth",
  };
}

function isAllowedAppReturnTo(value: string) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "bura:" ||
      parsed.protocol === "exp:" ||
      parsed.protocol === "exps:"
    );
  } catch {
    return false;
  }
}

function isHostedOAuthCallback(url: URL) {
  try {
    const site = new URL(env.FRONTEND_URL);
    return (
      url.protocol === "https:" &&
      url.hostname === site.hostname &&
      url.pathname.replace(/\/$/, "") === "/auth/callback"
    );
  } catch {
    return false;
  }
}

function resolveOAuthRedirect(requested?: string) {
  const configured = env.MOBILE_OAUTH_REDIRECT_URL.replace(/\/$/, "");
  if (!requested?.trim()) return configured;

  try {
    const url = new URL(requested.trim());
    const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    const returnTo = url.searchParams.get("return_to");
    const hasAppReturn = Boolean(returnTo && isAllowedAppReturnTo(returnTo));

    // Mobile always sends the hosted callback + return_to; honor it even if env
    // still has the legacy bura:// value (Supabase would fall back to Site URL).
    if (isHostedOAuthCallback(url) && hasAppReturn) {
      return url.toString();
    }

    if (base !== configured) return configured;

    if (hasAppReturn) {
      const next = new URL(configured);
      next.searchParams.set("return_to", returnTo!);
      return next.toString();
    }
  } catch {
    return configured;
  }

  return configured;
}

export async function getOAuthAuthorizeUrl(
  provider: z.infer<typeof oauthProviderSchema>,
  redirectTo?: string,
) {
  const target = resolveOAuthRedirect(redirectTo);

  const { data, error } = await supabaseAnon.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: target,
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    throw new AppError(
      400,
      "OAUTH_URL_FAILED",
      error?.message ?? "OAuth ბმული ვერ შეიქმნა. Supabase-ში ჩართე პროვაიდერი.",
    );
  }

  return { url: data.url, redirectTo: target };
}

export async function completeOAuthSession(
  input: z.infer<typeof oauthSessionSchema>,
  providerHint?: string,
) {
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(
    input.accessToken,
  );

  if (userError || !userData.user) {
    throw new AppError(
      401,
      "INVALID_OAUTH_SESSION",
      "OAuth სესია არასწორია.",
    );
  }

  const userId = userData.user.id;

  if (isUserInGame(userId)) {
    throw new AppError(
      409,
      "ACCOUNT_IN_USE",
      "ამ ანგარიშს უკვე იყენებს ვინმე თამაშში.",
    );
  }

  const meta = userData.user.user_metadata as Record<string, unknown> | undefined;
  const fullName =
    (typeof meta?.full_name === "string" && meta.full_name) ||
    (typeof meta?.name === "string" && meta.name) ||
    null;

  const provider = inferProvider(
    userData.user.app_metadata as Record<string, unknown> | undefined,
    providerHint,
  );

  const profile = await findOrCreateOAuthProfile(userId, {
    fullName,
    provider,
  });

  markUserActive(userId);

  return {
    user: await profileToAuthUser(profile),
    session: {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: null as number | null,
    },
  };
}
