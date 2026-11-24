# 重新產生 test/_preview.html，並用 Chrome／Edge 開啟（避免用到 IE 或舊版瀏覽器）
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-preview.ps1') | Out-Null

$target = Join-Path $PSScriptRoot '_preview.html'
$url = $target
if ($SelfTest) { $url = $target + '#test' }

$candidates = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)

$browser = $null
foreach ($path in $candidates) {
  if (Test-Path $path) { $browser = $path; break }
}

if ($browser) {
  Start-Process -FilePath $browser -ArgumentList ('"' + $url + '"')
  Write-Output ('已用 ' + (Split-Path $browser -Leaf) + ' 開啟：' + $url)
} else {
  Start-Process $url
  Write-Output ('找不到 Chrome／Edge，改用預設瀏覽器開啟：' + $url)
}
