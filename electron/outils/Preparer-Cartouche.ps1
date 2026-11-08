param(
  [Parameter(Mandatory=$true)][string]$Racine,
  [Parameter(Mandatory=$true)][string]$Id,
  [Parameter(Mandatory=$true)][string]$Titre,
  [Parameter(Mandatory=$true)][string]$Executable
)
$ErrorActionPreference = 'Stop'
if ($Id -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Id : uniquement lettres, chiffres, tirets et underscores.' }
$root = (Resolve-Path -LiteralPath $Racine).Path.TrimEnd('\') + '\'
if ([IO.Path]::IsPathRooted($Executable) -or $Executable.Contains(':') -or $Executable.Split('\','/') -contains '..') { throw 'Executable doit être un chemin relatif sans ..' }
$exe = Join-Path $root $Executable
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Executable absent : $exe" }
if (Test-Path -LiteralPath (Join-Path $root 'compucart.json')) { throw 'compucart.json existe déjà : sauvegardez-le puis retirez-le avant de générer un nouveau manifeste.' }
$checksums = [ordered]@{}
$checksums[$Executable] = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{ id=$Id; title=$Titre; executable=$Executable; args=@(); saveDir='saves'; intro=@{}; checksums=$checksums }
$json = $manifest | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $root 'compucart.json'), $json, (New-Object Text.UTF8Encoding($false)))
New-Item -ItemType Directory -Force -Path (Join-Path $root 'saves') | Out-Null
Write-Host 'Cartouche préparée. Configurez le jeu pour enregistrer dans le dossier local indiqué dans le guide.'