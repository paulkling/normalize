import type { FC, PropsWithChildren } from "hono/jsx";

export const CSS = `
:root{--bg:#EEF1F4;--surface:#FFFFFF;--ink:#1B2430;--muted:#5C6B7A;--line:#D7DDE3;--accent:#0F6E63;--accent-ink:#0A4A43;--warn:#8A5A00;--warn-bg:#FFF4D6;--danger:#B42318;--danger-bg:#FDECEA;--ok:#1E6B3A;--ok-bg:#E3F3E8;--mono:"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}html{font-size:15px}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3{font-family:var(--serif);font-weight:500;margin:0;letter-spacing:-0.01em}
h1{font-size:2rem;line-height:1.15}h2{font-size:1.35rem}h3{font-size:1.1rem}
p{margin:0 0 .75rem}
.shell{display:grid;grid-template-columns:200px 1fr;min-height:100vh}
.rail{background:var(--surface);border-right:1px solid var(--line);padding:1.5rem 1rem;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:.5rem;font-family:var(--serif);font-size:1.35rem;padding:0 .5rem .25rem;color:var(--ink)}
.mark{border-radius:6px;flex:none;display:block}
.brand small{display:block;font-family:var(--sans);font-size:.75rem;color:var(--muted)}
.nav{display:flex;flex-direction:column;gap:2px;margin-top:1.25rem}
.nav a{padding:.45rem .6rem;border-radius:6px;color:var(--ink)}
.nav a:hover{background:var(--bg);text-decoration:none}
.nav a[aria-current=page]{background:var(--accent);color:#fff}
.rail .who{margin-top:auto;font-size:.85rem;color:var(--muted);padding:0 .5rem}
.rail .who b{display:block;color:var(--ink);font-weight:500;overflow-wrap:anywhere}
.main{padding:2rem 2.5rem;max-width:1180px;width:100%}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;margin-bottom:1.5rem}
.head p{color:var(--muted);margin:.35rem 0 0;max-width:60ch}
.banner{background:var(--warn-bg);color:var(--warn);padding:.6rem 1rem;border-radius:6px;margin-bottom:1.25rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
.card h2{margin-bottom:.75rem}
.lede{font-size:1.15rem;max-width:60ch}
.lede b{font-weight:600}
.bar{height:8px;background:var(--bg);border-radius:4px;overflow:hidden;margin:.5rem 0 1rem;max-width:520px}
.bar i{display:block;height:100%;background:var(--accent)}
.bar.hot i{background:var(--danger)}
.facts{display:flex;gap:2.5rem;flex-wrap:wrap;color:var(--muted);margin-top:.5rem}
.facts b{display:block;color:var(--ink);font-size:1.4rem;font-family:var(--serif);font-weight:500}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th{text-align:left;font-weight:500;color:var(--muted);padding:.4rem .6rem;border-bottom:1px solid var(--line)}
td{padding:.55rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr[data-href]{cursor:pointer}tbody tr[data-href]:hover{background:#F6F8FA}
.num{text-align:right;font-variant-numeric:tabular-nums}
code,.mono{font-family:var(--mono);font-size:.88em}
.tag{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.78rem;background:var(--bg);color:var(--muted)}
.tag.ok{background:var(--ok-bg);color:var(--ok)}.tag.danger{background:var(--danger-bg);color:var(--danger)}.tag.warn{background:var(--warn-bg);color:var(--warn)}
.muted{color:var(--muted)}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:.45rem .9rem;border-radius:6px;cursor:pointer}
button:hover,.btn:hover{border-color:#B8C2CC;text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover{background:var(--accent-ink)}
button.danger{color:var(--danger);border-color:#F0B9B3}button.danger:hover{background:var(--danger-bg)}
button.link{border:0;background:none;color:var(--accent);padding:0}button.link:hover{text-decoration:underline}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
form.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.9rem 1.25rem;align-items:end}
form.grid .full{grid-column:1/-1}
label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:.25rem}
input,select,textarea{font:inherit;width:100%;padding:.45rem .6rem;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink)}
textarea{min-height:4.5rem;resize:vertical}
.actions{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.filters{display:flex;gap:.75rem;flex-wrap:wrap;align-items:end;margin-bottom:1rem}
.filters label{margin:0}
.filters > div{min-width:150px}
.reveal{background:var(--ink);color:#fff;border-radius:8px;padding:1.25rem 1.5rem;margin:1rem 0}
.reveal p{color:#C5CED6;margin-bottom:.5rem}
.reveal code{display:block;font-size:1.2rem;word-break:break-all;margin:.5rem 0 1rem;color:#fff}
.reveal button{background:#fff;border-color:#fff;color:var(--ink)}
.panel{position:fixed;top:0;right:0;height:100vh;width:min(560px,100%);background:var(--surface);border-left:1px solid var(--line);padding:1.5rem;overflow:auto;box-shadow:-12px 0 30px rgba(27,36,48,.12);transform:translateX(100%);transition:transform .18s ease}
.panel.open{transform:none}
@media (prefers-reduced-motion:reduce){.panel{transition:none}}
.panel .close{position:absolute;top:1rem;right:1rem}
.transcript{background:var(--bg);border-radius:6px;padding:.9rem 1rem;white-space:pre-wrap;word-break:break-word;font-size:.95rem;margin:.5rem 0 1rem}
.redacted{border:1px dashed var(--line);border-radius:6px;padding:.9rem 1rem;color:var(--muted);margin:.5rem 0 1rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1.25rem;margin:0 0 1rem;font-size:.92rem}
dt{color:var(--muted)}dd{margin:0;word-break:break-all}
.toast{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:.6rem 1rem;border-radius:6px;font-size:.9rem;opacity:0;pointer-events:none;transition:opacity .15s}
.toast.show{opacity:1}
.toast.error{background:var(--danger)}
.login{min-height:100vh;display:grid;place-items:center;padding:2rem}
.login .card{width:min(420px,100%);padding:2rem}
.login h1{margin-bottom:.35rem}
.login .mark{width:56px;height:56px;border-radius:12px;margin-bottom:1rem}
.login form{margin-top:1.25rem}
.login button{width:100%;margin-top:.9rem}
.empty{padding:2rem 1rem;text-align:center;color:var(--muted)}
.footer{margin-top:2rem;font-size:.82rem;color:var(--muted)}
.inline{display:inline;width:auto}
`;

export const JS = `
(function(){
const csrf=document.querySelector('meta[name="csrf-token"]')?.content||'';
const toastEl=document.createElement('div');toastEl.className='toast';document.body.appendChild(toastEl);
let toastTimer;
window.toast=function(msg,isError){toastEl.textContent=msg;toastEl.className='toast show'+(isError?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastEl.className='toast',isError?5000:2500)};
window.api=async function(method,path,body){
  const res=await fetch(path,{method,headers:{'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});
  let data=null;try{data=await res.json()}catch(e){}
  if(!res.ok){const m=(data&&data.error&&data.error.message)||('Request failed ('+res.status+')');const d=data&&data.error&&data.error.details;throw new Error(Array.isArray(d)&&d.length?m+' '+d.map(x=>x.path+': '+x.message).join('; '):m)}
  return data;
};
window.formData=function(form){const o={};new FormData(form).forEach((v,k)=>{if(k.startsWith('_'))return;const el=form.elements[k];if(el&&el.type==='checkbox'){o[k]=el.checked;return}if(el&&el.type==='number'){o[k]=v===''?null:Number(v);return}o[k]=v===''?null:v});return o};
document.addEventListener('click',async function(e){
  const t=e.target.closest('[data-action]');
  if(t){
    const a=t.dataset.action;
    try{
      if(a==='logout'){await api('POST','/admin/auth/logout');location.href='/admin/login';}
      else if(a==='revoke-key'){if(!confirm('Revoke this key? Callers using it will get 403 immediately.'))return;await api('POST','/admin/api/keys/'+t.dataset.id+'/revoke');toast('Key revoked');location.reload();}
      else if(a==='copy'){await navigator.clipboard.writeText(t.dataset.value);toast('Copied');}
      else if(a==='remove-entry'){if(!confirm('Remove '+t.dataset.email+' from the allowlist? Their sessions end now.'))return;await api('DELETE','/admin/api/allowlist/'+t.dataset.id);toast('Removed');location.reload();}
      else if(a==='toggle-entry'){await api('PATCH','/admin/api/allowlist/'+t.dataset.id,JSON.parse(t.dataset.patch));toast('Saved');location.reload();}
      else if(a==='revoke-sessions'){await api('POST','/admin/api/allowlist/'+t.dataset.id+'/revoke-sessions');toast('Sessions ended');}
      else if(a==='open-log'){openLog(t.dataset.id);}
      else if(a==='close-panel'){document.querySelector('.panel')?.classList.remove('open');}
    }catch(err){toast(err.message,true)}
    return;
  }
  const row=e.target.closest('tr[data-href]');
  if(row&&!e.target.closest('a,button')){location.href=row.dataset.href}
});
document.addEventListener('change',async function(e){
  const t=e.target.closest('[data-patch-entry]');
  if(!t)return;
  try{const patch={};patch[t.name]=t.type==='checkbox'?t.checked:t.value;await api('PATCH','/admin/api/allowlist/'+t.dataset.patchEntry,patch);toast('Saved')}catch(err){toast(err.message,true);location.reload()}
});
document.addEventListener('submit',async function(e){
  const f=e.target;if(!f.dataset.api)return;e.preventDefault();
  const btn=f.querySelector('button[type=submit]');if(btn)btn.disabled=true;
  try{
    const data=await api(f.dataset.method||'POST',f.dataset.api,formData(f));
    if(f.dataset.onSuccess==='reveal-key'){const r=document.getElementById('reveal');r.querySelector('code').textContent=data.secret;r.querySelector('[data-action=copy]').dataset.value=data.secret;r.hidden=false;f.reset();r.scrollIntoView({behavior:'smooth'});}
    else if(f.dataset.onSuccess==='login'){f.hidden=true;document.getElementById('sent').hidden=false;}
    else if(f.dataset.onSuccess==='reload'){toast('Saved');location.reload();}
    else toast('Saved');
  }catch(err){toast(err.message,true)}
  finally{if(btn)btn.disabled=false}
});
async function openLog(id){
  const panel=document.querySelector('.panel');if(!panel)return;
  panel.querySelector('.panel-body').innerHTML='<p class="muted">Loading…</p>';panel.classList.add('open');
  try{
    const {log}=await api('GET','/admin/api/logs/'+id);
    const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const rows=[['Request',log.id],['Time',log.created_at],['Status',log.status+(log.error_code?' · '+log.error_code:'')],['Key',log.key_prefix?log.key_prefix+'… ('+log.key_id+')':'—'],['User',log.user_id||'—'],['App',log.app||'—'],['Session',log.session_id||'—'],['Controls',[log.styling,log.structure,log.context].filter(Boolean).join(' / ')||'—'],['Characters',(log.input_chars??'—')+' in / '+(log.output_chars??'—')+' out'],['Tokens',(log.input_tokens??'—')+' in / '+(log.output_tokens??'—')+' out'],['Latency',log.latency_ms!=null?log.latency_ms+' ms':'—'],['Model',log.model_revision||'—'],['Agent',log.user_agent||'—']];
    let h='<dl>'+rows.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join('')+'</dl>';
    if(log.redacted){h+='<h3>Transcript</h3><div class="redacted">Hidden. Your account cannot view transcripts. A super-admin can grant this on the Allowlist page.</div>'}
    else{h+='<h3>Transcript</h3><div class="transcript">'+(log.transcript==null?'<span class="muted">Not stored for this request.</span>':esc(log.transcript))+'</div><h3>Output</h3><div class="transcript">'+(log.output==null?'<span class="muted">No output.</span>':(log.output===''?'<span class="muted">Empty string (filler-only input).</span>':esc(log.output)))+'</div><p class="muted">This view was recorded in the audit log.</p>'}
    panel.querySelector('.panel-body').innerHTML=h;
  }catch(err){panel.querySelector('.panel-body').innerHTML='<p class="muted">'+err.message+'</p>'}
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('.panel')?.classList.remove('open')});
})();
`;

export interface ShellProps {
  title: string;
  active: string;
  csrf: string;
  admin: { email: string; role: string; can_view_transcripts: boolean };
  banner?: string;
}

const NAV: [string, string, string][] = [
  ["dashboard", "/admin", "Dashboard"],
  ["keys", "/admin/keys", "API keys"],
  ["logs", "/admin/logs", "Logs"],
  ["quotas", "/admin/quotas", "Quotas"],
  ["allowlist", "/admin/allowlist", "Allowlist"],
  ["settings", "/admin/settings", "Settings"],
];

export const Document: FC<PropsWithChildren<{ title: string; csrf: string }>> = ({ title, csrf, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="csrf-token" content={csrf} />
      <meta name="robots" content="noindex" />
      <link rel="icon" href="/favicon.ico" sizes="48x48" />
      <link rel="icon" href="/icon-32.png" type="image/png" sizes="32x32" />
      <link rel="apple-touch-icon" href="/icon-180.png" />
      <title>{title} · Normalize</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      {children}
      <script dangerouslySetInnerHTML={{ __html: JS }} />
    </body>
  </html>
);

export const Shell: FC<PropsWithChildren<ShellProps>> = ({ title, active, csrf, admin, banner, children }) => (
  <Document title={title} csrf={csrf}>
    <div class="shell">
      <aside class="rail">
        <div class="brand">
          <img class="mark" src="/icon-180.png" alt="" width="26" height="26" />
          <span>
            Normalize<small>admin console</small>
          </span>
        </div>
        <nav class="nav" aria-label="Sections">
          {NAV.filter(([id]) => id !== "allowlist" || admin.role === "super_admin").map(([id, href, label]) => (
            <a href={href} aria-current={active === id ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div class="who">
          <b>{admin.email}</b>
          {admin.role === "super_admin" ? "Super-admin" : "Admin"}
          {admin.can_view_transcripts ? " · can view transcripts" : ""}
          <div style="margin-top:.5rem">
            <button class="link" type="button" data-action="logout">
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main class="main">
        {banner ? <div class="banner">{banner}</div> : null}
        {children}
        <p class="footer">Transcripts are private to this workspace. They are never used to train the model.</p>
      </main>
    </div>
  </Document>
);
