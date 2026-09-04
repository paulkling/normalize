import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { currentPeriod, periodResetAt } from "../../core/period.js";
import type { Deps } from "../../deps.js";
import { DEFAULT_PLAN_ID, type AllowlistEntry, type ApiKey, type InferenceLog } from "../../repos/types.js";
import { SESSION_COOKIE, decodeSession } from "../../services/adminSession.js";
import { Document, Shell } from "./layout.js";
import { ensureCsrf, requireAdmin, type AdminEnv } from "./middleware.js";

const fmtDate = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z").replace(/Z$/, " UTC") : "—");
const fmtMonth = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtDay = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const pct = (n: number) => `${Math.round(n * 100)}%`;
const n = (v: number) => v.toLocaleString("en-US");

const StatusTag = ({ status, code }: { status: number; code: string | null }) => (
  <span class={`tag ${status === 200 ? "ok" : status >= 500 ? "danger" : "warn"}`}>{status}{code ? ` ${code}` : ""}</span>
);

const LogsTable = ({ logs, canView }: { logs: InferenceLog[]; canView: boolean }) =>
  logs.length === 0 ? (
    <div class="empty">No requests match. Once a caller hits /v1/normalize, rows appear here.</div>
  ) : (
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Status</th>
          <th>Key</th>
          <th>User</th>
          <th>Controls</th>
          <th class="num">Chars in / out</th>
          <th class="num">Latency</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {logs.map((l) => (
          <tr>
            <td class="mono">{fmtDate(l.created_at)}</td>
            <td><StatusTag status={l.status} code={l.error_code} /></td>
            <td class="mono">{l.key_prefix ? `${l.key_prefix}…` : "—"}</td>
            <td>{l.user_id ?? "—"}</td>
            <td class="muted">{[l.styling, l.structure, l.context].filter(Boolean).join(" / ") || "—"}</td>
            <td class="num">{l.input_chars ?? "—"} / {l.output_chars ?? "—"}</td>
            <td class="num">{l.latency_ms != null ? `${l.latency_ms} ms` : "—"}</td>
            <td><button class="link" type="button" data-action="open-log" data-id={l.id}>{canView ? "Open" : "Details"}</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );

const LogPanel = () => (
  <aside class="panel" aria-label="Request detail">
    <button class="close" type="button" data-action="close-panel">Close</button>
    <h2>Request</h2>
    <div class="panel-body"></div>
  </aside>
);

export function adminPageRoutes(deps: Deps) {
  const app = new Hono<AdminEnv>();

  app.get("/login", (c) => {
    const csrf = ensureCsrf(c, deps);
    const reason = c.req.query("reason");
    const hasSession = !!decodeSession(getCookie(c, SESSION_COOKIE), deps.config.sessionSecret);
    if (hasSession && !reason) return c.redirect("/admin");
    return c.html(
      <Document title="Sign in" csrf={csrf}>
        <div class="login">
          <div class="card">
            <h1>Normalize</h1>
            <p class="muted">Admin console. Sign in with your work email to get a one-time link.</p>
            {reason ? <div class="banner">{reason}</div> : null}
            <form data-api="/admin/auth/login" data-on-success="login">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" autocomplete="email" required autofocus />
              <button class="primary" type="submit">Send sign-in link</button>
            </form>
            <div id="sent" hidden>
              <p><b>Check your inbox.</b></p>
              <p class="muted">If that address is allowlisted, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
            </div>
          </div>
        </div>
      </Document>,
    );
  });

  app.use("*", requireAdmin(deps));

  const shell = async (c: any) => {
    const { entry } = c.get("admin");
    const settings = await deps.repos.settings.get();
    return { admin: { email: entry.email, role: entry.role, can_view_transcripts: entry.can_view_transcripts }, csrf: c.get("csrfToken") as string, banner: settings.maintenance_banner || undefined };
  };

  app.get("/", async (c) => {
    const s = await shell(c);
    const now = deps.clock();
    const stats = await deps.repos.logs.stats(now);
    const keys = await deps.repos.apiKeys.list();
    const usage = new Map((await deps.repos.quotaUsage.listForPeriod(currentPeriod(now))).filter((u) => u.user_id === "").map((u) => [u.key_id, u]));
    const rows = await Promise.all(keys.map(async (k) => { const lim = await deps.quota.limitsFor(k); const u = usage.get(k.id); const limit = lim.monthly + (u?.topped_up ?? 0); return { k, used: u?.used ?? 0, limit }; }));
    const active = rows.filter((r) => !r.k.revoked_at);
    const used = active.reduce((a, r) => a + r.used, 0);
    const limit = active.reduce((a, r) => a + r.limit, 0);
    const burn = limit ? used / limit : 0;
    return c.html(
      <Shell title="Dashboard" active="dashboard" {...s}>
        <div class="head"><div><h1>{fmtMonth(currentPeriod(now))}</h1><p>Usage across all active keys this UTC month. Quotas reset {fmtDay(periodResetAt(now))}.</p></div></div>
        <div class="card">
          <p class="lede">{active.length === 0 ? <span>No active keys yet. <a href="/admin/keys">Create the first one</a> to let a service call the API.</span> : <span><b>{n(used)}</b> of <b>{n(limit)}</b> requests used ({pct(burn)}) across {active.length} active {active.length === 1 ? "key" : "keys"}.</span>}</p>
          {limit > 0 ? <div class={`bar${burn > 0.9 ? " hot" : ""}`}><i style={`width:${Math.min(100, burn * 100)}%`}></i></div> : null}
          <div class="facts">
            <div>Requests today<b>{n(stats.requests_today)}</b></div>
            <div>Error rate today<b>{stats.requests_today ? pct(stats.errors_today / stats.requests_today) : "—"}</b></div>
            <div>p95 latency today<b>{stats.p95_latency_ms_today != null ? `${n(stats.p95_latency_ms_today)} ms` : "—"}</b></div>
            <div>Requests this month<b>{n(stats.requests_month)}</b></div>
          </div>
        </div>
        {rows.length > 0 ? (
          <div class="card">
            <h2>Keys this month</h2>
            <table>
              <thead><tr><th>Key</th><th>Status</th><th class="num">Used</th><th class="num">Limit</th><th class="num">Remaining</th><th>Last used</th></tr></thead>
              <tbody>{rows.map(({ k, used, limit }) => (
                <tr data-href={`/admin/keys/${k.id}`}><td>{k.name} <span class="mono muted">{k.prefix}…</span></td><td>{k.revoked_at ? <span class="tag danger">revoked</span> : <span class="tag ok">active</span>}</td><td class="num">{n(used)}</td><td class="num">{n(limit)}</td><td class="num">{n(Math.max(0, limit - used))}</td><td class="mono">{fmtDate(k.last_used_at)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </Shell>,
    );
  });

  app.get("/keys", async (c) => {
    const s = await shell(c);
    const keys = await deps.repos.apiKeys.list();
    const withUsage = await Promise.all(keys.map(async (k) => ({ k, u: await deps.quota.remainingFor(k), lim: await deps.quota.limitsFor(k) })));
    return c.html(
      <Shell title="API keys" active="keys" {...s}>
        <div class="head"><div><h1>API keys</h1><p>Each key belongs to one internal app or teammate. The secret is shown once, at creation.</p></div></div>
        <div class="card">
          <h2>Create a key</h2>
          <form class="grid" data-api="/admin/api/keys" data-on-success="reveal-key">
            <div><label for="k-name">Name</label><input id="k-name" name="name" required maxlength={120} placeholder="dictation-backend" /></div>
            <div><label for="k-owner">Owner email</label><input id="k-owner" name="owner_email" type="email" placeholder="team@brainsprung.com" /></div>
            <div><label for="k-monthly">Monthly requests (blank = default)</label><input id="k-monthly" name="monthly_override" type="number" min={0} /></div>
            <div><label for="k-rps">Requests per second (blank = default)</label><input id="k-rps" name="rps_override" type="number" min={1} /></div>
            <div class="full"><label for="k-notes">Notes</label><textarea id="k-notes" name="notes" maxlength={2000}></textarea></div>
            <div><button class="primary" type="submit">Create key</button></div>
          </form>
          <div id="reveal" class="reveal" hidden>
            <p>Copy this key now. It will not be shown again.</p>
            <code></code>
            <button type="button" data-action="copy" data-value="">Copy key</button>
          </div>
        </div>
        <div class="card">
          <h2>All keys</h2>
          {keys.length === 0 ? <div class="empty">No keys yet.</div> : (
            <table>
              <thead><tr><th>Name</th><th>Prefix</th><th>Status</th><th class="num">Used / limit</th><th>Last used</th><th>Created</th><th></th></tr></thead>
              <tbody>{withUsage.map(({ k, u }) => (
                <tr data-href={`/admin/keys/${k.id}`}>
                  <td>{k.name}{k.owner_email ? <span class="muted"> · {k.owner_email}</span> : null}</td>
                  <td class="mono">{k.prefix}…</td>
                  <td>{k.revoked_at ? <span class="tag danger">revoked</span> : <span class="tag ok">active</span>}</td>
                  <td class="num">{n(u.used)} / {n(u.limit)}</td>
                  <td class="mono">{fmtDate(k.last_used_at)}</td>
                  <td class="mono">{fmtDate(k.created_at)}</td>
                  <td>{k.revoked_at ? null : <button class="danger" type="button" data-action="revoke-key" data-id={k.id}>Revoke</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </Shell>,
    );
  });

  app.get("/keys/:id", async (c) => {
    const s = await shell(c);
    const key = await deps.repos.apiKeys.findById(c.req.param("id"));
    if (!key) return c.notFound();
    const u = await deps.quota.remainingFor(key);
    const lim = await deps.quota.limitsFor(key);
    const plan = await deps.repos.quotaPlans.get(key.plan_id);
    const logs = await deps.repos.logs.list({ key_id: key.id, limit: 25 });
    return c.html(
      <Shell title={key.name} active="keys" {...s}>
        <div class="head"><div><p class="muted" style="margin:0"><a href="/admin/keys">API keys</a></p><h1>{key.name}</h1><p><span class="mono">{key.prefix}…</span>{key.owner_email ? ` · ${key.owner_email}` : ""} · created {fmtDate(key.created_at)}{key.created_by ? ` by ${key.created_by}` : ""}</p></div>
          <div class="actions">{key.revoked_at ? <span class="tag danger">Revoked {fmtDate(key.revoked_at)}</span> : <button class="danger" type="button" data-action="revoke-key" data-id={key.id}>Revoke key</button>}</div></div>
        <div class="card">
          <p class="lede"><b>{n(u.used)}</b> of <b>{n(u.limit)}</b> requests used this month. Resets {fmtDay(u.reset_at)}.</p>
          <div class={`bar${u.limit && u.used / u.limit > 0.9 ? " hot" : ""}`}><i style={`width:${u.limit ? Math.min(100, (u.used / u.limit) * 100) : 0}%`}></i></div>
          <div class="facts"><div>Rate limit<b>{lim.rps} rps</b></div><div>Last used<b>{fmtDate(key.last_used_at)}</b></div></div>
        </div>
        <div class="card">
          <h2>Limits and details</h2>
          <form class="grid" data-api={`/admin/api/keys/${key.id}`} data-method="PATCH" data-on-success="reload">
            <div><label for="e-name">Name</label><input id="e-name" name="name" value={key.name} required /></div>
            <div><label for="e-owner">Owner email</label><input id="e-owner" name="owner_email" type="email" value={key.owner_email ?? ""} /></div>
            <div><label for="e-monthly">Monthly requests (blank = plan default {plan?.monthly_requests ?? 100})</label><input id="e-monthly" name="monthly_override" type="number" min={0} value={key.monthly_override ?? ""} /></div>
            <div><label for="e-rps">Requests per second (blank = plan default {plan?.rps ?? 5})</label><input id="e-rps" name="rps_override" type="number" min={1} value={key.rps_override ?? ""} /></div>
            <div class="full"><label for="e-notes">Notes</label><textarea id="e-notes" name="notes">{key.notes ?? ""}</textarea></div>
            <div><button class="primary" type="submit">Save changes</button></div>
          </form>
        </div>
        <div class="card"><h2>Recent requests</h2><LogsTable logs={logs} canView={s.admin.can_view_transcripts} /><p class="footer" style="margin-top:1rem"><a href={`/admin/logs?key_id=${key.id}`}>All requests for this key</a></p></div>
        <LogPanel />
      </Shell>,
    );
  });

  app.get("/logs", async (c) => {
    const s = await shell(c);
    const q = c.req.query();
    const status = q.status ? Number(q.status) : undefined;
    const limit = 50;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const from = q.from ? `${q.from}T00:00:00.000Z` : undefined;
    const to = q.to ? `${q.to}T23:59:59.999Z` : undefined;
    const logs = await deps.repos.logs.list({ key_id: q.key_id || undefined, user_id: q.user_id || undefined, from, to, status: Number.isFinite(status) ? status : undefined, limit: limit + 1, offset });
    const hasMore = logs.length > limit;
    const keys = await deps.repos.apiKeys.list();
    const link = (o: number) => { const p = new URLSearchParams({ ...q, offset: String(o) }); return `/admin/logs?${p}`; };
    return c.html(
      <Shell title="Logs" active="logs" {...s}>
        <div class="head"><div><h1>Request log</h1><p>Every call to /v1/normalize, including rejected ones. {s.admin.can_view_transcripts ? "Opening a request shows its transcript and records an audit event." : "Your account sees metadata only; transcripts stay hidden."}</p></div></div>
        <div class="card">
          <form class="filters" method="get" action="/admin/logs">
            <div><label for="f-key">Key</label><select id="f-key" name="key_id"><option value="">Any</option>{keys.map((k) => <option value={k.id} selected={q.key_id === k.id}>{k.name} ({k.prefix}…)</option>)}</select></div>
            <div><label for="f-user">User id</label><input id="f-user" name="user_id" value={q.user_id ?? ""} /></div>
            <div><label for="f-status">Status</label><select id="f-status" name="status"><option value="">Any</option>{[200, 400, 401, 403, 413, 429, 500, 503, 504].map((st) => <option value={String(st)} selected={q.status === String(st)}>{st}</option>)}</select></div>
            <div><label for="f-from">From (UTC)</label><input id="f-from" name="from" type="date" value={q.from ?? ""} /></div>
            <div><label for="f-to">To (UTC)</label><input id="f-to" name="to" type="date" value={q.to ?? ""} /></div>
            <div><button type="submit">Filter</button> <a class="btn" href="/admin/logs">Clear</a></div>
          </form>
          <LogsTable logs={logs.slice(0, limit)} canView={s.admin.can_view_transcripts} />
          <div class="actions" style="margin-top:1rem">{offset > 0 ? <a class="btn" href={link(Math.max(0, offset - limit))}>Newer</a> : null}{hasMore ? <a class="btn" href={link(offset + limit)}>Older</a> : null}</div>
        </div>
        <LogPanel />
      </Shell>,
    );
  });

  app.get("/quotas", async (c) => {
    const s = await shell(c);
    const plan = (await deps.repos.quotaPlans.get(DEFAULT_PLAN_ID))!;
    const overrides = (await deps.repos.apiKeys.list()).filter((k) => !k.revoked_at && (k.monthly_override !== null || k.rps_override !== null));
    return c.html(
      <Shell title="Quotas" active="quotas" {...s}>
        <div class="head"><div><h1>Quotas</h1><p>Defaults apply to every key without an override. Counts reset at the start of each UTC month; only successful requests count.</p></div></div>
        <div class="card">
          <h2>Default plan</h2>
          <form class="grid" data-api="/admin/api/quotas" data-method="PATCH" data-on-success="reload">
            <div><label for="q-monthly">Requests per key per month</label><input id="q-monthly" name="monthly_requests" type="number" min={0} value={plan.monthly_requests} required /></div>
            <div><label for="q-rps">Requests per second per key</label><input id="q-rps" name="rps" type="number" min={1} value={plan.rps} required /></div>
            <div><button class="primary" type="submit">Save defaults</button></div>
          </form>
        </div>
        <div class="card">
          <h2>Per-key overrides</h2>
          {overrides.length === 0 ? <div class="empty">No key overrides. Set one from a key's detail page.</div> : (
            <table><thead><tr><th>Key</th><th class="num">Monthly</th><th class="num">RPS</th></tr></thead><tbody>{overrides.map((k) => <tr data-href={`/admin/keys/${k.id}`}><td>{k.name} <span class="mono muted">{k.prefix}…</span></td><td class="num">{k.monthly_override ?? <span class="muted">default</span>}</td><td class="num">{k.rps_override ?? <span class="muted">default</span>}</td></tr>)}</tbody></table>
          )}
        </div>
      </Shell>,
    );
  });

  app.get("/allowlist", async (c) => {
    const s = await shell(c);
    if (s.admin.role !== "super_admin") return c.redirect("/admin");
    const entries = await deps.repos.allowlist.list();
    const me = s.admin.email;
    const Row = ({ e }: { e: AllowlistEntry }) => (
      <tr>
        <td>{e.email}{e.email === me ? <span class="muted"> (you)</span> : null}{e.disabled_at ? <span class="tag danger" style="margin-left:.5rem">disabled</span> : null}</td>
        <td>{e.email === me ? "Super-admin" : <select class="inline" name="role" data-patch-entry={e.id}><option value="admin" selected={e.role === "admin"}>Admin</option><option value="super_admin" selected={e.role === "super_admin"}>Super-admin</option></select>}</td>
        <td><label style="display:flex;gap:.4rem;align-items:center;color:var(--ink)"><input class="inline" type="checkbox" name="can_view_transcripts" checked={e.can_view_transcripts} data-patch-entry={e.id} /> can view</label></td>
        <td class="mono">{fmtDate(e.last_login_at)}</td>
        <td class="muted">{e.invited_by ?? "seed"}</td>
        <td><div class="actions">
          {e.email === me ? null : e.disabled_at ? <button type="button" data-action="toggle-entry" data-id={e.id} data-patch='{"disabled":false}'>Re-enable</button> : <button type="button" data-action="toggle-entry" data-id={e.id} data-patch='{"disabled":true}'>Disable</button>}
          <button type="button" data-action="revoke-sessions" data-id={e.id}>End sessions</button>
          {e.email === me ? null : <button class="danger" type="button" data-action="remove-entry" data-id={e.id} data-email={e.email}>Remove</button>}
        </div></td>
      </tr>
    );
    return c.html(
      <Shell title="Allowlist" active="allowlist" {...s}>
        <div class="head"><div><h1>Allowlist</h1><p>Only these addresses can request a sign-in link. Removing someone ends their sessions immediately.</p></div></div>
        <div class="card">
          <h2>Add an admin</h2>
          <form class="grid" data-api="/admin/api/allowlist" data-on-success="reload">
            <div><label for="a-email">Email</label><input id="a-email" name="email" type="email" required /></div>
            <div><label for="a-role">Role</label><select id="a-role" name="role"><option value="admin">Admin: keys, quotas, logs</option><option value="super_admin">Super-admin: also manages this list</option></select></div>
            <div><label style="display:flex;gap:.4rem;align-items:center;color:var(--ink);margin-bottom:.6rem"><input class="inline" type="checkbox" name="can_view_transcripts" /> Can view transcripts</label></div>
            <div><button class="primary" type="submit">Add to allowlist</button></div>
          </form>
        </div>
        <div class="card">
          <h2>Admins</h2>
          <table><thead><tr><th>Email</th><th>Role</th><th>Transcripts</th><th>Last sign-in</th><th>Added by</th><th></th></tr></thead><tbody>{entries.map((e) => <Row e={e} />)}</tbody></table>
        </div>
      </Shell>,
    );
  });

  app.get("/settings", async (c) => {
    const s = await shell(c);
    const settings = await deps.repos.settings.get();
    const audit = await deps.repos.audit.list(50);
    return c.html(
      <Shell title="Settings" active="settings" {...s}>
        <div class="head"><div><h1>Settings</h1></div></div>
        <div class="card">
          <form class="grid" data-api="/admin/api/settings" data-method="PATCH" data-on-success="reload">
            <div><label for="s-ret">Keep transcripts for</label><select id="s-ret" name="retention_days">{[7, 30, 90].map((d) => <option value={String(d)} selected={settings.retention_days === d}>{d} days</option>)}</select></div>
            <div><label for="s-rps">Default requests per second</label><input id="s-rps" name="default_rps" type="number" min={1} value={settings.default_rps} /></div>
            <div><label for="s-max">Maximum transcript characters</label><input id="s-max" name="max_transcript_chars" type="number" min={1} max={20000} value={settings.max_transcript_chars} /></div>
            <div class="full"><label for="s-banner">Maintenance banner (blank to hide)</label><input id="s-banner" name="maintenance_banner" value={settings.maintenance_banner} maxlength={500} /></div>
            <div><button class="primary" type="submit">Save settings</button></div>
          </form>
          <p class="footer">Retention is applied by a scheduled database job (Phase 2). Until then, older transcripts are cleared manually.</p>
        </div>
        <div class="card">
          <h2>Audit log</h2>
          {audit.length === 0 ? <div class="empty">Nothing recorded yet.</div> : (
            <table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>{audit.map((a) => <tr><td class="mono">{fmtDate(a.created_at)}</td><td>{a.actor_email}</td><td class="mono">{a.action}</td><td class="mono">{a.target ?? "—"}</td><td class="muted mono">{a.details ? JSON.stringify(a.details) : ""}</td></tr>)}</tbody></table>
          )}
        </div>
      </Shell>,
    );
  });

  return app;
}
