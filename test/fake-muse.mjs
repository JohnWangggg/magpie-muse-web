// A loopback stand-in for muse.ai: the DOM shapes and /api/session behaviour the engine relies on.
// Cookie hatch_sess decides who is signed in: "good…" works, anything else is signed out.
import http from "node:http"

const ESSENTIAL = ["hatch_sess", "hatch_gw", "hatch_vml", "hatch_native_auth_device"]

const CHAT = `<!doctype html><html><head><meta charset="utf-8"><title>muse</title>
<style>main{height:400px;overflow-y:auto}</style></head>
<body><nav style="position:fixed;left:0;top:0;bottom:0;width:56px"><button aria-label="Search">s</button>
<button id="menu" aria-label="Settings" style="position:absolute;bottom:8px;left:8px">≡</button></nav>
<div data-hatch-shell-hydration-state="server" style="margin-left:120px"><main id="m"></main>
<textarea></textarea><span id="c"></span><span id="conn">正在连接…</span></div><div id="pop"></div>
<script>
// Like muse.ai in zh_CN: the page says it is connecting to the VM until it is.
setTimeout(()=>document.getElementById('conn').remove(),900);
// Settings as muse.ai has it: the rail's bottom button opens a menu, its last item a dialog
// whose Usage section draws each meter as a labelled progressbar.
const pop=document.getElementById('pop');
// Like muse.ai: the rail is in the server's HTML, its menu answers only after hydration.
setTimeout(()=>{document.querySelector('[data-hatch-shell-hydration-state]').setAttribute('data-hatch-shell-hydration-state','hydrated');hydrate()},700);
function hydrate(){
const onEnter=(el,fn)=>{el.addEventListener('click',fn);el.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();fn()}})};
onEnter(document.getElementById('menu'),()=>{
  if(pop.querySelector('[role=menu]'))return;
  pop.innerHTML='<div role="menu"><div role="menuitem" tabindex="-1">键盘快捷键<span>⌘/</span></div><div role="menuitem" tabindex="-1" id="set">设置<span>⌘,</span></div></div>';
  onEnter(document.getElementById('set'),async()=>{
    const u=await fetch('/api/fake-usage').then((r)=>r.json());
    const meter=(name,note,detail,used)=>'<div><div><div><span data-slot="text">'+name+'</span><span data-slot="text">'+note+'</span></div><span data-slot="text">'+detail+'</span></div><div role="progressbar" aria-label="'+name+'" aria-valuenow="'+used+'" aria-valuemin="0" aria-valuemax="100"><div style="width:'+used+'%"></div></div></div>';
    pop.innerHTML='<div role="dialog"><h2>使用情况</h2>'+meter('免费版','每周限额将在 '+u.reset+'重置','已使用 '+u.weekly+'%',u.weekly)+meter('额外的使用额度','从不过期','已使用 '+u.extra+'%（剩余 10&nbsp;亿个词元）',u.extra)+'</div>';
  });
});
}
const m=document.getElementById('m'), ta=document.querySelector('textarea'), c=document.getElementById('c');
let n=0;
// Threads as muse.ai's Next.js app has them: the first message of /thread/new gives the thread
// its own path, and the router moves between threads without loading the page again.
const threads={};
let cur=null;
window.next={router:{push(p){
  if(cur)threads[cur]=[...m.children];
  m.replaceChildren();
  const id=(p.match(/^\\/thread\\/(?!new$)([^/]+)$/)||[])[1];
  cur=id&&threads[id]?id:null;
  history.pushState({},'',p);
  setTimeout(()=>{if(cur&&location.pathname===p)m.replaceChildren(...threads[cur])},150);
}}};
function button(){c.innerHTML='<button aria-label="Send">Send</button>';c.firstChild.onclick=go}
button();
function bubble(cls,text){const d=document.createElement('div');d.className='hatch-chat-groupable-bubble '+cls;d.style.whiteSpace='pre-wrap';d.textContent=text;m.appendChild(d);return d}
async function go(){
  const t=ta.value; if(!t) return; ta.value=''; n++;
  if(!cur){cur='t'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);history.replaceState({},'','/thread/'+cur)}
  await fetch('/record',{method:'POST',body:t});
  bubble('hatch-user-bubble-bg',t);
  if(/QUOTA:/.test(t)){const d=document.createElement('div');d.textContent='已用完使用额度';m.appendChild(d);button();return}
  c.innerHTML='<button data-testid="hatch-composer-stop-button" aria-label="Stop">■</button>';
  const reply=/BARETOOL:/.test(t)?'{"name": "shell", "arguments": {"command": "pwd && ls -la"}}':/TOOLCALL:/.test(t)?'好的，我来看一下。\\n<tool_call>{"name": "shell", "arguments": {"command": "ls -la"}}</tool_call>':(t.match(/REPLY:(\\S+)/)||[])[1]||('第'+n+'轮 收到 '+t.length+' 字');
  const delay=Number((t.match(/DELAY:(\\d+)/)||[])[1]||300);
  const a=bubble('hatch-agent-bubble-bg','');
  // muse.ai's bubble: the reply in .prose, suggested follow-ups as buttons beside it, there while it streams
  if(/SUGGEST:/.test(t)){a.innerHTML='<div class="prose"></div><div class="mt-3"><button>运行一下测试看看</button></div>';const p=a.firstChild;const s='这个项目用的是 Vitest。';for(let i=0;i<s.length;i+=2){p.textContent=s.slice(0,i+2);await new Promise(r=>setTimeout(r,60))}button();return}
  // a list marker the page restyles away once the item text comes, as muse.ai's renderer does
  if(/RESTYLE:/.test(t)){await new Promise(r=>setTimeout(r,delay));a.textContent='清单：\\n-';await new Promise(r=>setTimeout(r,400));a.textContent='清单：\\n苹果\\n香蕉';button();return}
  await new Promise(r=>setTimeout(r,delay));
  for(let i=0;i<reply.length;i+=3){a.textContent=reply.slice(0,i+3);await new Promise(r=>setTimeout(r,40))}
  button();
}
</script></body></html>`

const SIGNED_OUT = `<!doctype html><html><body><h1>Log in to Muse</h1><button>Log in</button></body></html>`

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, v.join("=")]),
  )
}

export async function startFakeMuse({ loginDelayMs = 600 } = {}) {
  const state = { prompts: [], sessionCalls: 0, wakeCalls: 0, pageLoads: 0, usage: { weekly: 12, extra: 0, reset: "10月15日" }, usageReads: 0 }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x")
    const c = cookies(req)
    const signedIn = /^good/.test(c.hatch_sess || "")
    if (url.pathname === "/record") {
      let body = ""
      for await (const chunk of req) body += chunk
      state.prompts.push(body)
      return res.end("ok")
    }
    if (url.pathname === "/api/session") {
      state.sessionCalls++
      if (!signedIn) return res.writeHead(401).end("{}")
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [`hatch_vml=renewed${state.sessionCalls}; Path=/; Max-Age=86400; HttpOnly`],
      })
      // one VM per account, as on muse.ai; the session cookie stands for the account here
      return res.end(JSON.stringify({ status: "assigned", vm_id: `vm-${c.hatch_sess}`, vm_state: "RUNNING" }))
    }
    if (url.pathname === "/api/fake-usage") {
      state.usageReads++
      return res.end(JSON.stringify(state.usage))
    }
    if (url.pathname === "/api/hatch/vm/wake") {
      state.wakeCalls++
      return res.end("{}")
    }
    if (url.pathname.startsWith("/thread/")) {
      state.pageLoads++
      // Like muse.ai: the gateway and VM cookies arrive only once the chat page loads.
      const headers = { "content-type": "text/html; charset=utf-8" }
      if (signedIn) headers["set-cookie"] = ["hatch_gw", "hatch_vml"].map((n) => `${n}=good-${n}; Path=/; Max-Age=86400; HttpOnly`)
      res.writeHead(200, headers)
      return res.end(signedIn ? CHAT : SIGNED_OUT)
    }
    if (url.pathname === "/") {
      // The "login": the page sets the session cookies a moment after it opens, httpOnly like the real site.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(`<!doctype html><html><body>signing in<script>setTimeout(()=>fetch('/do-login'),${loginDelayMs})</script></body></html>`)
    }
    if (url.pathname === "/do-login") {
      // Signing in sets only these two; the user is left on the home page.
      res.writeHead(200, { "set-cookie": ["hatch_sess", "hatch_native_auth_device"].map((n) => `${n}=good-${n}; Path=/; Max-Age=86400; HttpOnly`) })
      return res.end("ok")
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const site = `http://127.0.0.1:${server.address().port}`
  return { site, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}

export const goodCookies = () => Object.fromEntries(ESSENTIAL.map((n) => [n, `good-${n}`]))
