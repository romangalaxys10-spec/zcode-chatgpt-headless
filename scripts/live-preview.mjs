#!/usr/bin/env node
/**
 * Live preview + local OpenAI-compatible API for chatgpt-headless.
 *
 *   Page:       http://localhost:8788        (live traffic, search, ask box)
 *   IDE / API:  http://localhost:8788/v1     (OpenAI-compatible, no key)
 *     GET  /v1/models
 *     POST /v1/chat/completions   (stream & non-stream)
 *
 * Env: CHATGPT_HL_PREVIEW_PORT (default 8788). Binds 127.0.0.1 only.
 * The server only ever calls OpenAI's fixed https://chatgpt.com backend —
 * it never fetches user-supplied URLs.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  transcriptFilePath,
  chatgptAsk,
  loadAuth,
  streamChat,
  resolveModel,
  listModels,
  authStatus,
  logActivity,
  logTranscript,
  MODEL_ALIASES,
  DEFAULT_INSTRUCTIONS,
} from "../mcp/lib.mjs";

const PORT = parseInt(process.env.CHATGPT_HL_PREVIEW_PORT || "8788", 10);
const FILE = transcriptFilePath();

// Optional shared-machine protection: set CHATGPT_HL_API_KEY (env only) and
// /v1 endpoints then require "Authorization: Bearer <key>". Never hardcoded.
const API_KEY = process.env.CHATGPT_HL_API_KEY || "";
const apiKeyOk = (req) =>
  !API_KEY ||
  (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() === API_KEY;

function readEntries() {
  try {
    return fs
      .readFileSync(FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  raw = raw.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid JSON body");
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible /v1 handlers
// ---------------------------------------------------------------------------
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .join("\n");
  }
  return String(content ?? "");
}

async function handleModels(req, res) {
  try {
    const models = await listModels();
    const data = [
      ...Object.entries(MODEL_ALIASES).map(([alias, slug]) => ({
        id: alias,
        object: "model",
        owned_by: "chatgpt-headless",
        root: slug,
      })),
      ...models.map((m) => ({
        id: m.slug,
        object: "model",
        owned_by: "chatgpt-headless",
      })),
    ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message } }));
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "messages[] required" } }));
    return;
  }
  const model = resolveModel(body.model) || "gpt-5.6-terra";
  const stream = body.stream === true;
  const timeoutMs = 180000;

  let instructions = DEFAULT_INSTRUCTIONS;
  const convo = [];
  for (const m of messages) {
    const text = contentToText(m.content);
    if (m.role === "system" || m.role === "developer") {
      instructions = text || instructions;
    } else {
      convo.push({ role: m.role === "assistant" ? "assistant" : "user", text });
    }
  }
  const prompt =
    convo.length === 1 && convo[0].role === "user"
      ? convo[0].text
      : convo.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n") +
        "\n\nAssistant:";

  const id = `chatcmpl-hl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  const fail = (status, message) => {
    if (res.headersSent) {
      res.end(`data: {"error":{"message":${JSON.stringify(message)}}}\n\n data: [DONE]\n\n`);
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  };

  let result;
  try {
    let auth = await loadAuth();
    const run = (accessToken, accountId, onDelta) =>
      streamChat({ prompt, model, instructions, timeoutMs, accessToken, accountId, onDelta });
    try {
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunkOf = (delta, finish) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        let sent = false;
        const send = (payload) => {
          res.write(payload);
          sent = true;
        };
        try {
          result = await run(auth.accessToken, auth.accountId, (d) => {
            send(chunkOf({ content: d }, null));
          });
          if (!sent) send(chunkOf({ content: result.text }, null));
          send(chunkOf({}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (e) {
          if ((e.statusCode === 401 || e.statusCode === 403) && !sent) {
            // headers already sent — cannot retry cleanly on the same response
            throw e;
          }
          throw e;
        }
      } else {
        try {
          result = await run(auth.accessToken, auth.accountId);
        } catch (e) {
          if (e.statusCode === 401 || e.statusCode === 403) {
            auth = await loadAuth({ forceRefresh: true });
            result = await run(auth.accessToken, auth.accountId);
          } else {
            throw e;
          }
        }
        const text = result.text || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: result.model || model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: Math.ceil(prompt.length / 4),
              completion_tokens: Math.ceil(text.length / 4),
              total_tokens: Math.ceil((prompt.length + text.length) / 4),
            },
          })
        );
      }
    } catch (e) {
      logActivity({ kind: "ask", model, ok: false, error: e.message.slice(0, 120), source: "api" });
      logTranscript({ kind: "ask", model, prompt, reply: `Error: ${e.message}`, ok: false, ms: Date.now() - t0, source: "api" });
      fail(res.headersSent ? 200 : 500, e.message);
      return;
    }
    logActivity({ kind: "ask", model: result.model || model, ok: true, source: "api" });
    logTranscript({
      kind: "ask",
      model: result.model || model,
      prompt,
      reply: result.text,
      ok: true,
      ms: Date.now() - t0,
      source: "api",
    });
  } catch (e) {
    fail(500, e.message);
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>chatgpt-headless · live preview</title>
<style>
  :root{color-scheme:dark}
  body{font-family:-apple-system,system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px;max-width:900px;margin:0 auto}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#8b949e;font-size:12px;margin-bottom:16px}
  .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;display:inline-block;animation:blink 2s infinite}
  @keyframes blink{50%{opacity:.3}}
  .bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
  .bar input[type=search]{flex:1;min-width:220px;background:#161b22;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:7px 12px;font-size:13px;outline:none}
  .bar input[type=search]:focus{border-color:#1f6feb}
  .chip{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:99px;padding:4px 14px;font-size:12px;cursor:pointer;user-select:none}
  .chip.on{background:#1f6feb33;color:#58a6ff;border-color:#1f6feb66}
  .askbox{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px;margin-bottom:14px}
  .askbox textarea{width:100%;box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:8px 10px;font-size:13px;min-height:52px;resize:vertical;outline:none;font-family:inherit}
  .askbox textarea:focus{border-color:#1f6feb}
  .askrow{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap}
  .askrow select{background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;padding:6px 8px;font-size:12px;max-width:260px}
  .askrow button{background:#238636;border:1px solid #2ea043;color:#fff;border-radius:8px;padding:6px 16px;font-size:13px;font-weight:600;cursor:pointer}
  .askrow button:disabled{opacity:.5;cursor:wait}
  .askrow .status{color:#8b949e;font-size:12px}
  .apibox{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px;margin-bottom:20px;font-size:13px}
  .apibox summary{cursor:pointer;color:#7ee787;font-size:13px;user-select:none;font-weight:600}
  .apibox code{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:2px 8px;font-size:12px}
  .apibox pre{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:11.5px;overflow:auto;color:#8b949e}
  .tab{margin-top:8px}
  .copy{background:#21262d;border:1px solid #30363d;color:#58a6ff;border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer;margin-left:6px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 16px;margin-bottom:14px;animation:pop .35s ease}
  @keyframes pop{from{transform:scale(.98);opacity:0}to{transform:scale(1);opacity:1}}
  .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:#8b949e;margin-bottom:8px}
  .badge{background:#1f6feb33;color:#58a6ff;border:1px solid #1f6feb66;border-radius:99px;padding:1px 10px;font-weight:600}
  .badge.panel{background:#8957e533;color:#bc8cff;border-color:#8957e566}
  .web{background:#23863633;color:#7ee787;border:1px solid #23863666;border-radius:99px;padding:1px 10px}
  .api{background:#f0883e33;color:#ffa657;border:1px solid #f0883e66;border-radius:99px;padding:1px 10px}
  .err{color:#f85149}
  .pill{background:#21262d;border-radius:99px;padding:1px 10px}
  details summary{cursor:pointer;color:#58a6ff;font-size:12px;user-select:none}
  .prompt{white-space:pre-wrap;font-size:12px;color:#8b949e;margin:6px 0;border-left:2px solid #30363d;padding-left:10px;max-height:160px;overflow:auto}
  .reply{white-space:pre-wrap;font-size:14px;line-height:1.55}
  .reply mark{background:#bb800933;color:#e3b341;border-radius:3px}
  .empty{color:#8b949e;text-align:center;padding:60px 0;font-size:14px}
</style></head><body>
<h1>🪄 chatgpt-headless — live GPT traffic</h1>
<div class="sub"><span class="dot"></span> streaming · auto-updates every ~1s · local-only, secrets redacted</div>

<details class="apibox" id="apibox" open>
  <summary>🔌 IDE / API access — OpenAI-compatible local endpoint</summary>
  <div style="margin-top:10px;line-height:2">
    Base URL: <code>http://localhost:8788/v1</code><button class="copy" onclick="cp('http://localhost:8788/v1',this)">copy</button>
    <span id="keyNote" style="color:#8b949e;font-size:12px"></span><br>
    Setup instructions per tool:
    <span class="chip on" data-t="codex" onclick="setTab('codex')">Codex CLI</span>
    <span class="chip" data-t="claude" onclick="setTab('claude')">Claude Code</span>
    <span class="chip" data-t="compat" onclick="setTab('compat')">OpenAI-compatible</span>
  </div>
  <div id="tab-codex" class="tab">
    <div style="font-size:12px;color:#8b949e;margin:6px 0 4px">OpenAI Codex CLI — add to <code>~/.codex/config.toml</code>, then run <code>codex -m gpt-5.6-terra</code>:</div>
    <pre id="codexCfg"></pre><button class="copy" onclick="cp(document.getElementById('codexCfg').textContent,this)">copy config</button>
  </div>
  <div id="tab-claude" class="tab" style="display:none">
    <div style="font-size:12px;color:#8b949e;margin:6px 0 4px">Claude Code — point it at this server (Anthropic Messages API supported). Any API key value works:</div>
    <pre id="claudeCfg"></pre><button class="copy" onclick="cp(document.getElementById('claudeCfg').textContent,this)">copy command</button>
  </div>
  <div id="tab-compat" class="tab" style="display:none">
    <div style="font-size:12px;color:#8b949e;margin:6px 0 4px">Any OpenAI-compatible tool (Cursor, Continue, Zed, OpenAI SDK, LangChain…). Streams supported:</div>
    <pre id="curlEx"></pre><button class="copy" onclick="cp(document.getElementById('curlEx').textContent,this)">copy curl</button>
  </div>
  <div style="margin-top:12px">
    <div style="font-size:12px;color:#8b949e;margin-bottom:6px">Model IDs you can use (aliases + live slugs from your account):</div>
    <div id="modelList" style="display:flex;flex-wrap:wrap;gap:6px"><span class="pill" style="color:#8b949e">loading…</span></div>
  </div>
  <div style="margin-top:14px">
    <div style="font-size:12px;color:#8b949e;margin-bottom:6px">🔐 Token auth status:</div>
    <div id="authBox" class="pill" style="color:#8b949e">checking…</div>
    <button class="copy" id="copyTok" style="margin-top:8px;padding:5px 14px;font-size:12px" onclick="copyTok(this)">📋 Copy auth token</button>
    <span id="tokStatus" style="color:#8b949e;font-size:12px;margin-left:8px"></span>
    <div id="syncLine" style="margin-top:8px;font-size:12px;color:#8b949e">☁️ brain-sync: checking…</div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
      <span id="syncStrip" title="sync results, last 24h (oldest → newest)"></span>
      <button class="copy" id="syncNow" onclick="syncNow(this)">⟳ Sync now</button>
      <button class="copy" id="notifBtn" onclick="enableNotif(this)">🔕 Alerts</button>
      <span id="syncNowStatus" style="font-size:12px;color:#8b949e"></span>
    </div>
  </div>
</details>

<div class="askbox">
  <textarea id="q" placeholder="Ask GPT anything… (Enter to send, Shift+Enter for newline)"></textarea>
  <div class="askrow">
    <select id="m"><option value="balanced">⚖️ balanced</option></select>
    <button id="send" onclick="send()">Send to GPT</button>
    <span class="status" id="status"></span>
  </div>
</div>

<div class="bar">
  <input type="search" id="search" placeholder="🔍 search prompts & replies…" oninput="setState({q:this.value})">
  <span class="chip on" data-k="all" onclick="setState({kind:'all'})">all</span>
  <span class="chip" data-k="ask" onclick="setState({kind:'ask'})">ask</span>
  <span class="chip" data-k="panel" onclick="setState({kind:'panel'})">panel</span>
  <span class="chip" data-k="web" onclick="setState({kind:'web'})">🌐 web</span>
  <span class="chip" data-k="api" onclick="setState({kind:'api'})">🔌 API</span>
</div>

<div id="feed"><div class="empty">waiting for GPT calls…</div></div>

<script>
const S={q:'',kind:'all'};
let lastCount=-1;
function setState(p){Object.assign(S,p);
  document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on',c.dataset.k===S.kind));
  render();}
async function tick(){
  try{
    const r=await fetch('/api/events');const d=await r.json();
    if(d.count!==lastCount){lastCount=d.count;render(d.events.slice(-200).reverse());}
  }catch(e){}
  setTimeout(tick,1200);
}
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function hi(text){
  if(!S.q)return esc(text);
  const t=esc(text);const i=t.toLowerCase().indexOf(S.q.toLowerCase());
  if(i<0)return t;
  return t.slice(0,i)+'<mark>'+t.slice(i,i+S.q.length)+'</mark>'+t.slice(i+S.q.length);
}
function match(e){
  if(S.kind==='web'&&e.source!=='web')return false;
  if(S.kind==='api'&&e.source!=='api')return false;
  if((S.kind==='ask'||S.kind==='panel')&&e.kind!==S.kind)return false;
  if(!S.q)return true;
  const q=S.q.toLowerCase();
  return (e.prompt||'').toLowerCase().includes(q)||(e.reply||'').toLowerCase().includes(q)||(e.model||'').toLowerCase().includes(q);
}
function render(ev){
  const f=document.getElementById('feed');
  if(!ev){return}
  const list=ev.filter(match);
  if(!list.length){f.innerHTML='<div class="empty">no matching calls</div>';return}
  f.innerHTML=list.map(e=>\`
    <div class="card">
      <div class="head">
        <span class="badge \${e.kind}">\${esc(e.kind)}</span>
        <span class="badge">\${esc(e.model||'?')}</span>
        \${e.source==='web'?'<span class="web">🌐 from web</span>':''}
        \${e.source==='api'?'<span class="api">🔌 from API</span>':''}
        <span class="pill">\${new Date(e.t).toLocaleTimeString()}</span>
        <span class="pill">\${e.ms!=null?e.ms+' ms':''}</span>
        \${e.ok===false?'<span class="err">✗ failed</span>':''}
      </div>
      <details><summary>show prompt</summary><div class="prompt">\${hi(e.prompt)}</div></details>
      <div class="reply">\${hi(e.reply)}</div>
    </div>\`).join('');
}
async function send(){
  const q=document.getElementById('q').value.trim();
  if(!q)return;
  const btn=document.getElementById('send'),st=document.getElementById('status');
  btn.disabled=true;st.textContent='asking GPT…';
  try{
    const r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt:q,model:document.getElementById('m').value})});
    const d=await r.json();
    st.textContent=d.ok?'✓ answered below':'✗ '+String(d.error||'failed');
    if(d.ok)document.getElementById('q').value='';
  }catch(e){st.textContent='✗ '+e.message;}
  btn.disabled=false;setTimeout(()=>st.textContent='',4000);
}
document.getElementById('q').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
});
function cp(text,btn){navigator.clipboard.writeText(text.trim());btn.textContent='copied ✓';setTimeout(()=>btn.textContent='copy',1500);}
async function copyTok(btn){
  const st=document.getElementById('tokStatus');
  btn.disabled=true;st.textContent='fetching fresh token…';
  try{
    const r=await fetch('/api/auth');const a=await r.json();
    if(!a.access_token){st.textContent='✗ '+(a.error||'no token — run codex login');return}
    await navigator.clipboard.writeText(a.access_token);
    const exp=a.access_token_expires&&a.access_token_expires!=='unknown'?new Date(a.access_token_expires).toLocaleString():'?';
    st.textContent='✓ copied (valid until '+exp+')';btn.textContent='📋 Copied ✓';
    setTimeout(()=>{btn.textContent='📋 Copy auth token';st.textContent=''},4000);
  }catch(e){st.textContent='✗ '+e.message;}
  btn.disabled=false;
}
function setTab(t){
  document.querySelectorAll('[data-t]').forEach(c=>c.classList.toggle('on',c.dataset.t===t));
  for(const k of ['codex','claude','compat'])document.getElementById('tab-'+k).style.display=k===t?'':'none';
}
async function syncLine(){
  try{
    const r=await fetch('/api/sync');const d=await r.json();
    const el=document.getElementById('syncLine');
    if(d.last_sync){
      const mins=Math.round((Date.now()-new Date(d.last_sync))/60000);
      el.innerHTML=(d.busy?'☁️ brain-sync: <span style="color:#e3b341">syncing…</span>':'☁️ brain-sync: last '+esc(new Date(d.last_sync).toLocaleTimeString())+
        ' ('+(mins<1?'just now':mins+' min ago')+')')+(mins>1500&&!d.busy?' <span style="color:#f85149">— stale, check nightly job</span>':!d.busy?' ✅':'');
    }else el.innerHTML='☁️ brain-sync: <span style="color:#e3b341">never run yet</span>';
    // history strip: one dot per event in the last 24h, oldest → newest
    const strip=document.getElementById('syncStrip');
    strip.innerHTML=(d.history||[]).map(e=>{
      const c=e.status==='ok'?'#3fb950':e.status==='partial'?'#e3b341':e.status==='error'?'#f85149':'#8b949e';
      return '<span title="'+esc((e.t||'')+' '+e.status+' '+(e.detail||''))+'" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:'+c+';margin-right:2px"></span>';
    }).join('');
    maybeNotify(d.history||[]);
  }catch(e){}
}
// Desktop alert when a backup fails (red/yellow dot) so it never sits unnoticed.
let lastNotified='';
function maybeNotify(history){
  if(typeof Notification==='undefined'||Notification.permission!=='granted')return;
  const bad=history.filter(e=>e.status==='error'||e.status==='partial');
  if(!bad.length)return;
  const latest=bad[bad.length-1];
  if(latest.t===lastNotified)return;
  lastNotified=latest.t;
  try{
    new Notification('⚠️ brain-sync '+latest.status,{body:(latest.detail||'check the viewer')+' — '+new Date(latest.t).toLocaleTimeString()});
  }catch(e){}
}
function enableNotif(btn){
  if(typeof Notification==='undefined'){btn.textContent='✗ n/a';return}
  if(Notification.permission==='granted'){btn.textContent='🔔 Alerts on';maybeNotify([]);return}
  Notification.requestPermission().then(p=>{
    btn.textContent=p==='granted'?'🔔 Alerts on':'🔕 blocked';
    if(p==='denied')btn.title='Allow notifications for this site in browser settings';
  });
}
async function syncNow(btn){
  btn.disabled=true;const st=document.getElementById('syncNowStatus');
  st.textContent='triggering…';
  try{
    // Wait until THIS trigger produces a real result entry (not skipped-busy),
    // then flash + report. Falls back to re-enable after 90s.
    const triggerT=Date.now();
    await fetch('/api/sync-now',{method:'POST'});
    st.textContent='running… (lock prevents overlap)';
    let sawResult=false;
    const poll=setInterval(async()=>{
      try{
        const r=await fetch('/api/sync');const d=await r.json();
        const mine=(d.history||[]).find(e=>Date.parse(e.t)>triggerT&&e.status!=='skipped-busy');
        if(!mine)return;
        sawResult=true;clearInterval(poll);
        await syncLine();
        const strip=document.getElementById('syncStrip');
        strip.style.transition='filter .2s';
        strip.style.filter='brightness(2.5)';
        setTimeout(()=>{strip.style.filter='';},500);
        st.textContent=mine.status==='ok'?'✓ done':'✗ '+mine.status+(mine.detail?' — '+mine.detail:'');
      }catch(e){}
    },1500);
    setTimeout(()=>{clearInterval(poll);if(!sawResult){st.textContent='(no result yet — still running?)';}btn.disabled=false;},90000);
  }catch(e){st.textContent='✗ '+e.message;btn.disabled=false;}
}
setInterval(syncLine,30000);syncLine();
(async()=>{
  try{
    const r=await fetch('/api/models');const d=await r.json();
    const sel=document.getElementById('m');sel.innerHTML='';
    const og1=document.createElement('optgroup');og1.label='quick pick';
    for(const a of d.aliases)og1.append(new Option(a.label,a.value));
    const og2=document.createElement('optgroup');og2.label='models';
    for(const m of d.models)og2.append(new Option(m.name+' — '+m.slug,m.slug));
    sel.append(og1,og2);sel.value='balanced';
    // model ID chips in the API panel
    const ml=document.getElementById('modelList');ml.innerHTML='';
    for(const a of d.aliases){const s=document.createElement('span');s.className='pill';
      s.innerHTML='<b style="color:#58a6ff">'+esc(a.value)+'</b> → '+esc(a.slug||'');s.style.cursor='pointer';s.title='click to copy';
      s.onclick=()=>{navigator.clipboard.writeText(a.value);s.style.color='#7ee787';setTimeout(()=>s.style.color='',900)};
      ml.append(s);}
    for(const m of d.models){const s=document.createElement('span');s.className='pill';s.style.cursor='pointer';s.title='click to copy';
      s.innerHTML='<b>'+esc(m.slug)+'</b> <span style="color:#8b949e">'+esc(m.name)+'</span>';
      s.onclick=()=>{navigator.clipboard.writeText(m.slug);s.style.color='#7ee787';setTimeout(()=>s.style.color='',900)};
      ml.append(s);}
    if(!d.models.length&&!d.aliases.length)ml.innerHTML='<span class="pill" style="color:#f85149">no models — check auth</span>';
  }catch(e){}
  try{
    const r=await fetch('/api/auth');const a=await r.json();
    const box=document.getElementById('authBox');
    if(a.ok){
      const exp=a.access_token_expires==='unknown'||!a.access_token_expires?'unknown':new Date(a.access_token_expires).toLocaleString();
      const expired=a.access_token_expired;
      box.style.color=expired?'#f85149':'#7ee787';
      box.innerHTML='✓ logged in · account '+esc(a.account_id||'?')+'… · token expires '+esc(exp)+(expired?' — <b>EXPIRED</b> (will refresh on next call)':'')+' · auth_mode '+esc(a.auth_mode||'?');
    }else{
      box.style.color='#f85149';box.innerHTML='✗ '+esc(a.error||'not logged in — run codex login');
    }
    const kn=document.getElementById('keyNote');
    kn.textContent=a.api_key_required?'· API key required (CHATGPT_HL_API_KEY is set)':'· no API key needed (localhost only)';
  }catch(e){}
  document.getElementById('curlEx').textContent=
    'curl http://localhost:8788/v1/chat/completions \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d \\'{"model":"fast","messages":[{"role":"user","content":"hello!"}]}\\'';
  document.getElementById('codexCfg').textContent=
    '# ~/.codex/config.toml\\n[model_providers.local]\\nname = "chatgpt-headless local"\\nbase_url = "http://localhost:8788/v1"\\nwire_api = "chat"\\nenv_key = "LOCAL_API_KEY"\\n\\n# then: codex --profile local -m gpt-5.6-terra\\n[profiles.local]\\nmodel_provider = "local"\\nmodel = "gpt-5.6-terra"';
  document.getElementById('claudeCfg').textContent=
    '# run Claude Code against this server (any key value works):\\nexport ANTHROPIC_BASE_URL=http://localhost:8788\\nexport ANTHROPIC_AUTH_TOKEN=local\\nclaude --model gpt-5.6-terra';
})();
tick();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const origEnd = res.end.bind(res);
  res.end = (...a) => {
    try {
      fs.appendFileSync(
        process.env.CHATGPT_HL_REQ_LOG || path.join(os.homedir(), ".chatgpt-headless", "requests.log"),
        `${new Date().toISOString()} ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t0}ms ${req.headers["user-agent"] || ""}\n`
      );
    } catch { /* never break responses */ }
    return origEnd(...a);
  };
  // Normalize: collapse accidental double /v1 prefixes (/v1/v1/...) so base
  // URLs configured with or without a trailing /v1 both work.
  let url = (req.url || "").split("?")[0];
  while (url.startsWith("/v1/v1/")) url = url.slice(3);
  // Bare paths (base URL without /v1) map to the /v1 equivalents.
  if (url === "/chat/completions") url = "/v1/chat/completions";
  if (url === "/models") url = "/v1/models";
  const notFound = () => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `not found: ${url}` } }));
  };
  if (url === "/api/events") {
    const events = readEntries();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: events.length, events }));
    return;
  }
  if (url === "/api/models") {
    try {
      const models = await listModels();
      const aliases = [
        { value: "fast", slug: "gpt-5.6-luna", label: "⚡ fast (luna)" },
        { value: "balanced", slug: "gpt-5.6-terra", label: "⚖️ balanced (terra)" },
        { value: "smart", slug: "gpt-5.5", label: "🧠 smart (5.5)" },
        { value: "mini", slug: "gpt-5.4-mini", label: "🪶 mini (cheapest)" },
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ aliases, models }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url === "/api/ask" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const model = typeof body.model === "string" ? body.model : "balanced";
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "empty prompt" }));
        return;
      }
      const r = await chatgptAsk({
        prompt,
        model,
        source: "web",
        instructions:
          "You are chatting with a human from a local dashboard page. Be helpful, warm, and concise.",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reply: r.text, model: r.model }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (url === "/api/auth") {
    try {
      const s = await authStatus();
      // Include a usable access token (refreshed if near expiry) for the
      // copy-to-clipboard button. Local-only server (127.0.0.1); if an API
      // key is configured, require it here too.
      let access_token = null;
      // Serve the raw token only to this page itself (same-origin browser
      // request) or with a valid API key — not to arbitrary local pages.
      const origin = req.headers.origin || "";
      const sameOrigin =
        req.headers["sec-fetch-site"] === "same-origin" ||
        origin === `http://localhost:${PORT}` ||
        origin === `http://127.0.0.1:${PORT}` ||
        String(req.headers.referer || "").startsWith(`http://localhost:${PORT}`) ||
        String(req.headers.referer || "").startsWith(`http://127.0.0.1:${PORT}`);
      if (apiKeyOk(req) && (sameOrigin || API_KEY)) {
        try {
          access_token = (await loadAuth()).accessToken;
        } catch {
          /* leave null */
        }
      } else if (!apiKeyOk(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid API key" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...s, access_token, api_key_required: Boolean(API_KEY) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (url === "/api/sync") {
    let last = null;
    try {
      last = parseInt(
        fs.readFileSync(path.join(os.homedir(), ".chatgpt-headless", "brain-sync-last-run"), "utf8"),
        10
      );
    } catch { /* never synced */ }
    let busy = false;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".chatgpt-headless", "brain-sync.lock"), "utf8"));
      busy = info && typeof info.t === "number" && Date.now() - info.t < 10 * 60_000;
    } catch { /* no lock */ }
    let history = [];
    try {
      history = fs
        .readFileSync(path.join(os.homedir(), ".chatgpt-headless", "brain-sync-history.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .filter((e) => Date.parse(e.t) > Date.now() - 86400_000);
    } catch { /* no history yet */ }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ last_sync: Number.isFinite(last) ? new Date(last).toISOString() : null, busy, history }));
    return;
  }
  if (url === "/api/sync-now" && req.method === "POST") {
    // Manual trigger from the page. The lock in brain-sync prevents overlap.
    const { spawn } = await import("node:child_process");
    const script = path.join(import.meta.dirname, "..", "scripts", "brain-sync.mjs");
    if (!fs.existsSync(script)) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "brain-sync.mjs not found" }));
      return;
    }
    spawn(process.execPath, [script], { detached: true, stdio: "ignore" }).unref();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url === "/v1/models") {
    if (!apiKeyOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid API key" } }));
      return;
    }
    await handleModels(req, res);
    return;
  }
  if (url === "/v1/chat/completions" && req.method === "POST") {
    if (!apiKeyOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid API key" } }));
      return;
    }
    await handleChatCompletions(req, res);
    return;
  }
  // OpenAI Responses API (some clients call this instead of chat/completions)
  if (url === "/v1/responses" && req.method === "POST") {
    if (!apiKeyOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid API key" } }));
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message } }));
      return;
    }
    const input = typeof body.input === "string" ? body.input
      : Array.isArray(body.input)
        ? body.input.map((i) => (i.content || "")).join("\n")
        : "";
    const model = resolveModel(body.model) || "gpt-5.6-terra";
    try {
      const r = await chatgptAsk({ prompt: input, model, instructions: body.instructions, source: "api" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "response",
          model: r.model,
          status: "completed",
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: r.text }] },
          ],
        })
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }
  // Anthropic Messages API (Claude Code via ANTHROPIC_BASE_URL)
  if (url === "/v1/messages" && req.method === "POST") {
    if (!apiKeyOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid API key" } }));
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: e.message } }));
      return;
    }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (!msgs.length) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages[] required" } }));
      return;
    }
    const model = resolveModel(body.model) || "gpt-5.6-terra";
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((s) => s.text || "").join("\n") : "";
    const prompt = msgs
      .map((m) => {
        const text = contentToText(m.content);
        return `${m.role === "user" ? "Human" : "Assistant"}: ${text}`;
      })
      .join("\n\n") + "\n\nAssistant:";
    const stream = body.stream === true;
    const id = `msg_hl_${Date.now().toString(36)}`;
    try {
      let auth = await loadAuth();
      let result;
      const run = (accessToken, accountId, onDelta) =>
        streamChat({ prompt, model, instructions: sys || DEFAULT_INSTRUCTIONS, timeoutMs: 180000, accessToken, accountId, onDelta });
      try {
        result = await run(auth.accessToken, auth.accountId);
      } catch (e) {
        if (e.statusCode === 401 || e.statusCode === 403) {
          auth = await loadAuth({ forceRefresh: true });
          result = await run(auth.accessToken, auth.accountId);
        } else throw e;
      }
      const text = result.text || "";
      logActivity({ kind: "ask", model: result.model || model, ok: true, source: "api" });
      logTranscript({ kind: "ask", model: result.model || model, prompt, reply: text, ok: true, ms: 0, source: "api" });
      if (!stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id, type: "message", role: "assistant", model: result.model || model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(text.length / 4) },
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: result.model || model, content: [], usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 0 } } });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(text.length / 4) } });
      ev("message_stop", { type: "message_stop" });
      res.end();
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } }));
    }
    return;
  }
  // Any other /v1/* path must return JSON (never the HTML page) so clients
  // fail loudly instead of parsing HTML as an empty model response.
  if (url.startsWith("/v1/")) {
    notFound();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

// Port-conflict guard: under launchd KeepAlive a taken port would otherwise
// crash-loop silently. Identify the holder via lsof (no network probing) and
// exit quietly if it's just another live-preview instance.
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") {
    process.stderr.write(`live-preview server error: ${e.message}\n`);
    process.exit(1);
  }
  let holder = "";
  try {
    holder = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
  } catch {
    holder = "(lsof could not identify the holder)";
  }
  const friendly = /live-preview\.mjs/.test(holder);
  process.stderr.write(
    `PORT ${PORT} IN USE${friendly ? " — by another live-preview instance, exiting quietly" : " — by a NON-preview process"}\n${holder}\n`
  );
  if (!friendly) {
    try {
      execFileSync("osascript", [
        "-e",
        `display notification "Port ${PORT} is held by another process — see /tmp/hl-preview.err" with title "⚠️ GPT preview port conflict" sound name "Basso"`,
      ]);
    } catch { /* headless */ }
  }
  process.exit(friendly ? 0 : 1);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `chatgpt-headless live preview → http://localhost:${PORT}  ·  OpenAI-compatible API → http://localhost:${PORT}/v1\n`
  );
});
