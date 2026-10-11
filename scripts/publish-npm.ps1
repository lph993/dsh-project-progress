# 发布脚本（npmjs 官方源）
#
# 为什么不让 AI 直接跑 `npm publish`：
#   1) 认证必须由你在本机 `npm login` 完成，密码/浏览器授权不该经过会话；
#   2) 本机 `~/.npmrc` 默认源是 registry.npmmirror.com —— 直接 `npm publish`
#      有发到镜像的风险，所以显式指定官方源；
#   3) `publish` 会跑 `prepare`（= pnpm run build），故用 `--ignore-scripts=false`
#      保留构建，否则发出去的会是旧产物。
#
# 关于认证（实测坑）：token 由 `npm login` 写在**默认配置** `~/.npmrc` 里，
# 所以这里**不能**用 `--userconfig` 指向别的文件 —— 那会屏蔽 `~/.npmrc`，
# 结果明明登录了却报 ENEEDAUTH。改用 `--registry` 显式指定官方源即可
# （`--registry` 覆盖 `~/.npmrc` 里的镜像源，但不屏蔽同文件里的 token）。
#
# 用法（在仓库根目录）：
#   pwsh -File scripts\publish-npm.ps1            # 真发布
#   pwsh -File scripts\publish-npm.ps1 -DryRun    # 只演练：打包 + 登录检查，不推送
#
# 注意：本脚本**不**改你的 `~/.npmrc`。

[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$Registry = 'https://registry.npmjs.org/'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$cfg = Join-Path $repo '.pm\publish.npmrc'
if (-not (Test-Path $cfg)) {
  throw "缺少临时发布配置：$cfg"
}

Write-Host "== 目标源：$Registry ==" -ForegroundColor Cyan

# ── 1. 登录态检查（没登录就别浪费时间打包）─────────────────────────────
$who = & npm whoami --registry $Registry 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "未登录（npm whoami 失败）：" -ForegroundColor Red
  Write-Host ($who | Out-String)
  Write-Host "先执行：npm login --registry=$Registry --auth-type=web" -ForegroundColor Yellow
  exit 1
}
$who = ($who | Out-String).Trim()
Write-Host "登录身份：$who" -ForegroundColor Green

# ── 2. 名字是否已被占用（占用了就别白打包）─────────────────────────────
$name = (Get-Content package.json -Raw | ConvertFrom-Json).name
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "待发布：$name@$version"
$existing = & npm view "$name@$version" version --registry $Registry 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "该版本已存在于 $Registry —— 先改版本号，否则必然被拒：" -ForegroundColor Red
  Write-Host ($existing | Out-String)
  exit 1
}
Write-Host "版本号未被占用，可以发。" -ForegroundColor Green

if ($DryRun) {
  Write-Host "`n[DryRun] 不推送。真实执行去掉 -DryRun。" -ForegroundColor Yellow
  & npm publish --dry-run --registry $Registry --ignore-scripts=false
  exit $LASTEXITCODE
}

# ── 3. 真发布 ─────────────────────────────────────────────────────────
# --ignore-scripts=false：保留 prepare（构建），否则发出旧产物。
# 非 scoped 包不需要 --access public。
& npm publish --registry $Registry --ignore-scripts=false
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host "发布失败（exit=$code）—— 上面是 npm 的原始报错。" -ForegroundColor Red
  exit $code
}

Write-Host "`n发布成功。核对：" -ForegroundColor Green
Write-Host "  npm view $name version --registry $Registry"
Write-Host "  npm view $name --registry $Registry"
