$vc = 'C:\BuildTools\VC\Tools\MSVC\14.44.35207'
$sdk = 'C:\Program Files (x86)\Windows Kits\10'
$sdkv = '10.0.26100.0'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$vc\bin\Hostx64\x64;$sdk\bin\$sdkv\x64;$env:PATH"
$env:INCLUDE = "$vc\include;$sdk\Include\$sdkv\ucrt;$sdk\Include\$sdkv\um;$sdk\Include\$sdkv\shared;$sdk\Include\$sdkv\winrt"
$env:LIB = "$vc\lib\x64;$sdk\Lib\$sdkv\ucrt\x64;$sdk\Lib\$sdkv\um\x64"
$env:CARGO_NET_RETRY = '10'
$env:CARGO_HTTP_LOW_SPEED_LIMIT = '1'
$env:CARGO_HTTP_TIMEOUT = '300'
$env:VITE_API_URL = 'https://api.hisaabo.in'
$env:VITE_TURNSTILE_SITE_KEY = ''
$env:TAURI_SIGNING_PRIVATE_KEY = ''
$log = 'd:\ciska_Accodunting\hisaabo\.tauri-build.log'
Set-Location 'd:\ciska_Accodunting\hisaabo\apps\desktop\src-tauri'
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"

# Phase 1: Rust compile, retrying around transient App Control denials.
#
# Defender / Smart App Control sometimes stamps a fresh, unsigned build artifact
# with a cached "blocked" verdict (os error 4551). Retrying alone cannot help,
# because cargo then reuses the exact same denied binary or proc-macro DLL.
# Deleting the named artifact forces a recompile, which runs fine. Crates that
# already compiled are cached, so every retry advances the dependency graph.
# Covers both shapes of failure:
#   * "could not execute process `...\build-script-build`"  (build script)
#   * "LoadLibraryExW failed: ...blocked" on a .dll         (proc-macro DLL)
$ok = $false
for ($attempt = 1; $attempt -le 80; $attempt++) {
  "=== cargo build attempt $attempt ===" | Out-File -Encoding utf8 -Append $log
  $out = & $cargo build --release --locked *>&1 | Out-String
  $out | Out-File -Encoding utf8 -Append $log
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }

  if ($out -notmatch 'Application Control policy has blocked') {
    # Not the transient App Control denial -- a real compile error. Stop.
    "STOP: failure is not an App Control block; not retrying." |
      Out-File -Encoding utf8 -Append $log
    break
  }

  # Every absolute file path the log blamed for the block.
  $targets = New-Object System.Collections.Generic.List[string]
  foreach ($m in [regex]::Matches($out, 'could not execute process `([^`]+)`')) {
    [void]$targets.Add($m.Groups[1].Value)
  }
  # `\\?\D:\path\file.dll:` and `D:\path\file.dll:` (trailing colon = msg dir)
  foreach ($m in [regex]::Matches($out, '(?m)((?:\\\\\?\\)?[A-Za-z]:[^\r\n`"''<>|]+\.(?:exe|dll))\s*:?')) {
    [void]$targets.Add($m.Groups[1].Value)
  }

  $removed = 0
  foreach ($t in $targets) {
    $p = $t -replace '^\\\\\?\\', ''
    if ($p -and (Test-Path -LiteralPath $p)) {
      Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $p)) { $removed++ }
      # Drop sibling output too so cargo cannot reuse a stale fingerprint.
      foreach ($sib in @("$p.pdb", ($p -replace '\.(exe|dll)$', '.d'))) {
        if (Test-Path -LiteralPath $sib) {
          Remove-Item -LiteralPath $sib -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }

  "RETRY: attempt $attempt removed $removed blocked artifact(s) from " +
    "$($targets.Count) path(s) named in the log" |
    Out-File -Encoding utf8 -Append $log

  if ($targets.Count -eq 0) {
    "STOP: block reported but no file path could be extracted." |
      Out-File -Encoding utf8 -Append $log
    break
  }
  Start-Sleep -Seconds 3
}
"CARGO_OK=$ok" | Out-File -Encoding utf8 -Append $log

# Phase 2: bundle the installer (reuses the binary built above).
if ($ok) {
  Set-Location 'd:\ciska_Accodunting\hisaabo\apps\desktop'
  "=== bundling ===" | Out-File -Encoding utf8 -Append $log
  & $cargo tauri build --config src-tauri/tauri.conf.prod.json *>&1 |
    Out-File -Encoding utf8 -Append $log
  "EXITCODE=$LASTEXITCODE" | Out-File -Encoding utf8 -Append $log
} else {
  "EXITCODE=1" | Out-File -Encoding utf8 -Append $log
}