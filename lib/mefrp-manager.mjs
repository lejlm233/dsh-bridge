// lib/mefrp-manager.mjs
// mefrp（幻缘映射）隧道管理器——dsh-bridge 的公网隧道后端之一。
//
// 设计对齐 lib/cloudflared-manager.mjs（二进制自管理 + 进程监督 + 指数退避自愈 +
// 状态机），但 mefrp 比 Cloudflare 多一个前置阶段：
//   Cloudflare 临时隧道 `cloudflared --url` 自动分配域名；mefrp 必须先「通过 API 创建
//   代理（选节点 + 端口）拿到 proxyId / 节点 hostname」，再 `mefrpc -t <frpToken> -p <proxyId>`
//   启动客户端把本地 DSH 端口映射出去。公网 URL 来自 API（nodeHost:remotePort / domain），
//   而非进程日志解析。
//
// 协议层见 lib/mefrp-api.mjs（移植自 LunaShare 的 MefrpApiClient.kt）。
//
// 注意：LunaShare 里那套「本地 CONNECT 代理绕过 8.8.8.8 DNS 拦截」是华为 Android 设备
// 特有，桌面 OS 的 DNS 正常，这里不需要，直接用系统 DNS。

import { spawn, execSync } from 'node:child_process';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, stat, unlink, rename } from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import { MefrpApi } from './mefrp-api.mjs';

const MEFRPC_VERSION = '0.67.1'; // 对齐官网下载页 v0.67.1_20260626
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000;
const MIN_BINARY_SIZE = 1 * 1024 * 1024; // mefrpc 较小，>1MB 视为有效
const HANDSHAKE_TIMEOUT_MS = 60 * 1000;
const RETRY_BASE_MS = 5 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 12;

// ── 自动下载直链（待用户提供；填了即启用自动下载，否则走 PATH / 手动放置兜底）──
// mefrp 官网下载页 https://www.mefrp.com/dashboard/downloads 的直链在蓝奏云 / 需登录，
// 程序化下载不稳，因此默认不开启自动下载，优先用系统 PATH 或用户手动放置的二进制。
// 直链到位后在此填入（例：https://.../mefrpc-windows-amd64.exe），即可对齐 cloudflared
// 的自动下载 + 版本钉死体验。
const MEFRPC_DOWNLOAD = {
  'win32-x64':   '',
  'win32-arm64': '',
  'darwin-x64':  '',
  'darwin-arm64':'',
  'linux-x64':   '',
  'linux-arm64': '',
};

// ── 工具 ────────────────────────────────────────────────────────────────
// 解析允许端口区间：「a-b」或逗号/分号分隔多段（mefrp 节点 allowPort 字段）
export function parsePortRanges(raw) {
  if (!raw) return [];
  const ranges = [];
  for (const part of String(raw).split(/[,;，；]/)) {
    const p = part.trim().replace(/^\(|\)$/g, '');
    const nums = p.split('-');
    if (nums.length === 2) {
      const a = parseInt(nums[0].trim(), 10), b = parseInt(nums[1].trim(), 10);
      if (a > 0 && b >= a) ranges.push([a, b]);
    } else if (p && /^\d+$/.test(p)) {
      const n = parseInt(p, 10); if (n > 0) ranges.push([n, n]);
    }
  }
  return ranges;
}

export function deriveVip(node) {
  const groups = String(node?.allowGroup || '').split(';').map((s) => s.trim().toLowerCase());
  return !!(groups.includes('vip') && !groups.includes('default'));
}

// 从 proxy/list（data 为 {nodes, proxies}）提取 nodeId → hostname（公网节点连接地址）
function nodeHostnameMap(data) {
  if (!data || typeof data !== 'object') return {};
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const map = {};
  for (const n of nodes) if (n.nodeId != null) map[n.nodeId] = n.hostname || '';
  return map;
}

// mefrp 进程就绪日志关键字（frp 客户端登录/代理启动成功）
function isMefrpcReadyLog(text) {
  return /login to server success|start proxy success|\[proxy [^\]]*\] start proxy/i.test(text);
}

function findSystemMefrpc() {
  const isWin = platform() === 'win32';
  const candidates = isWin
    ? ['mefrpc.exe', 'mefrpc', 'C:\\Program Files\\mefrpc\\mefrpc.exe', 'C:\\Program Files (x86)\\mefrpc\\mefrpc.exe']
    : ['mefrpc', '/usr/local/bin/mefrpc', '/usr/bin/mefrpc', '/opt/homebrew/bin/mefrpc', join(homedir(), '.local', 'bin', 'mefrpc')];
  for (const bin of candidates) {
    try {
      if (bin.includes('/') || bin.includes('\\')) {
        if (!existsSync(bin)) continue;
      }
      execSync(`"${bin}" --version`, { stdio: 'ignore', timeout: 3000 });
      return bin;
    } catch {}
  }
  return null;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('下载超时（5分钟）')), DOWNLOAD_TIMEOUT);
    function doGet(targetUrl, redirects = 0) {
      if (redirects > 5) { clearTimeout(timer); return reject(new Error('重定向次数过多')); }
      httpsGet(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          return doGet(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); clearTimeout(timer); return reject(new Error(`下载失败: HTTP ${res.statusCode}`)); }
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total > 0) onProgress(Math.round(downloaded / total * 100), downloaded, total);
        });
        const fileStream = createWriteStream(dest);
        pipeline(res, fileStream)
          .then(() => { clearTimeout(timer); resolve(); })
          .catch((err) => { clearTimeout(timer); reject(err); });
      }).on('error', (err) => { clearTimeout(timer); reject(err); });
    }
    doGet(url);
  });
}

export class MefrpManager {
  constructor({ port, home, accessToken, nodeId = null, remotePort = null, autoStart = false,
    onStateChange, logger, binaryPath = null, retryPolicy, handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS, spawnOptions = null }) {
    this.port = port;
    this.home = home || join(homedir(), '.dsh-bridge');
    this.accessToken = accessToken ? String(accessToken).trim() : null;
    this.nodeId = nodeId != null ? Number(nodeId) : null;
    this.remotePort = remotePort != null ? Number(remotePort) : null;
    this.autoStart = !!autoStart;
    this.onStateChange = onStateChange;
    this.logger = logger;
    this._injectedBinaryPath = binaryPath;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this._spawnOptions = spawnOptions || null;

    if (retryPolicy === false || retryPolicy === null) {
      this.retry = null;
    } else {
      const p = retryPolicy && typeof retryPolicy === 'object' ? retryPolicy : {};
      this.retry = {
        baseDelayMs: p.baseDelayMs ?? RETRY_BASE_MS,
        maxDelayMs: p.maxDelayMs ?? RETRY_MAX_MS,
        maxRetries: p.maxRetries ?? DEFAULT_MAX_RETRIES,
      };
    }

    this.api = new MefrpApi();
    this.process = null;
    this.url = null;
    this.binaryPath = null;
    this._stopped = false;
    this._retryTimer = null;
    this._restartCount = 0;
    this.createdProxy = null; // { proxyId, nodeHost, remotePort } —— 自愈复用，stop 时清除
  }

  start() {
    this._stopped = false;
    this._restartCount = 0;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._setState('connecting', '正在初始化 mefrp...');
    this._runTunnel().catch((err) => {
      this.logger?.error('mefrp 启动失败: %s', err.message);
      if (err && err.fatal) { this._setState('error', err.message); return; }
      this._scheduleRestart(`mefrp 启动失败: ${err.message}`);
    });
  }

  async _runTunnel() {
    if (this._stopped) return;
    const binPath = await this._ensureBinary();
    if (this._stopped) return;
    const info = await this._ensureProxy(); // 创建或复用代理 → { proxyId, nodeHost, remotePort, frpToken }
    if (this._stopped) return;
    await this._startProcess(binPath, info);
  }

  // ── 二进制自管理：系统 PATH → 本地 ~/.dsh-bridge/bin → 自动下载（直链已配置时）──
  async _ensureBinary() {
    if (this._injectedBinaryPath) { this.binaryPath = this._injectedBinaryPath; return this.binaryPath; }

    const sys = findSystemMefrpc();
    if (sys) { this.binaryPath = sys; this.logger?.info('优先使用系统 mefrpc: %s', sys); return sys; }

    const name = platform() === 'win32' ? 'mefrpc.exe' : 'mefrpc';
    const binDir = join(this.home, 'bin');
    const binPath = join(binDir, name);
    this.binaryPath = binPath;

    if (existsSync(binPath)) {
      try {
        const s = await stat(binPath);
        const fd = readFileSync(binPath);
        const isGzip = fd.length >= 2 && fd[0] === 0x1f && fd[1] === 0x8b;
        if (s.size > MIN_BINARY_SIZE && !isGzip) {
          if (platform() !== 'win32') await chmod(binPath, 0o755).catch(() => {});
          this.logger?.info('使用本地 mefrpc: %s', binPath);
          return binPath;
        }
      } catch {}
      await unlink(binPath).catch(() => {});
    }

    const key = `${platform()}-${arch()}`;
    const url = MEFRPC_DOWNLOAD[key];
    if (!url) {
      const msg = `未找到 mefrpc 二进制。请到 https://mefrp.com/dashboard/downloads 下载对应平台的 mefrp 命令行客户端，将可执行文件重命名为 ${name} 后放到 ${binPath}，或加入系统 PATH；也可在 mefrp-manager.mjs 顶部 MEFRPC_DOWNLOAD 填入官方直链以启用自动下载。`;
      this._setState('error', msg);
      throw new Error(msg);
    }

    mkdirSync(binDir, { recursive: true });
    const tempPath = `${binPath}.tmp`;
    try {
      this._setState('downloading', '正在下载 mefrpc...');
      await downloadFile(url, tempPath, (percent, downloaded, total) => {
        if (this._stopped) return;
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        this._setState('downloading', `下载 mefrpc: ${mb}/${totalMb} MB (${percent}%)`);
      });
      if (existsSync(binPath)) await unlink(binPath).catch(() => {});
      await rename(tempPath, binPath);
      if (platform() !== 'win32') await chmod(binPath, 0o755).catch(() => {});
      this.logger?.info('mefrpc 下载完成 (sha256=%s)', await sha256File(binPath));
      return binPath;
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw new Error(`准备 mefrpc 失败: ${err.message}`, { cause: err });
    }
  }

  // ── 代理生命周期：**复用优先** → 否则创建 ────────────────────────────────
  //
  // 为什么是复用优先：早期实现每次都 createProxy（名字带时间戳），只要进程被强杀 /
  // 插件重启（createdProxy 只存在内存里，一重启就丢），服务端就多留一条隧道；
  // 免费账号名额有限（默认 2 个），几次之后就被占满，公网地址也每次都变。
  //
  // LunaShare 的做法是「隧道在控制台建一次、proxyId 持久化，frpc 只负责拿 proxyId 去跑」，
  // 所以永远不会重复建。这里对齐它：用**稳定名** `dsh-bridge-<本地端口>` 回查已有隧道，
  // 命中就复用（连公网地址都不变）。为了不浪费历史遗留，还顺带**收养**旧命名
  // （`dsh-bridge-<端口>-<时间戳>`）里最"新"的那条，升级后不会再新建一条。
  async _ensureProxy() {
    if (this.createdProxy) {
      // 自愈场景：代理已存在，仅刷新可能变化的 frpToken
      const frpToken = await this.api.getUserFrpToken(this.accessToken);
      return { ...this.createdProxy, frpToken };
    }

    // 1. 验证访问令牌
    const userInfo = await this.api.getUserInfo(this.accessToken)
      .catch((e) => { throw new Error(`mefrp 访问令牌无效: ${e.message}`, { cause: e }); });

    // 2. 启动令牌（frpToken，mefrpc -t 用）
    const frpToken = await this.api.getUserFrpToken(this.accessToken);
    if (!frpToken) throw new Error('无法获取 mefrp 启动令牌（frpToken）');

    // 3. 复用优先。必须在「名额已满」检查**之前**：
    //    名额被历史遗留隧道占满，恰恰就是最需要复用的场景——先抛「名额已满」的话，
    //    用户会以为只能去 mefrp 后台手动删，而本地本来能直接复用。
    const stableName = `dsh-bridge-${this.port}`;
    const reusable = await this._findReusableProxy(stableName);
    if (reusable) {
      const proxyId = Number(reusable.proxyId) || 0;
      const nodeId = Number(reusable.nodeId) || this.nodeId || 0;
      const remotePort = Number(reusable.remotePort) || this.remotePort || 0;
      let nodeHost = '';
      try {
        const pl = await this.api.getProxyListWithNodes(this.accessToken);
        nodeHost = nodeHostnameMap(pl)[nodeId] || '';
      } catch {}
      if (!nodeHost && reusable.domain) nodeHost = String(reusable.domain);
      this.createdProxy = { proxyId, nodeHost, remotePort };
      this.logger?.info(
        'mefrp 复用已有隧道: proxyId=%d name=%s → %s',
        proxyId, reusable.proxyName || stableName,
        nodeHost ? `http://${nodeHost}:${remotePort}` : '(公网地址待服务端回填)'
      );
      return { proxyId, nodeHost, remotePort, frpToken };
    }

    // 4. 名额检查：只在确实需要**新建**时才有意义
    if (userInfo && userInfo.maxProxies != null && userInfo.usedProxies != null && userInfo.usedProxies >= userInfo.maxProxies) {
      throw new Error(`mefrp 隧道名额已满（${userInfo.usedProxies}/${userInfo.maxProxies}），请在控制台「隧道列表」里删掉不用的旧隧道`);
    }

    // 5. 选节点（未指定时：在线 + 非 VIP + 负载最低）
    let nodeId = this.nodeId;
    let nodeHost = '';
    if (!nodeId) {
      const nodes = await this.api.getNodeList(this.accessToken);
      const list = Array.isArray(nodes) ? nodes : [];
      const statusMap = {};
      try { const st = await this.api.getNodeStatus(this.accessToken); if (Array.isArray(st)) for (const s of st) statusMap[s.nodeId] = s; } catch {}
      const candidates = list.filter((n) => n.isOnline !== false && !deriveVip(n));
      if (!candidates.length) throw new Error('没有可用的 mefrp 节点（请检查账号/网络）');
      candidates.sort((a, b) => (statusMap[a.nodeId]?.loadPercent ?? 0) - (statusMap[b.nodeId]?.loadPercent ?? 0));
      nodeId = candidates[0].nodeId;
    }
    // 拿节点 hostname（从 proxyListWithNodes；隧道未建时可能为空，建后回填）
    try {
      const pl = await this.api.getProxyListWithNodes(this.accessToken);
      nodeHost = nodeHostnameMap(pl)[nodeId] || '';
    } catch {}

    // 6. 选远端端口（未指定时：节点 allowPort / createProxyData.allowPort 随机）
    let remotePort = this.remotePort;
    if (!remotePort) {
      const ranges = [];
      try {
        const nd = await this.api.getNodeList(this.accessToken);
        const n = (Array.isArray(nd) ? nd : []).find((x) => x.nodeId === nodeId);
        if (n) ranges.push(...parsePortRanges(n.allowPort));
      } catch {}
      if (!ranges.length) {
        try {
          const cd = await this.api.getCreateProxyData(this.accessToken);
          if (cd && cd.allowPort) ranges.push(...parsePortRanges(cd.allowPort));
        } catch {}
      }
      if (ranges.length) {
        const [a, b] = ranges[Math.floor(Math.random() * ranges.length)];
        remotePort = a + Math.floor(Math.random() * (b - a + 1));
      } else {
        remotePort = 10000 + Math.floor(Math.random() * 10000);
      }
    }

    // 7. 创建代理（TCP 隧道映射本地 DSH 端口）。
    //    名字用**稳定名**、不带时间戳：下次启动才能按同名回查到它并复用，
    //    否则又会留下一堆孤儿隧道（这正是本次要修的问题）。
    await this.api.createProxy(this.accessToken, {
      nodeId,
      proxyName: stableName,
      proxyType: 'tcp',
      localIp: '127.0.0.1',
      localPort: this.port,
      remotePort,
    });
    const proxyId = await this._findProxyId(stableName);
    if (proxyId == null) throw new Error('创建 mefrp 隧道后未能获取代理 ID');

    // 建后回填 nodeHost（此时 proxyListWithNodes 才有该节点）
    try {
      const pl = await this.api.getProxyListWithNodes(this.accessToken);
      const hosts = nodeHostnameMap(pl);
      const h = hosts[nodeId];
      if (h) nodeHost = h;
      // 也可用 proxy.domain 作为公网访问域名（若服务端返回）
      const pd = await this._findProxy(stableName);
      if (!nodeHost && pd && pd.domain) nodeHost = pd.domain;
    } catch {}

    this.createdProxy = { proxyId, nodeHost, remotePort };
    this.logger?.info('mefrp 代理已创建: proxyId=%d nodeHost=%s remotePort=%d', proxyId, nodeHost || '?', remotePort);
    return { proxyId, nodeHost, remotePort, frpToken };
  }

  // 按稳定名回查可复用的隧道：先精确匹配 `dsh-bridge-<端口>`，
  // 再收养旧命名 `dsh-bridge-<端口>-<时间戳>` 里 proxyId 最大（最近建的）那条。
  async _findReusableProxy(stableName) {
    try {
      const data = await this.api.getProxyList(this.accessToken);
      let proxies = [];
      if (Array.isArray(data)) proxies = data;
      else if (data && Array.isArray(data.proxies)) proxies = data.proxies;
      else if (data && Array.isArray(data.list)) proxies = data.list;
      if (!proxies.length) return null;

      const exact = proxies.find((p) => p.proxyName === stableName);
      if (exact) return exact;

      const legacy = proxies
        .filter((p) => String(p.proxyName || '').startsWith(`${stableName}-`))
        .sort((a, b) => (Number(b.proxyId) || 0) - (Number(a.proxyId) || 0));
      return legacy[0] || null;
    } catch { return null; }
  }

  async _findProxyId(proxyName) {
    const id = await this._findProxy(proxyName);
    return id != null ? id.proxyId : null;
  }

  async _findProxy(proxyName) {
    try {
      const data = await this.api.getProxyList(this.accessToken);
      let proxies = [];
      if (Array.isArray(data)) proxies = data;
      else if (data && Array.isArray(data.proxies)) proxies = data.proxies;
      else if (data && Array.isArray(data.list)) proxies = data.list;
      return proxies.find((x) => x.proxyName === proxyName) || null;
    } catch { return null; }
  }

  _startProcess(binPath, info) {
    return new Promise((resolve, reject) => {
      if (this._stopped) return reject(new Error('已取消'));
      this._setState('connecting', '正在连接 mefrp 节点...');

      // mefrpc 走服务端自取配置模式：-n 关更新检查，-t 启动令牌，-p 代理 ID
      const args = ['-n', '-t', info.frpToken, '-p', String(info.proxyId)];
      const safeArgs = args.map((a) => (a === info.frpToken ? '***' : a));
      this.logger?.info('启动 mefrpc: %s %s', binPath, safeArgs.join(' '));

      const proc = spawn(binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(this._spawnOptions || {}),
      });
      this.process = proc;

      // 公网 URL 来自 API（创建时已确定），不依赖进程日志。
      // nodeHost 缺失时不兜底成 localhost（那不是公网地址，会误导用户），保持 null，
      // UI 仅展示"运行中"与状态详情；真实公网地址以 mefrp 控制台为准。
      this.url = info.nodeHost
        ? (info.nodeHost.startsWith('http') ? info.nodeHost : `http://${info.nodeHost}:${info.remotePort}`)
        : null;

      let resolved = false;
      let stderrTail = '';
      const tryResolve = () => {
        if (!resolved) {
          resolved = true;
          this._restartCount = 0;
          this._setState('ready', `mefrp 隧道已建立 (${this.url})`);
          this.logger?.info('mefrp 就绪: %s', this.url);
          resolve();
        }
      };

      // 日志出现就绪关键字即视为成功；否则握手超时（默认 60s）兜底：
      // 进程仍存活且无致命错误则判 ready（mefrpc 连接节点通常很快）
      const settleTimer = setTimeout(() => {
        if (!resolved && proc.exitCode === null) {
          this._setState('ready', `mefrp 隧道已建立 (${this.url})`);
          this.logger?.info('mefrp 就绪（兜底）: %s', this.url);
          tryResolve();
        }
      }, Math.min(this.handshakeTimeoutMs, 5000));

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        this.logger?.debug('mefrpc: %s', text.trim());
        if (isMefrpcReadyLog(text) && !resolved) tryResolve();
      });
      proc.stderr.on('data', (d) => {
        const text = d.toString();
        this.logger?.debug('mefrpc: %s', text.trim());
        stderrTail = (stderrTail + text).slice(-2000);
        if (isMefrpcReadyLog(text) && !resolved) tryResolve();
      });

      proc.on('exit', (code, signal) => {
        if (settleTimer) clearTimeout(settleTimer);
        const stillCurrent = this.process === proc;
        if (stillCurrent) this.process = null;
        this.url = null;
        if (!resolved) {
          const fatal = /invalid|unauthorized|token|flag provided|no such host/i.test(stderrTail);
          const msg = `mefrpc 启动失败: ${fatal ? '配置错误（' + (stderrTail.trim().split('\n').pop() || '请检查令牌/参数') + '）' : `mefrpc 退出 code=${code ?? ''} signal=${signal ?? ''}`}`;
          const err = new Error(msg);
          if (fatal) err.fatal = true;
          reject(err);
        } else if (!this._stopped && stillCurrent) {
          this._scheduleRestart(`mefrpc 进程意外退出 (code=${code ?? ''}${signal ? `, ${signal}` : ''})`);
        } else {
          this._setState('idle', '');
        }
      });

      proc.on('error', (err) => {
        if (settleTimer) clearTimeout(settleTimer);
        if (!resolved) reject(err);
      });
    });
  }

  // ── 退避自愈（对齐 CloudflaredManager）──────────────────────────────────
  _scheduleRestart(reason) {
    if (this._stopped) return;
    if (this._retryTimer) return;
    if (!this.retry) { this._setState('error', reason); return; }
    this._restartCount++;
    if (this._restartCount > this.retry.maxRetries) {
      this._setState('error', `${reason}（已自动重试 ${this.retry.maxRetries} 次仍失败，请检查网络/令牌，或点击「关闭」停止）`);
      return;
    }
    const delay = Math.min(
      this.retry.baseDelayMs * 2 ** (this._restartCount - 1),
      this.retry.maxDelayMs
    );
    this._setState('reconnecting',
      `${reason}，${Math.max(1, Math.round(delay / 1000))}s 后自动重连（第 ${this._restartCount}/${this.retry.maxRetries} 次）`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._restartAttempt();
    }, delay);
  }

  _restartAttempt() {
    if (this._stopped) return;
    this._setState('connecting', '正在自动重连...');
    this._runTunnel().catch((err) => {
      this.logger?.error('mefrp 自动重连失败: %s', err.message);
      if (err && err.fatal) { this._setState('error', err.message); return; }
      this._scheduleRestart(`mefrp 启动失败: ${err.message}`);
    });
  }

  _terminateProcess() {
    const p = this.process;
    if (!p) return;
    try {
      if (platform() === 'win32') {
        spawn('taskkill', ['/pid', String(p.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }
    } catch {}
  }

  _setState(phase, detail) {
    this.onStateChange?.({ phase, detail });
  }

  stop() {
    this._stopped = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._restartCount = 0;
    if (this.process) { this._terminateProcess(); this.process = null; }
    // 注意：这里**故意不删除**服务端代理。保留隧道，下次启动才能按稳定名复用，
    // 公网地址保持不变（对齐 LunaShare「隧道建一次、长期复用」的语义；
    // 早期实现每次 stop 都删，重启又新建，地址每次都变、崩溃时还会留下孤儿隧道）。
    // 真正要释放名额时：用户在控制台「隧道列表」里删，或走 resetMefrp()。
    this.createdProxy = null; // 只丢内存引用，服务端记录留着复用
    this.url = null;
    this._setState('idle', '');
  }

  // 显式删除当前代理（真正释放 mefrp 名额）。必须在 stop() 之前调用——
  // stop() 会把 createdProxy 置空。resetMefrp() 靠它拿新地址：
  // 不删的话「重置链接」会被复用逻辑原样捡回旧地址，等于没重置。
  async deleteCreatedProxy() {
    const info = this.createdProxy;
    if (!info || !this.accessToken) return false;
    await this.api.deleteProxy(this.accessToken, info.proxyId);
    this.logger?.info('已删除 mefrp 代理 #%d', info.proxyId);
    this.createdProxy = null;
    return true;
  }
}
