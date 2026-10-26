#!/usr/bin/env node
// pi-tunnel CLI —— 主人设备侧: 主动连 server + 本机控制 API（C 档 P1：文件/设备枚举/审计）。
// 用法: node cli.mjs [ws://host:8765]   ({{TOKEN}}/{{SERVER}} 由 server /cli 下载时注入)
// 控制 API: 仅监听 127.0.0.1:<随机>，要求 X-Tunnel-Token 头（=当前令牌）；
//           白名单/能力开关由面板下发（config 消息），本地持久化 ~/.pi-tunnel-cli.json。
// 审计: 每次 fs 操作记录，5s 批量上报 server 聚合（面板审计视图）。
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';

const argSrv = process.argv.slice(2).find(a => /^wss?:\/\//.test(a)); // 只认 ws(s):// 形态, 防 zsh 粘贴行内注释垃圾参数
const SERVER = argSrv || '{{SERVER}}';
const TOKEN  = process.env.PI_TUNNEL_TOKEN || '{{TOKEN}}';
const sockMap = new Map();
const ts = () => new Date().toTimeString().slice(0, 8); // 日志时间戳（诊断断线循环时序用）
const CLI_VER = 'p16'; // 能力版本：server 握手下发最新版，本地旧则自更新（拉 /cli 原子替换后重启由 launchd 拉起）
const SELF_PATH = process.argv[1] ? path.resolve(process.argv[1]) : ''; // 自更新定位自身文件
const CFG_FILE = path.join(homedir(), '.pi-tunnel-cli.json');
let piPath = ''; // pi agent 可执行路径（启动时探测；未装则 /task 提示安装）
let taskBusy = false; // 设备端任务串行锁

if (typeof WebSocket === 'undefined') {
  console.error(`需要 Node >= 22 (全局 WebSocket)。当前 ${process.version}`);
  process.exit(1);
}

// ── 自更新：server 下发 ver > 本地 → 拉 /cli 原子替换自身 → 退出由 launchd KeepAlive 拉起新版 ──
function selfUpdate(newVer) {
  if (!SELF_PATH || !fs.existsSync(SELF_PATH)) { console.log('[tunnel] 自更新跳过：无法定位自身文件'); return; }
  // /cli 自 v1.5 起强制 ?token= 校验——不带 token 必 401，响应体没有 CLI_VER，
  // 会落进「内容校验失败」分支：任何 CLI_VER 提升都无法下发，设备锁死旧版
  // （也让未来设备侧安全修复不可达）。必须与 /agent 握手同源带 token。
  const httpUrl = SERVER.replace(/^ws/, 'http') + '/cli?token=' + encodeURIComponent(TOKEN);
  const req = http.get(httpUrl, r => {
    let code = '';
    r.on('data', c => code += c);
    r.on('end', () => {
      try {
        if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`);
        if (!code.includes('CLI_VER') || code.length < 1000) throw new Error('内容校验失败');
        const tmp = SELF_PATH + '.tmp';
        fs.writeFileSync(tmp, code);
        fs.renameSync(tmp, SELF_PATH); // 原子替换
        console.log(`[tunnel] CLI ${CLI_VER} → ${newVer} 更新完成，2s 后退出重启加载新版…`);
        setTimeout(() => process.exit(0), 2000); // launchd KeepAlive 自动拉起
      } catch (e) { console.log('[tunnel] 自动更新失败，继续用当前版:', e.message); }
    });
  });
  req.on('error', e => console.log('[tunnel] 自动更新失败，继续用当前版:', e.message));
  req.setTimeout(15000, () => { req.destroy(); console.log('[tunnel] 自动更新超时，继续用当前版'); });
}

// ── 本地配置（白名单/能力开关）——server config 下发时覆盖并持久化 ──────────────
let cfg = { fsRead: true, fsWrite: false, whitelist: ['~/Downloads'] };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch {}
cfg.whitelist = (cfg.whitelist || []).map(p => p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);
cfg.whitelist = [...new Set(cfg.whitelist)];
const saveCfg = () => { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch {} };

const expandHome = p => p === '~' ? homedir() : (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);
function isRestrictedBrowsePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return true;
  const norm = targetPath.trim().replace(/\\/g, '/');
  const blockedPrefixes = ['/etc', '/proc', '/sys', '/dev', '/var', '/root', '/boot', '/bin', '/sbin', '/usr'];
  if (norm === '/' || blockedPrefixes.some(p => norm === p || norm.startsWith(p + '/'))) {
    return true;
  }
  const resolved = path.resolve(targetPath);
  const home = path.resolve(homedir());
  if (resolved === home || resolved.startsWith(home + path.sep)) return false;
  const plat = process.platform;
  if (plat === 'darwin' && (resolved === '/Volumes' || resolved.startsWith('/Volumes/'))) return false;
  if (plat === 'linux' && /^\/(media|mnt)($|\/)/.test(resolved)) return false;
  if (plat === 'win32') {
    const isDrive = /^[a-zA-Z]:\\?/.test(resolved);
    const winSys = process.env.SystemRoot ? path.resolve(process.env.SystemRoot) : 'C:\\Windows';
    if (resolved.toLowerCase().startsWith(winSys.toLowerCase())) return true;
    if (isDrive) return false;
  }
  if (blockedPrefixes.some(p => resolved === p || resolved.startsWith(p + '/'))) return true;
  if (resolved === '/' || resolved === path.parse(resolved).root) return true;
  return true;
}
const inWhitelist = p => {
  const rp = path.resolve(p);
  return cfg.whitelist.some(w => {
    const rw = path.resolve(w);
    return rp === rw || rp.startsWith(rw + path.sep);
  });
};
const json = (res, code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); } catch {} };

// ── 审计 buffer（5s 批量上报 server）──────────────────────────────────────────
const auditBuf = [];
const audit = (op, detail) => auditBuf.push({ ts: Date.now(), op, detail: String(detail).slice(0, 300) });

// ── 设备枚举（跨 OS，30s 缓存；只读清单）───────────────────────────────────────
let devCache = null, devAt = 0;
function listDevices(cb) {
  if (devCache && Date.now() - devAt < 30000) return cb(null, devCache);
  const plat = os.platform();
  const out = { platform: plat, usb: [], disks: [] };
  const fin = () => { devCache = out; devAt = Date.now(); cb(null, out); };
  const dfDisks = done => execFile('df', ['-kP'], { timeout: 8000, maxBuffer: 1e6 }, (e, so) => {
    if (!e) for (const line of so.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length >= 9) {
        const mnt = c.slice(8).join(' ');
        if (/^\/Volumes\//.test(mnt) || /\/media\/|\/mnt\//.test(mnt)) {
          out.disks.push({ mount: mnt, totalGB: +(c[1] / 1048576).toFixed(1), usedGB: +(c[2] / 1048576).toFixed(1) });
        }
      }
    }
    done();
  });
  if (plat === 'darwin') {
    execFile('system_profiler', ['SPUSBDataType', '-json'], { timeout: 12000, maxBuffer: 8e6 }, (_e, so) => {
      try {
        const j = JSON.parse(so);
        const walk = items => (items ?? []).forEach(it => {
          if (it._name && !/Bus$/i.test(it._name)) out.usb.push({ name: it._name, vendor: it.vendor_id ?? '' });
          if (it._items) walk(it._items);
        });
        for (const k of Object.keys(j)) walk(j[k]?._items);
      } catch {}
      dfDisks(fin);
    });
  } else if (plat === 'linux') {
    execFile('lsusb', { timeout: 8000 }, (e, so) => {
      if (!e) out.usb = so.split('\n').filter(Boolean).map(l => ({ name: l.split(/:\s+/).pop() ?? l }));
      dfDisks(fin);
    });
  } else { // win32: 磁盘走 PowerShell；USB 枚举留 P4
    execFile('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { \"$($_.DeviceID)|$([math]::Round($_.Size/1GB,1))|$([math]::Round($_.FreeSpace/1GB,1))\" }"],
      { timeout: 12000 }, (e, so) => {
        if (!e) for (const l of so.split('\n').filter(Boolean)) {
          const [mount, total, free] = l.split('|');
          out.disks.push({ mount, totalGB: +total, freeGB: +free });
        }
        fin();
      });
  }
}

// ── 控制服务（仅 127.0.0.1；token 头鉴权；白名单硬校验）─────────────────────────
let ctrlPort = 0;
const ctrlSrv = http.createServer((req, res) => {
  if (req.headers['x-tunnel-token'] !== TOKEN) return json(res, 403, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://local');
  try {
    if (u.pathname === '/health') {
      return json(res, 200, { ok: true, name: os.hostname(), os: `${os.platform()} ${os.release()} ${os.arch()}`, fsRead: !!cfg.fsRead, fsWrite: !!cfg.fsWrite, whitelist: cfg.whitelist });
    }
    if (!cfg.fsRead) return json(res, 403, { error: '文件读取能力未开启（面板授权）' });
    if (u.pathname === '/fs/list') {
      const p = path.resolve(expandHome(u.searchParams.get('path') || homedir()));
      if (!inWhitelist(p)) { audit('fs.list.denied', p); return json(res, 403, { error: 'path 不在白名单内' }); }
      const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 2000).map(e => {
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(p, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
        return { name: e.name, dir: e.isDirectory(), size, mtime };
      });
      audit('fs.list', p);
      return json(res, 200, { path: p, entries });
    }
    if (u.pathname === '/fs/read') {
      const p = path.resolve(expandHome(u.searchParams.get('path')));
      if (!inWhitelist(p)) { audit('fs.read.denied', p); return json(res, 403, { error: 'path 不在白名单内' }); }
      const st = fs.statSync(p);
      if (st.isDirectory()) return json(res, 400, { error: '是目录，用 /fs/list' });
      if (st.size > 4 * 1024 * 1024) return json(res, 413, { error: '文件超 4MB（P2 支持大文件）' });
      audit('fs.read', p);
      return json(res, 200, { path: p, size: st.size, b64: fs.readFileSync(p).toString('base64') });
    }
    if (u.pathname === '/fs/write' && req.method === 'POST') {
      if (!cfg.fsWrite) { audit('fs.write.denied', u.searchParams.get('path') || ''); return json(res, 403, { error: '写开关未开启（面板授权）' }); }
      let body = '';
      req.on('data', c => { body += c; if (body.length > 6 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const { path: p, b64 } = JSON.parse(body || '{}');
          const rp = path.resolve(expandHome(p || ''));
          if (!inWhitelist(rp)) { audit('fs.write.denied', rp); return json(res, 403, { error: 'path 不在白名单内' }); }
          fs.writeFileSync(rp, Buffer.from(b64 || '', 'base64'));
          audit('fs.write', rp);
          return json(res, 200, { ok: true, path: rp, size: Buffer.from(b64 || '', 'base64').length });
        } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      });
      return;
    }
    if (u.pathname === '/fs/browse') { // 目录浏览：仅目录名（供面板选白名单路径）；限制在用户目录/外置存储卷并审计覆盖
      if (!cfg.fsRead) { audit('fs.browse.denied', ''); return json(res, 403, { error: '读开关未开启' }); }
      const raw = u.searchParams.get('path') || '~';
      try {
        const p = path.resolve(expandHome(raw));
        if (isRestrictedBrowsePath(p)) {
          audit('fs.browse.denied', raw);
          return json(res, 403, { error: '系统保留或非允许目录禁止浏览' });
        }
        const dirs = fs.readdirSync(p, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name).sort();
        audit('fs.browse', raw);
        return json(res, 200, { path: p, parent: path.dirname(p), home: homedir(), dirs });
      } catch (e) { audit('fs.browse.denied', raw); return json(res, 400, { error: String(e.code || e.message || e) }); }
    }
    if (u.pathname === '/sys/hw') { // 硬件概览：只读系统命令+os 内建（型号/磁盘等，无敏感数据，审计覆盖）
      audit('sys.hw', '');
      const run = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 5000 }, (e, so) => r(e ? '' : String(so).trim())));
      const dfRoot = async () => {
        const df = await run('df', ['-k', '/']);
        const l2 = (df.split('\n')[1] || '').trim().split(/\s+/);
        const total = +l2[1], avail = +l2[3];
        return total ? `已用 ${((total - avail) / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} GB` : '';
      };
      (async () => {
        const plat = process.platform;
        const cpus = os.cpus();
        let model = '', osv = '', disk = '';
        try {
          if (plat === 'darwin') {
            model = await run('sysctl', ['-n', 'hw.model']);
            osv = 'macOS ' + await run('sw_vers', ['-productVersion']);
            disk = await dfRoot();
          } else if (plat === 'linux') {
            model = await run('cat', ['/sys/class/dmi/id/product_name']);
            osv = (await run('cat', ['/etc/os-release']).then(s => (s.match(/PRETTY_NAME="(.*)"/) || [])[1])) || os.release();
            disk = await dfRoot();
          } else {
            model = (await run('wmic', ['csproduct', 'get', 'name']).then(s => (s || '').split('\n').map(l => l.trim()).filter(Boolean)[1])) || '';
            osv = 'Windows ' + os.release();
          }
        } catch {}
        return json(res, 200, {
          model, osv, arch: os.arch(),
          cpu: (cpus[0]?.model || '').trim() || plat,
          cores: cpus.length,
          memGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
          disk, uptimeH: Math.round(os.uptime() / 360) / 10,
          load: os.loadavg().map(n => Math.round(n * 100) / 100),
        });
      })();
      return;
    }
    if (u.pathname === '/task' && req.method === 'POST') { // 通用任务通道：转发给设备上的 pi agent（能力随 pi，不再发版）
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let prompt = '', tools = 'read,grep,glob', env = {}, timeoutS = 300, model = '', mesh = false, msgId = '', from = '';
        try {
          const j = JSON.parse(body || '{}');
          prompt = String(j.prompt ?? '').slice(0, 4000);
          tools = String(j.tools ?? 'read,grep,glob');
          env = j.env && typeof j.env === 'object' ? j.env : {};
          timeoutS = Math.min(Math.max(+j.timeoutS || 300, 30), 900);
          model = String(j.model ?? '');
          mesh = !!j.mesh; // P3a: mesh 桥投递——持久会话（--resume）+ 完成后 WS 上行 msg-res
          msgId = String(j.msgId ?? '');
          from = String(j.from ?? '');
        } catch {}
        if (!prompt.trim()) return json(res, 400, { error: 'prompt 为空' });
        if (!/^[a-z_,*+.-]+$/i.test(tools)) return json(res, 400, { error: 'tools 非法' });
        const requestedTools = tools.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const writeTools = ['bash', 'edit', 'write', 'patch'];
        const readTools = ['read', 'grep', 'glob', 'find'];
        if (!cfg.fsWrite && requestedTools.some(t => writeTools.includes(t))) {
          return json(res, 403, { error: '设备未开启写入/命令执行能力（fsWrite=false）' });
        }
        if (!cfg.fsRead && requestedTools.some(t => readTools.includes(t))) {
          return json(res, 403, { error: '设备未开启读取能力（fsRead=false）' });
        }
        if (!piPath) piPath = detectPiSync(); // 懒重试：安装发生在启动后（如常驻命令装 pi）也能被 /task 发现
        if (!piPath) return json(res, 400, { error: '设备未安装 pi agent（更新常驻命令以安装）' });
        if (taskBusy) return json(res, 429, { error: '已有任务在执行（设备端串行）' });
        const allowEnv = {};
        for (const k of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
          if (typeof env[k] === 'string' && env[k]) allowEnv[k] = env[k];
        }
        console.log(`[task] 收到 prompt=${!!prompt} tools=${tools} model=${model || '-'} envKeys=${Object.keys(env).join(',') || '-'} allow=${Object.keys(allowEnv).join(',') || '-'}`);
        audit('task.run', `${tools} | ${prompt.slice(0, 60)}`);
        // pi 不认 OPENAI_BASE_URL env：模型配置走专用目录 models.json（PI_CODING_AGENT_DIR 指过去，不碰设备用户配置）
        const agentDir = path.join(homedir(), '.pi-tunnel-agent');
        const spawnEnv = { ...process.env, ...allowEnv };
        spawnEnv.PATH = path.dirname(process.execPath) + path.delimiter + (spawnEnv.PATH || ''); // shim shebang env node 在 launchd 精简 PATH 下找不到，前插 node 目录
        if (model && allowEnv.OPENAI_BASE_URL && allowEnv.OPENAI_API_KEY) {
          try {
            fs.mkdirSync(agentDir, { recursive: true });
            const mj = { providers: { tunnel: { baseUrl: allowEnv.OPENAI_BASE_URL, api: 'openai-completions', apiKey: allowEnv.OPENAI_API_KEY, models: [{ id: model }] } } };
            fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(mj, null, 2), { mode: 0o600 });
            spawnEnv.PI_CODING_AGENT_DIR = agentDir;
            try { const gh = new URL(allowEnv.OPENAI_BASE_URL).hostname; const np = [process.env.NO_PROXY, process.env.no_proxy, gh].filter(Boolean).join(','); spawnEnv.NO_PROXY = np; spawnEnv.no_proxy = np; } catch {}
            // 设备 pi 只需连内网网关：清掉继承的公司代理（pi 的 HTTP 客户端不完整尊重 NO_PROXY，走代理必挂，20261019 实战）
            delete spawnEnv.HTTP_PROXY; delete spawnEnv.HTTPS_PROXY; delete spawnEnv.http_proxy; delete spawnEnv.https_proxy;
            spawnEnv.PI_SKIP_VERSION_CHECK = '1'; // 禁启动联网版本检查（无代理环境下直连公网会被拦死在启动阶段）
            console.log('[task] models.json 已写入', agentDir, '| NO_PROXY=', spawnEnv.NO_PROXY, '| HTTP_PROXY 已清除');
          } catch (e) { console.log('[task] models.json 写失败:', e.message); }
        }
        taskBusy = true;
        // P3a mesh 模式：持久会话——sessionId 存 ~/.pi-tunnel-agent/session.json，有则 --resume 续聊
        let meshSessionId = '';
        const sessionFile = path.join(homedir(), '.pi-tunnel-agent', 'session.json');
        if (mesh) {
          try { meshSessionId = String(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessionId || ''); } catch {}
        }
        const args = ['-ne', '-p', prompt, '--mode', 'json', '--tools', tools]; // -ne: 设备执行器裸奵（TUI 扩展集不适用且可能缺依赖致命）
        if (!mesh) args.push('--no-session'); // mesh 要持久记忆，非 mesh 保持无会话裸执行
        if (mesh && meshSessionId) {
          // p12 实锤（pi dist/cli/args.js + main.js）：--resume 无论带不带 -n/-ne 都必走 TUI 会话选择器；
          // --session <uuid> 走 exact-id 本地匹配直接 open（cwd 恒为 home → local 必中，零交互）
          args.push('--session', meshSessionId);
        }
        if (model && spawnEnv.PI_CODING_AGENT_DIR) args.push('--model', 'tunnel/' + model);
        const isJs = piPath.endsWith('.js'); // cli.js 形态用当前 node 直跑（不依赖设备 PATH/shim）
        const cmd = isJs ? process.execPath : piPath;
        const runArgs = isJs ? [piPath, ...args] : args;
        const t0 = Date.now();
        // execFile 会丢弃 stdio 选项（internal exec 不透传）→ stdin 强制 pipe 永不 EOF → pi 等 stdin 输入结束而挂死（L 组 stdin.end() 实锤 3s 通）——改 spawn + ignore 立即 EOF + 手动超时
        const child = spawn(cmd, runArgs, { env: spawnEnv, cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'] }); // cwd 固定主目录：launchd 下默认 / 会导致 pi 产物落点失控
        let outBuf = '', errBuf = '';
        child.stdout.on('data', d => { outBuf += d; if (outBuf.length > 2e6) outBuf = outBuf.slice(-1e6); });
        child.stderr.on('data', d => { errBuf += d; if (errBuf.length > 4e5) errBuf = errBuf.slice(-2e5); });
        const killT = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutS * 1000);
        let settled = false;
        // P3a: 从 --mode json 流提取最终 assistant 文本（最后一个 message_end 的 assistant text）
        const extractFinalText = () => {
          let last = '';
          for (const line of outBuf.split('\n')) {
            if (!line.trim().startsWith('{')) continue;
            try {
              const e = JSON.parse(line);
              const msg = e.type === 'message_end' ? e.message : null;
              if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
                const t = msg.content.filter(c => c.type === 'text').map(c => c.text || '').join('').trim();
                if (t) last = t;
              }
            } catch {}
          }
          return last;
        };
        // P3a: 新 mesh 会话跑完后抓 session id（agentDir/sessions 最新 uuid 文件名）持久化，供下次 --resume
        const persistSessionId = () => {
          if (meshSessionId) return; // 已是 resume，不重存
          try {
            const sDir = path.join(agentDir, 'sessions');
            const found = [];
            const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(e.name)) found.push({ p, m: fs.statSync(p).mtimeMs, id: e.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)[0] }); } };
            walk(sDir);
            found.sort((a, b) => b.m - a.m);
            if (found[0]) { fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); fs.writeFileSync(sessionFile, JSON.stringify({ sessionId: found[0].id, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 }); console.log('[task] mesh session 已持久化', found[0].id); }
          } catch (e) { console.log('[task] session 抓取失败:', e.message); }
        };
        const finish = (ok) => {
          if (settled) return; settled = true; clearTimeout(killT); taskBusy = false;
          if (mesh && msgId) {
            // P3a: 结果异步上行（不再依赖 ctrl-resp 长等）——server 桥收 msg-res 后写发起方 inbox
            const text = ok ? extractFinalText() : '';
            if (!meshSessionId) persistSessionId();
            try { if (wsRef?.readyState === 1) wsRef.send(JSON.stringify({ t: 'msg-res', msgId, from, to: from, ok, text, ms: Date.now() - t0, err: ok ? '' : errBuf.slice(-300) })); } catch {}
          }
          json(res, ok ? 200 : 500, { ok, ms: Date.now() - t0, output: outBuf.slice(-40000), err: errBuf.slice(-500) });
        };
        child.on('exit', () => finish(!!outBuf));
        child.on('error', () => finish(false));
      });
      return;
    }
    if (u.pathname === '/session' && req.method === 'GET') { // P3b: mesh 会话快照（只读不删）
      const f = path.join(homedir(), '.pi-tunnel-agent', 'session.json');
      let snap = { exists: false, sessionId: null, updatedAt: null, size: 0 };
      try { const st = fs.statSync(f); const j = JSON.parse(fs.readFileSync(f, 'utf8')); snap = { exists: true, sessionId: j.sessionId || null, updatedAt: j.updatedAt || st.mtime.toISOString(), size: st.size }; } catch {}
      return json(res, 200, { ok: true, session: snap });
    }
    if (u.pathname === '/session/reset' && req.method === 'POST') { // P3b: 重置 mesh 会话（删 session.json，下次消息开新会话）
      const f = path.join(homedir(), '.pi-tunnel-agent', 'session.json');
      let old = null;
      try { old = JSON.parse(fs.readFileSync(f, 'utf8')).sessionId || null; } catch {}
      try { fs.rmSync(f, { force: true }); } catch {}
      audit('session.reset', old ? `删除 mesh 会话 ${old}` : '无会话');
      return json(res, 200, { ok: true, removed: old });
    }
    if (u.pathname === '/devices') {
      audit('devices.enum', os.platform());
      return listDevices((err, d) => json(res, err ? 500 : 200, err ? { error: err } : d));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
});

let wsRef = null;
let reconnectDelay = 5000; // 被 kicked 时拉长退避，防同名实例互踢抖动
// 应用层心跳：TCP 半开（笔记本 sleep/NAT idle 超时）时 onclose 不触发，CLI 假在线——25s 一发 ping，超时无 pong 判僵尸 terminate 强制重连
let hbTimer = null, hbAlive = true;
function startHeartbeat(ws) {
	clearInterval(hbTimer);
	hbAlive = true;
	hbTimer = setInterval(() => {
		if (ws.readyState !== 1) { clearInterval(hbTimer); return; }
		if (!hbAlive) { console.log('[tunnel] 心跳超时，判定连接僵尸，强制重连'); try { ws.terminate(); } catch {} return; }
		hbAlive = false;
		try { ws.send(JSON.stringify({ t: 'ping' })); } catch {}
	}, 25000);
}
function connect() {
  let url;
  try {
    url = new URL(SERVER.replace(/^http/, 'ws') + '/agent?token=' + TOKEN);
  } catch {
    console.error(`URL 非法: SERVER=${JSON.stringify(SERVER)} TOKEN=${JSON.stringify(TOKEN)}`);
    process.exit(1);
  }
  const ws = new WebSocket(url);
  wsRef = ws;
  // connect 兕底：10s 无 onopen（SYN 黑洞/服务未就绪）→ 强制废弃重来，防重连挂死（20261021 重启后设备消失实战根因）
  const connectGuard = setTimeout(() => {
    if (ws.readyState !== 0) return;
    console.log(`[tunnel ${ts()}] connect 10s 无响应，废弃本次连接重来`);
    try { ws.close(); } catch {}
    // 兕底兕底：undici 在 CONNECTING 态调 close() 不触发 onclose（20261024 设备重连链死亡实战根因），
    // 3s 后仍卡 0 → 退出由 launchd KeepAlive 重拉，进程级重启是唯一可靠复位
    setTimeout(() => { if (ws.readyState === 0) { console.log(`[tunnel ${ts()}] 废弃未生效，退出由 launchd 重拉`); process.exit(0); } }, 3_000);
  }, 10_000);
  ws.onopen = () => {
    clearTimeout(connectGuard);
    reconnectDelay = 5000; // 成功连接后恢复常规重连间隔
    console.log(`[tunnel ${ts()}] 已连接 ${SERVER} @ ${os.hostname()}（控制API :${ctrlPort}）`);
    ws.send(JSON.stringify({ t: 'hello', name: process.env.PI_TUNNEL_NAME || os.hostname(), os: `${os.platform()} ${os.release()} ${os.arch()}`, ctrlPort, ver: CLI_VER }));
    startHeartbeat(ws);
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (m.t === 'pong') { hbAlive = true; return; }
    if (m.t === 'ver' && typeof m.v === 'string' && Number(m.v.slice(1)) > Number(CLI_VER.slice(1))) selfUpdate(m.v);
    if (m.t === 'connect') {
      const s = net.connect({ host: m.host, port: m.port }, () =>
        ws.send(JSON.stringify({ t: 'open', id: m.id })));
      s.on('data', d => ws.send(JSON.stringify({ t: 'data', id: m.id, b64: d.toString('base64') })));
      s.on('end',  () => ws.send(JSON.stringify({ t: 'end',  id: m.id })));
      s.on('error', e => ws.send(JSON.stringify({ t: 'err', id: m.id, msg: String(e.code || e.message || e) })));
      s.on('close', () => { ws.send(JSON.stringify({ t: 'close', id: m.id })); sockMap.delete(m.id); });
      sockMap.set(m.id, s);
    } else if (m.t === 'data')  sockMap.get(m.id)?.write(Buffer.from(m.b64, 'base64'));
    else if (m.t === 'end')     sockMap.get(m.id)?.end();
    else if (m.t === 'close') { sockMap.get(m.id)?.destroy(); sockMap.delete(m.id); }
    else if (m.t === 'config') { // 面板下发：能力开关/白名单（不回 hello——server 侧有一次性推送标志，回 hello 会成死循环）
      if (Array.isArray(m.whitelist)) cfg.whitelist = m.whitelist.map(p => p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);
      if (typeof m.fsRead === 'boolean') cfg.fsRead = m.fsRead;
      if (typeof m.fsWrite === 'boolean') cfg.fsWrite = m.fsWrite;
      saveCfg();
      console.log(`[tunnel] 配置已更新: fsRead=${cfg.fsRead} fsWrite=${cfg.fsWrite} 白名单=${cfg.whitelist.length} 项`);
    }
    else if (m.t === 'ctrl') { // 面板经 server 转发的控制请求：自连本机 ctrlSrv，复用全部鉴权/审计（支持 POST body）
      const reqOpts = { host: '127.0.0.1', port: ctrlPort, path: m.url, method: m.method || 'GET', headers: { 'X-Tunnel-Token': TOKEN } };
      if (m.body) { reqOpts.headers['content-type'] = 'application/json'; reqOpts.headers['content-length'] = Buffer.byteLength(m.body); }
      const rq = http.request(reqOpts, r => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => { try { ws.send(JSON.stringify({ t: 'ctrl-resp', rid: m.rid, status: r.statusCode, body: JSON.parse(body) })); } catch {} });
      });
      rq.on('error', () => { try { ws.send(JSON.stringify({ t: 'ctrl-resp', rid: m.rid, status: 500, body: { error: 'ctrl unreachable' } })); } catch {} });
      if (m.body) rq.write(m.body);
      rq.end();
    }
    else if (m.t === 'uninstall') { // 面板下发：自卸载（停常驻→删文件与 pi agent 残留→退出）
      if (taskBusy) { try { ws.send(JSON.stringify({ t: 'ctrl-resp-notify', note: '任务执行中，稍后再卸载' })); } catch {} }
      audit('cli.uninstall', os.platform());
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'audit', items: auditBuf.splice(0) })); } catch {}
      const home = homedir();
      const run = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 8000 }, () => r()));
      const rm = f => { try { fs.rmSync(f, { force: true, recursive: true }); } catch {} };
      const stopPersist = process.platform === 'darwin'
        ? run('launchctl', ['bootout', `gui/${process.getuid()}/com.pi-tunnel.cli`])
            .then(() => run('launchctl', ['bootout', `gui/${process.getuid()}/com.gxg.pi-tunnel`])) // 历史版本 label，双 label 都卸
            .then(() => rm(path.join(home, 'Library/LaunchAgents/com.pi-tunnel.cli.plist')))
            .then(() => rm(path.join(home, 'Library/LaunchAgents/com.gxg.pi-tunnel.plist')))
        : process.platform === 'win32'
          ? run('schtasks', ['/Delete', '/TN', 'pi-tunnel', '/F'])
          : run('systemctl', ['--user', 'stop', 'pi-tunnel-cli'])
              .then(() => run('systemctl', ['--user', 'disable', 'pi-tunnel-cli']))
              .then(() => rm(path.join(home, '.config/systemd/user/pi-tunnel-cli.service')))
              .then(() => run('systemctl', ['--user', 'daemon-reload']));
      stopPersist.finally(() => {
        rm(path.join(home, 'pi-tunnel-cli.mjs'));
        rm(CFG_FILE);
        // pi agent 残留清理（B 档新增）：离线包解压目录 + 任务通道配置（含 models.json 网关 key，敏感必清）；
        // npm 全局形态的 pi 不动（可能是设备共用资产，卸载语义=只移除隧道组件）
        rm(path.join(home, 'pi-agent'));
        rm(path.join(home, '.pi-tunnel-agent'));
        console.log('[tunnel] 已卸载（常驻+文件+pi agent 残留），退出');
        try { ws.close(); } catch {}
        setTimeout(() => process.exit(0), 400);
      });
      return;
    }
    else if (m.t === 'kicked') { // 同名新实例接管：长退避，避免互踢循环
      reconnectDelay = 60000;
      console.log('[tunnel] 此设备有新实例接管，60s 后重连');
      try { ws.close(); } catch {}
      return;
    }
  };
  ws.onclose = ev => {
    clearTimeout(connectGuard);
    clearInterval(hbTimer);
    console.log(`[tunnel ${ts()}] 断开(${ev.code ?? ''}) ${reconnectDelay / 1000}s后重连`);
    for (const s of sockMap.values()) s.destroy();
    sockMap.clear();
    setTimeout(connect, reconnectDelay);
  };
  ws.onerror = () => {};
}

// 审计批量上报（重连后继续）
setInterval(() => {
  if (auditBuf.length && wsRef && wsRef.readyState === 1) {
    wsRef.send(JSON.stringify({ t: 'audit', items: auditBuf.splice(0) }));
  }
}, 5000);

// pi 探测：launchd PATH 精简，which/npm 不可用——从当前 node 路径推导（npm global bin 与 node 同目录是主流形态）
function detectPiSync() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, process.platform === 'win32' ? 'pi.cmd' : 'pi'),
    '/usr/local/bin/pi', '/opt/homebrew/bin/pi', // 系统 npm prefix 标准位（双 node 并存时 launchd node 与用户 npm 异源）
    path.join(homedir(), '.local/bin/pi'), // pnpm/自装形态（实测某设备：~/.local/bin/pi）
    path.join(homedir(), 'pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
  ];
  // npm prefix -g（npm 与 node 不同目录的形态，如 pnpm/nvm/自定义 prefix）：npm 用绝对路径（launchd PATH 精简）
  try {
    const npmAbs = path.join(nodeDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (fs.existsSync(npmAbs)) {
      const prefix = execFileSync(npmAbs, ['prefix', '-g'], { timeout: 5000 }).toString().trim();
      if (prefix) candidates.push(path.join(prefix, process.platform === 'win32' ? 'pi.cmd' : 'pi'));
    }
  } catch {}
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return '';
}
// 先起控制服务，再连隧道（hello 需要 ctrlPort）；顺便探测 pi agent 路径
(async () => {
  const tryRun = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 5000 }, (e, so) => r(e ? '' : String(so).trim())));
  try {
    let p = await tryRun('which', ['pi']);
    if (!p && process.platform === 'win32') p = (await tryRun('where', ['pi'])).split('\n')[0].trim();
    if (!p && process.platform !== 'win32') {
      const npmAbs = path.join(path.dirname(process.execPath), 'npm'); // launchd 下 npm 用绝对路径（与 node 同目录）
      try {
        fs.accessSync(npmAbs, fs.constants.X_OK);
        const prefix = await tryRun(npmAbs, ['prefix', '-g']);
        if (prefix) {
          const cand = prefix + '/bin/pi';
          try { fs.accessSync(cand, fs.constants.X_OK); p = cand; } catch {}
        }
      } catch {}
    }
    if (!p) p = detectPiSync();
    piPath = p || '';
  } catch { piPath = ''; }
  if (piPath) console.log(`[pi] agent 就绪: ${piPath}`);
  ctrlSrv.listen(0, '127.0.0.1', () => {
    ctrlPort = ctrlSrv.address().port;
    console.log(`[ctrl] 控制API监听 127.0.0.1:${ctrlPort}（fsRead=${cfg.fsRead} fsWrite=${cfg.fsWrite} 白名单=${cfg.whitelist.length}）`);
    connect();
  });
})();
