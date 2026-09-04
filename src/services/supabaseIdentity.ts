import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { IdentityProvider, IdentitySession } from "./identity.js";

export interface SupabaseIdentityOptions {
  url: string;
  /** Service-role (secret) key. Server-side only. */
  serviceRoleKey: string;
  /** Legacy HS256 JWT secret. When absent, tokens are verified against the project's JWKS. */
  jwtSecret?: string | null;
}

/**
 * Supabase Auth adapter.
 *
 * Magic links are requested with the admin API and delivered by Supabase's SMTP (Resend).
 * The email template must link to `{{ .SiteURL }}/admin/auth/callback?token_hash={{ .TokenHash }}&type=magiclink`
 * so that the callback can verify the token server-side.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
  private readonly admin: SupabaseClient;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private readonly jwtSecret: Uint8Array | null;

  constructor(private readonly opts: SupabaseIdentityOptions) {
    this.admin = createClient(opts.url, opts.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
    this.jwtSecret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : null;
    this.jwks = this.jwtSecret ? null : createRemoteJWKSet(new URL(`${opts.url}/auth/v1/.well-known/jwks.json`));
  }

  async ensureUser(email: string): Promise<string> {
    const { data, error } = await this.admin.auth.admin.createUser({ email, email_confirm: true });
    if (!error && data.user) return data.user.id;
    // Already exists: find it. listUsers has no exact filter, so page until found.
    let page = 1;
    for (;;) {
      const res = await this.admin.auth.admin.listUsers({ page, perPage: 200 });
      if (res.error) throw res.error;
      const hit = res.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (hit) return hit.id;
      if (res.data.users.length < 200) break;
      page += 1;
    }
    throw error ?? new Error("could not create or find auth user");
  }

  async sendMagicLink(email: string, redirectTo: string): Promise<void> {
    const { error } = await this.admin.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
    if (error) throw error;
  }

  async verifyMagicLink(tokenHash: string): Promise<IdentitySession | null> {
    const { data, error } = await this.admin.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    if (error || !data.session || !data.user?.email) return null;
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      userId: data.user.id,
      email: data.user.email.toLowerCase(),
      expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + data.session.expires_in,
    };
  }

  async verifyAccessToken(accessToken: string): Promise<{ userId: string; email: string } | null> {
    try {
      const issuer = `${this.opts.url}/auth/v1`;
      const { payload } = this.jwtSecret
        ? await jwtVerify(accessToken, this.jwtSecret, { issuer, audience: "authenticated" })
        : await jwtVerify(accessToken, this.jwks!, { issuer, audience: "authenticated" });
      const p = payload as JWTPayload & { email?: string };
      if (!p.sub || !p.email) return null;
      return { userId: p.sub, email: p.email.toLowerCase() };
    } catch {
      return null;
    }
  }

  async refreshSession(refreshToken: string): Promise<IdentitySession | null> {
    const { data, error } = await this.admin.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session || !data.user?.email) return null;
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      userId: data.user.id,
      email: data.user.email.toLowerCase(),
      expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + data.session.expires_in,
    };
  }

  async revokeSessions(userId: string): Promise<void> {
    const { error } = await this.admin.auth.admin.signOut(userId as any, "global").catch((e: unknown) => ({ error: e as Error }));
    if (error) {
      // Older SDKs only accept a JWT; fall back to updating the user, which invalidates refresh tokens.
      const upd = await this.admin.auth.admin.updateUserById(userId, { ban_duration: "1s" });
      if (upd.error) throw upd.error;
    }
  }

  async deleteUser(userId: string): Promise<void> {
    const { error } = await this.admin.auth.admin.deleteUser(userId);
    if (error) throw error;
  }
}
