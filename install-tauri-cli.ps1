$vc = 'C:\BuildTools\VC\Tools\MSVC\14.44.35207'
$sdk = 'C:\Program Files (x86)\Windows Kits\10'
$sdkv = '10.0.26100.0'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$vc\bin\Hostx64\x64;$sdk\bin\$sdkv\x64;$env:PATH"
$env:INCLUDE = "$vc\include;$sdk\Include\$sdkv\ucrt;$sdk\Include\$sdkv\um;$sdk\Include\$sdkv\shared;$sdk\Include\$sdkv\winrt"
$env:LIB = "$vc\lib\x64;$sdk\Lib\$sdkv\ucrt\x64;$sdk\Lib\$sdkv\um\x64"
$log = 'd:\ciska_Accodunting\hisaabo\.tauri-cli.log'
$env:CARGO_NET_RETRY = '10'
$env:CARGO_HTTP_LOW_SPEED_LIMIT = '1'
$env:CARGO_HTTP_TIMEOUT = '300'
$env:CARGO_HTTP_MULTIPLEXING = 'false'
Set-Location 'd:\ciska_Accodunting\hisaabo\apps\desktop\src-tauri'
& cargo install tauri-cli --version '^2' --locked --force *>&1 | Out-File -Encoding utf8 $log
"EXITCODE=$LASTEXITCODE" | Out-File -Encoding utf8 -Append $log