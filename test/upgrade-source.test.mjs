import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NPM_PACKAGE,
  GITHUB_REPO,
  isValidUpgradeVersion,
  normalizeGithubTag,
  buildUpgradeSpecs,
} from '../lib/upgrade-source.mjs'

// 这些字符串最终会拼进 spawn(shell:true) 的命令行，所以单测重点在「注入面」而非功能。

test('upgrade-source: 包名与仓库地址必须和 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(NPM_PACKAGE, pkg.name, 'NPM_PACKAGE 必须等于 package.json 的 name')
  // repository.url 形如 git+https://github.com/owner/repo.git
  const slug = String(pkg.repository?.url || '').replace(/^git\+/, '').replace(/\.git$/, '')
  assert.ok(slug.endsWith(GITHUB_REPO), `GITHUB_REPO(${GITHUB_REPO}) 必须与 repository.url(${slug}) 指向同一仓库`)
})

test('upgrade-source: 版本号白名单挡掉全部 shell 元字符', () => {
  for (const ok of ['latest', '2.10.12', '2.0.0-beta.1', '10.0.0']) {
    assert.equal(isValidUpgradeVersion(ok), true, `${ok} 应当合法`)
  }
  for (const bad of [
    '2.5.0; calc.exe',
    '2.5.0 & whoami',
    '`id`',
    '$(id)',
    '2.5.0 | tee /tmp/x',
    '2.5.0\nrm -rf /',
    '../evil',
    'github:lejlm233/dsh-bridge#v1.0.0', // git spec 不能从外部直接传进来
    'https://github.com/lejlm233/dsh-bridge',
    '',
    null,
    undefined,
    'v2.10.12', // 带 v 前缀的版本号也不接受（tag 前缀由 buildUpgradeSpecs 自己加）
  ]) {
    assert.equal(isValidUpgradeVersion(bad), false, `${String(bad)} 应当被拒`)
  }
})

test('upgrade-source: buildUpgradeSpecs 对非法版本返回空数组（二次防护）', () => {
  assert.deepEqual(buildUpgradeSpecs('2.5.0; calc.exe', 'npm'), [])
  assert.deepEqual(buildUpgradeSpecs('2.5.0; calc.exe', 'github'), [])
  assert.deepEqual(buildUpgradeSpecs('$(id)', null), [])
  assert.deepEqual(buildUpgradeSpecs(null, 'npm'), [])
})

test('upgrade-source: 按 source 决定先试哪个来源，另一个留作兜底', () => {
  const npmFirst = buildUpgradeSpecs('2.10.12', 'npm')
  assert.deepEqual(npmFirst, ['@lejlm233/dsh-bridge@2.10.12', 'github:lejlm233/dsh-bridge#v2.10.12'])

  const gitFirst = buildUpgradeSpecs('2.10.12', 'github')
  assert.deepEqual(gitFirst, ['github:lejlm233/dsh-bridge#v2.10.12', '@lejlm233/dsh-bridge@2.10.12'])

  // source 缺省/未知时按 npm 优先（与改动前行为一致，纯 npm 环境下不打折）
  assert.deepEqual(buildUpgradeSpecs('2.10.12', null), npmFirst)
  assert.deepEqual(buildUpgradeSpecs('2.10.12', 'whatever'), npmFirst)
})

test('upgrade-source: latest 走默认分支，不拼 ref', () => {
  const specs = buildUpgradeSpecs('latest', 'github')
  assert.equal(specs[0], 'github:lejlm233/dsh-bridge')
  assert.equal(specs[1], '@lejlm233/dsh-bridge@latest')
})

test('upgrade-source: 构造出的 spec 里除版本号外不含任何可被 shell 解释的字符', () => {
  for (const source of ['npm', 'github']) {
    for (const spec of buildUpgradeSpecs('2.10.12-rc.1', source)) {
      // 允许字符：字母数字、`.`、`-`、`@`、`:`、`/`、`#`
      assert.match(spec, /^[A-Za-z0-9.@:/#-]+$/, `spec 含可疑字符: ${spec}`)
    }
  }
})

test('upgrade-source: 从 GitHub tag 抽版本号', () => {
  assert.equal(normalizeGithubTag('v2.10.12'), '2.10.12')
  assert.equal(normalizeGithubTag('2.10.12'), '2.10.12')
  assert.equal(normalizeGithubTag('V2.10.12'), '2.10.12')
  assert.equal(normalizeGithubTag(' v2.10.12 '), '2.10.12')
  assert.equal(normalizeGithubTag('v2.10.12-beta.3'), '2.10.12-beta.3')

  for (const bad of ['nightly', 'v2.10', 'v2', '', null, undefined, 'v2.10.12; rm -rf /', 'release-2.10.12']) {
    assert.equal(normalizeGithubTag(bad), null, `${String(bad)} 应当被拒`)
  }
})
