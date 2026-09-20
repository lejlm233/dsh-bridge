// 升级来源与安装 spec 的构造（纯函数，无副作用）。
//
// 为什么要单独一个模块：这些字符串最终会拼进 `spawn(cmd, args, { shell: true })`
// 的命令行，一旦被注入就是任意命令执行。抽成纯函数后可以脱离真实 spawn 独立测，
// 也就堵住了「改了正则但没测」的风险。

/** npm 包名。本仓库是 fork，未发布到 npm 时靠 GITHUB_REPO 兜底。 */
export const NPM_PACKAGE = '@lejlm233/dsh-bridge';

/**
 * GitHub 仓库（`owner/repo`）。**必须与 package.json 的 repository.url 一致** ——
 * 它是 git 安装 spec 的唯一来源，拼错会静默装不上（有单测比对两者）。
 */
export const GITHUB_REPO = 'lejlm233/dsh-bridge';

/** 允许的版本号形式：`latest` 或严格 SemVer（不允许任何 shell 元字符）。 */
const SEMVER = /^(latest|\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?)$/;
/** 从 GitHub tag 里抽出的裸版本号。 */
const BARE_SEMVER = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;

/** 版本号是否通过白名单校验（`latest` 或严格 SemVer）。 */
export function isValidUpgradeVersion(version) {
  return SEMVER.test(String(version ?? '').trim());
}

/**
 * GitHub tag → 裸版本号：`v2.10.12` / `2.10.12` → `2.10.12`。
 * tag 约定为 `v<version>`（见 scripts/create-github-release.mjs）。不合法返回 `null`。
 */
export function normalizeGithubTag(tag) {
  const v = String(tag ?? '').trim().replace(/^[vV]/, '');
  return BARE_SEMVER.test(v) ? v : null;
}

/**
 * 构造候选安装 spec 列表，按 `source` 决定先试哪个，另一个留作兜底。
 *
 * - npm 源：`@lejlm233/dsh-bridge@2.10.12`
 * - git 源：`github:lejlm233/dsh-bridge#v2.10.12`（`latest` 则走默认分支，不带 ref）
 *
 * git 地址**只由 [GITHUB_REPO] 常量拼出**，绝不把客户端传入的字符串当 URL 用。
 * 版本号不合规时返回空数组 —— 调用方在此之前已返回「非法的版本号格式」，
 * 这里再挡一层，保证任何调用路径都构造不出带元字符的命令。
 */
export function buildUpgradeSpecs(version, source) {
  const v = String(version ?? '').trim();
  if (!isValidUpgradeVersion(v)) return [];
  // tag 约定 v<version>；latest 交给默认分支
  const gitRef = v === 'latest' ? '' : `#v${v}`;
  const npmSpec = `${NPM_PACKAGE}@${v}`;
  const gitSpec = `github:${GITHUB_REPO}${gitRef}`;
  return source === 'github' ? [gitSpec, npmSpec] : [npmSpec, gitSpec];
}
