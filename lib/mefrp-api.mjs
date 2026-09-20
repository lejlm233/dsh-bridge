// lib/mefrp-api.mjs
// mefrp（幻缘映射）公开 API 客户端。
//
// 基址:   https://api.mefrp.com/api
// 认证:   Authorization: Bearer <访问令牌>（用户在 mefrp 网页控制台获取的「用户 Token」）
// 信封:   { code, data, message }，code === 200 表示成功
//
// 移植自 LunaShare 的 MefrpApiClient.kt / MefrpModels.kt，改为 Node ESM + 全局 fetch 实现。
// 与 Cloudflare 不同，mefrp 需要「先通过 API 创建代理 → 拿 proxyId / 节点 hostname」，
// 再启动 mefrpc 客户端，因此本客户端是 dsh-bridge 接入 mefrp 隧道的协议层。

const API_BASE = 'https://api.mefrp.com/api';

export class MefrpApi {
  constructor({ timeoutMs = 20000 } = {}) {
    this.timeoutMs = timeoutMs;
  }

  async _call(method, path, token, body = null) {
    if (!token) throw new Error('缺少 mefrp 访问令牌');
    const url = API_BASE + path;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'dsh-bridge-mefrp/1.0',
    };
    if (body != null) headers['Content-Type'] = 'application/json';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        let msg = res.statusText;
        try { const e = JSON.parse(text); msg = e.message || msg; } catch {}
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      let env;
      try { env = JSON.parse(text); } catch { throw new Error('mefrp 响应解析失败'); }
      if (env.code !== 200) throw new Error(env.message || `code=${env.code}`);
      return env.data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`mefrp 请求超时（${Math.round(this.timeoutMs / 1000)}s）`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  getUserInfo(token) { return this._call('GET', '/auth/user/info', token); }

  async getUserFrpToken(token) {
    const d = await this._call('GET', '/auth/user/frpToken', token);
    if (d && typeof d === 'object' && typeof d.token === 'string') return d.token;
    if (typeof d === 'string') return d;
    return '';
  }

  getNodeList(token) { return this._call('GET', '/auth/node/list', token); }

  getNodeStatus(token) { return this._call('GET', '/auth/node/status', token); }

  getCreateProxyData(token) { return this._call('GET', '/auth/createProxyData', token); }

  getProxyList(token) { return this._call('GET', '/auth/proxy/list', token); }

  // data 为 { nodes: [...], proxies: [...] } 或数组；调用方自行解析
  getProxyListWithNodes(token) { return this._call('GET', '/auth/proxy/list', token); }

  async createProxy(token, req) {
    await this._call('POST', '/auth/proxy/create', token, JSON.stringify(req));
    return true;
  }

  async deleteProxy(token, proxyId) {
    await this._call('POST', '/auth/proxy/delete', token, JSON.stringify({ proxyId }));
    return true;
  }

  async getProxyConfig(token, proxyId) {
    const d = await this._call('POST', '/auth/proxy/config', token, JSON.stringify({ proxyId, format: 'toml' }));
    if (d && typeof d === 'object' && typeof d.config === 'string') return d.config;
    return '';
  }
}
