# 租屋資訊網爬蟲啟動器（路徑含中文，用 PowerShell 避免 .bat 編碼問題）
$env:NODE_PATH = "D:\BLI_Auto_git\node_modules"
Set-Location $PSScriptRoot
node scraper.js
Read-Host "完成，按 Enter 關閉"
