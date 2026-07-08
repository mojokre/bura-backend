/**
 * Supabase Auth requires an email. We only collect username from users,
 * so we map username -> deterministic internal email.
 */
export function usernameToAuthEmail(username: string): string {
  return `${username.toLowerCase()}@users.bura.local`;
}
