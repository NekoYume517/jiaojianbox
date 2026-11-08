param([int]$Port=8765,[switch]$Lan)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if(-not $env:JJB_DATA_DIR){$env:JJB_DATA_DIR=Join-Path $PSScriptRoot 'data'}
$listenAddress=if($Lan){'0.0.0.0'}else{'127.0.0.1'}
go run ./cmd/jiaojianbox-server --listen "${listenAddress}:$Port"
