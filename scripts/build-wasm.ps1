param([string]$GoExe = 'go')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskOutput = Join-Path $taskRoot 'public/vendor'
New-Item -ItemType Directory -Force $taskOutput | Out-Null
$taskPreviousGOOS = $env:GOOS
$taskPreviousGOARCH = $env:GOARCH
try {
    $env:GOOS = 'js'
    $env:GOARCH = 'wasm'
    Push-Location (Join-Path $taskRoot 'tools/kepub-wasm')
    try {
        & $GoExe build -trimpath -o (Join-Path $taskOutput 'kepubify.wasm') .
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar kepubify WASM.' }
        $taskGoRoot = & $GoExe env GOROOT
        Copy-Item -LiteralPath (Join-Path $taskGoRoot 'lib/wasm/wasm_exec.js') -Destination (Join-Path $taskOutput 'wasm_exec.js')
    } finally { Pop-Location }
} finally {
    $env:GOOS = $taskPreviousGOOS
    $env:GOARCH = $taskPreviousGOARCH
}
