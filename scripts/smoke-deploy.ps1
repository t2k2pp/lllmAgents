# deploy/ に組み立てた配布物 (SEA exe + 同梱アセット) のスモーク検査。
# CI (package-smoke) とリリース (release.yml) の共通検査。リポジトリルートで実行する。
#
#   -ExpectedNode      : exe に埋め込まれた Node のバージョン (例: v24.22.1)。.deploy-meta.json の node と一致を要求
param(
  [string]$ExpectedNode = ''
)
$ErrorActionPreference = 'Stop'

$exeVersion = & .\deploy\localllm.exe --version
if ($LASTEXITCODE -ne 0 -or -not $exeVersion) { throw "localllm.exe --version failed" }
$publicVersion = (Get-Content -LiteralPath '.\package.json' -Raw | ConvertFrom-Json).version
$expectedVersion = "^localllm v$([regex]::Escape($publicVersion)) \(build [0-9a-f]+\)$"
if ($exeVersion -notmatch $expectedVersion) { throw "unexpected packaged version: $exeVersion" }
if (Test-Path -LiteralPath '.\deploy\localllm.cjs') { throw 'non-equivalent CJS fallback must not be packaged' }
if (-not (Test-Path -LiteralPath '.\deploy\agents\general-purpose.md')) { throw 'agent asset missing' }
if (-not (Test-Path -LiteralPath '.\deploy\skills\product-quality-cycle\SKILL.md')) { throw 'skill asset missing' }
$meta = Get-Content -LiteralPath '.\deploy\.deploy-meta.json' -Raw | ConvertFrom-Json
if ($meta.schemaVersion -ne 1 -or $meta.version -ne $publicVersion -or $meta.displayVersion -ne ($exeVersion -replace '^localllm ', '')) {
  throw "deploy metadata does not identify the executable: $($meta | ConvertTo-Json -Compress)"
}
if ($ExpectedNode -and $meta.node -ne $ExpectedNode) {
  throw "embedded Node $($meta.node) does not match build Node $ExpectedNode"
}
Write-Output "deploy smoke OK: $exeVersion (node $($meta.node))"
