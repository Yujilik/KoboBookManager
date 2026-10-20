param([string]$AndroidSdk = "$env:LOCALAPPDATA/Android/Sdk")
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = $AndroidSdk }
    if (-not $env:JAVA_HOME -and (Test-Path 'C:/Program Files/Android/Android Studio/jbr')) { $env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Os testes do aplicativo falharam.' }
    & npm.cmd run android:sync
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar o aplicativo Android.' }
    Push-Location android
    try {
        & .\gradlew.bat :app:assembleDebug :app:testDebugUnitTest --console=plain -q
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar o APK ou testar o servidor de envio.' }
    } finally { Pop-Location }
    New-Item -ItemType Directory -Force artifacts | Out-Null
    $taskVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
    if ($taskVersion -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Versão inválida em package.json.' }
    $taskApk = Join-Path artifacts "KoboBookManager-$taskVersion.apk"
    Copy-Item -LiteralPath android/app/build/outputs/apk/debug/app-debug.apk -Destination $taskApk
    Write-Output "APK gerado: $taskApk"
} finally { Pop-Location }
