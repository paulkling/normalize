/** Admin identity boundary. Supabase Auth in production, a fake in tests. */
export interface IdentitySession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  expiresAt: number; // epoch seconds
}

export interface IdentityProvider {
  /** Creates (or finds) the auth user for an allowlisted email. Returns the auth user id. */
  ensureUser(email: string): Promise<string>;
  sendMagicLink(email: string, redirectTo: string): Promise<void>;
  /** Exchanges the token hash from the magic-link callback for a session. */
  verifyMagicLink(tokenHash: string): Promise<IdentitySession | null>;
  /** Verifies an access token locally. Returns null when invalid or expired. */
  verifyAccessToken(accessToken: string): Promise<{ userId: string; email: string } | null>;
  refreshSession(refreshToken: string): Promise<IdentitySession | null>;
  revokeSessions(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

export class FakeIdentityProvider implements IdentityProvider {
  users = new Map<string, string>(); // email -> userId
  sentLinks: { email: string; redirectTo: string; tokenHash: string }[] = [];
  private tokenHashes = new Map<string, string>(); // tokenHash -> email
  private sessions = new Map<string, { email: string; userId: string; expiresAt: number; revoked: boolean }>(); // accessToken -> session
  private refreshTokens = new Map<string, string>(); // refresh -> accessToken
  private seq = 0;
  clock: () => number = () => Math.floor(Date.now() / 1000);
  accessTtlSeconds = 3600;

  async ensureUser(email: string) {
    const e = email.toLowerCase();
    let id = this.users.get(e);
    if (!id) {
      id = `user_${++this.seq}`;
      this.users.set(e, id);
    }
    return id;
  }
  async sendMagicLink(email: string, redirectTo: string) {
    const tokenHash = `th_${++this.seq}`;
    this.tokenHashes.set(tokenHash, email.toLowerCase());
    this.sentLinks.push({ email: email.toLowerCase(), redirectTo, tokenHash });
  }
  private issue(email: string): IdentitySession {
    const userId = this.users.get(email)!;
    const accessToken = `at_${++this.seq}`;
    const refreshToken = `rt_${++this.seq}`;
    const expiresAt = this.clock() + this.accessTtlSeconds;
    this.sessions.set(accessToken, { email, userId, expiresAt, revoked: false });
    this.refreshTokens.set(refreshToken, accessToken);
    return { accessToken, refreshToken, userId, email, expiresAt };
  }
  async verifyMagicLink(tokenHash: string) {
    const email = this.tokenHashes.get(tokenHash);
    if (!email) return null;
    this.tokenHashes.delete(tokenHash);
    if (!this.users.has(email)) return null;
    return this.issue(email);
  }
  async verifyAccessToken(accessToken: string) {
    const s = this.sessions.get(accessToken);
    if (!s || s.revoked || s.expiresAt <= this.clock()) return null;
    return { userId: s.userId, email: s.email };
  }
  async refreshSession(refreshToken: string) {
    const at = this.refreshTokens.get(refreshToken);
    if (!at) return null;
    const s = this.sessions.get(at);
    if (!s || s.revoked) return null;
    this.refreshTokens.delete(refreshToken);
    return this.issue(s.email);
  }
  async revokeSessions(userId: string) {
    for (const s of this.sessions.values()) if (s.userId === userId) s.revoked = true;
  }
  async deleteUser(userId: string) {
    await this.revokeSessions(userId);
    for (const [email, id] of this.users) if (id === userId) this.users.delete(email);
  }
}
