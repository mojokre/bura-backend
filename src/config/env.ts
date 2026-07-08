import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  /** Comma-separated extra Origins (e.g. phone LAN URL). */
  CORS_ORIGINS: z.string().optional(),
  SUPABASE_URL: z.string().url("SUPABASE_URL is required"),
  SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_STORAGE_BUCKET: z
    .string()
    .min(1)
    .default("profile-images"),
  // Optional prefix inside the bucket where suggested icons live.
  // If empty, we list directly from the bucket root.
  SUPABASE_PROFILE_ICONS_PREFIX: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  console.error("Invalid environment variables:\n" + details);
  console.error(
    "\nCopy backend/.env.example to backend/.env and paste your Supabase keys.",
  );
  process.exit(1);
}

const data = parsed.data;

function buildAllowedOrigins(): string[] {
  const set = new Set<string>([
    data.FRONTEND_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);
  if (data.CORS_ORIGINS) {
    for (const part of data.CORS_ORIGINS.split(",")) {
      const trimmed = part.trim();
      if (trimmed) set.add(trimmed.replace(/\/$/, ""));
    }
  }
  return Array.from(set);
}

export const env = {
  ...data,
  ALLOWED_ORIGINS: buildAllowedOrigins(),
};

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (env.ALLOWED_ORIGINS.includes(origin)) return true;
  // Dev: allow private LAN / link-local origins on port 3000.
  if (env.NODE_ENV === "development") {
    try {
      const url = new URL(origin);
      if (url.port !== "3000" && url.port !== "") return false;
      const host = url.hostname;
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}
