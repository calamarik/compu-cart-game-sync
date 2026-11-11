<#
  Expérience ProjFS (jetable, ne touche pas à Compu-Cart).
  Question posée : quand un jeu démarre depuis un dossier ProjFS qui reflète la cartouche,
  Windows demande-t-il seulement les morceaux de fichiers lus, ou les fichiers entiers ?

  Utilisation (PowerShell normal, pas administrateur, après activation de Client-ProjFS) :
    .\projfs-experiment.ps1 -Source "E:\BerserkBoy" -Root "C:\cc-projfs-test\BerserkBoy"
  Laisse cette fenêtre ouverte, lance le jeu depuis -Root (dans une autre fenêtre ou l'Explorateur),
  puis arrête avec Ctrl+C. Le détail est écrit dans le journal (par défaut <Root>-journal.txt).
  -Reset supprime la copie locale du test (à utiliser entre deux essais).
#>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Journal = "",
  [switch]$Reset
)
$ErrorActionPreference = "Stop"
if (-not $Journal) { $Journal = "$Root-journal.txt" }
$Source = (Resolve-Path $Source).Path.TrimEnd('\')

# 1. Fonctionnalité Windows
$feature = Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS
if ($feature.State -ne "Enabled") {
  Write-Host "ProjFS n'est pas activé. Dans un PowerShell ADMINISTRATEUR :" -ForegroundColor Yellow
  Write-Host "  Enable-WindowsOptionalFeature -Online -FeatureName Client-ProjFS -NoRestart" -ForegroundColor Yellow
  Write-Host "Puis redémarre Windows si on te le demande, et relance ce script."
  exit 1
}

# 2. Bibliothèque managée Microsoft.Windows.ProjFS (paquet NuGet officiel, téléchargé une fois)
$work = Join-Path $env:LOCALAPPDATA "CompuCart-ProjFS-Test"
$dll = Get-ChildItem $work -Recurse -Filter "Microsoft.Windows.ProjFS.dll" -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match "net4" } | Select-Object -First 1
if (-not $dll) {
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $zip = Join-Path $work "projfs.zip"
  Write-Host "Téléchargement de Microsoft.Windows.ProjFS (NuGet)..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Windows.ProjFS" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath (Join-Path $work "pkg") -Force
  $dll = Get-ChildItem $work -Recurse -Filter "Microsoft.Windows.ProjFS.dll" | Where-Object { $_.FullName -match "net4" } | Select-Object -First 1
}
if (-not $dll) { throw "Microsoft.Windows.ProjFS.dll (net4x) introuvable dans le paquet. Envoie-moi le contenu de $work" }
[Reflection.Assembly]::LoadFrom($dll.FullName) | Out-Null
Write-Host "Bibliothèque : $($dll.FullName)"

# 3. Dossier virtuel
if ($Reset -and (Test-Path $Root)) { Remove-Item $Root -Recurse -Force; Write-Host "Copie locale supprimée." }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$Root = (Resolve-Path $Root).Path.TrimEnd('\')

$code = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Microsoft.Windows.ProjFS;

public class CcEnum { public List<FileSystemInfo> Items; public int Index; public string Filter; public bool FilterSet; }

public class CcProvider : IRequiredCallbacks
{
    readonly string src;
    readonly VirtualizationInstance inst;
    readonly Dictionary<Guid, CcEnum> enums = new Dictionary<Guid, CcEnum>();
    readonly StreamWriter log;
    public long BytesRequested, BytesFetched; public int Requests;
    public readonly Dictionary<string, long> PerFile = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
    const uint Chunk = 1024 * 1024;

    public CcProvider(string source, string root, string journal)
    {
        src = source;
        log = new StreamWriter(journal, false, new UTF8Encoding(false)); log.AutoFlush = true;
        HResult hr = VirtualizationInstance.MarkDirectoryAsVirtualizationRoot(root, Guid.NewGuid());
        if (hr != HResult.Ok && hr != HResult.AlreadyInitialized) throw new Exception("MarkDirectoryAsVirtualizationRoot : " + hr);
        inst = new VirtualizationInstance(root, 0, 0, false, new List<NotificationMapping>());
    }
    public void Start() { HResult hr = inst.StartVirtualizing(this); if (hr != HResult.Ok) throw new Exception("StartVirtualizing : " + hr); Log("Démarré"); }
    public void Stop() { try { inst.StopVirtualizing(); } catch { } Log("Arrêté"); log.Dispose(); }
    void Log(string s) { lock (log) log.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + "  " + s); }
    string Full(string rel) { return string.IsNullOrEmpty(rel) ? src : Path.Combine(src, rel); }

    static bool Match(string name, string filter)
    {
        if (string.IsNullOrEmpty(filter) || filter == "*" || filter == "*.*") return true;
        return Wild(name.ToLowerInvariant(), 0, filter.ToLowerInvariant(), 0);
    }
    static bool Wild(string s, int i, string p, int j)
    {
        while (j < p.Length)
        {
            if (p[j] == '*') { for (int k = i; k <= s.Length; k++) if (Wild(s, k, p, j + 1)) return true; return false; }
            if (i >= s.Length) return false;
            if (p[j] != '?' && p[j] != s[i]) return false;
            i++; j++;
        }
        return i == s.Length;
    }

    public HResult StartDirectoryEnumerationCallback(int commandId, Guid enumerationId, string relativePath, uint pid, string procName)
    {
        string dir = Full(relativePath);
        if (!Directory.Exists(dir)) return HResult.PathNotFound;
        List<FileSystemInfo> items = new List<FileSystemInfo>(new DirectoryInfo(dir).GetFileSystemInfos());
        items.Sort(delegate (FileSystemInfo a, FileSystemInfo b) { return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase); });
        CcEnum e = new CcEnum(); e.Items = items;
        lock (enums) enums[enumerationId] = e;
        return HResult.Ok;
    }
    public HResult EndDirectoryEnumerationCallback(Guid enumerationId) { lock (enums) enums.Remove(enumerationId); return HResult.Ok; }
    public HResult GetDirectoryEnumerationCallback(int commandId, Guid enumerationId, string filter, bool restart, IDirectoryEnumerationResults result)
    {
        CcEnum e; lock (enums) { if (!enums.TryGetValue(enumerationId, out e)) return HResult.InternalError; }
        if (restart) { e.Index = 0; e.FilterSet = false; }
        if (!e.FilterSet) { e.Filter = filter; e.FilterSet = true; }
        bool added = false;
        while (e.Index < e.Items.Count)
        {
            FileSystemInfo it = e.Items[e.Index];
            if (Match(it.Name, e.Filter))
            {
                bool isDir = (it.Attributes & FileAttributes.Directory) != 0;
                long size = isDir ? 0 : ((FileInfo)it).Length;
                if (!result.Add(it.Name, size, isDir)) return added ? HResult.Ok : HResult.InsufficientBuffer;
                added = true;
            }
            e.Index++;
        }
        return HResult.Ok;
    }
    public HResult GetPlaceholderInfoCallback(int commandId, string relativePath, uint pid, string procName)
    {
        string p = Full(relativePath);
        bool isDir = Directory.Exists(p);
        if (!isDir && !File.Exists(p)) return HResult.FileNotFound;
        FileSystemInfo fi = isDir ? (FileSystemInfo)new DirectoryInfo(p) : new FileInfo(p);
        byte[] id = new byte[128]; id[0] = 1;
        return inst.WritePlaceholderInfo(relativePath, fi.CreationTimeUtc, fi.LastAccessTimeUtc, fi.LastWriteTimeUtc, fi.LastWriteTimeUtc,
            fi.Attributes, isDir ? 0 : ((FileInfo)fi).Length, isDir, id, id);
    }
    public HResult GetFileDataCallback(int commandId, string relativePath, ulong byteOffset, uint length, Guid dataStreamId, byte[] contentId, byte[] providerId, uint pid, string procName)
    {
        string p = Full(relativePath);
        try
        {
            long size = new FileInfo(p).Length;
            ulong start = byteOffset & ~4095UL;                      // sector-aligned start
            ulong end = byteOffset + length;
            end = (end + 4095) & ~4095UL;
            if (end > (ulong)size) end = (ulong)size;                // the last write may end unaligned at the end of the file
            lock (this) { Requests++; BytesRequested += length; }
            Log("LECTURE " + relativePath + " demandé=" + byteOffset + "+" + length + " (processus " + procName + ")  taille fichier=" + size);
            using (FileStream fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                ulong pos = start;
                byte[] tmp = new byte[Chunk];
                while (pos < end)
                {
                    uint n = (uint)Math.Min((ulong)Chunk, end - pos);
                    fs.Seek((long)pos, SeekOrigin.Begin);
                    int got = 0; while (got < n) { int r = fs.Read(tmp, got, (int)n - got); if (r <= 0) break; got += r; }
                    if (got < n) return HResult.InternalError;
                    using (WriteBuffer wb = inst.CreateWriteBuffer(n))
                    {
                        wb.Stream.Seek(0, SeekOrigin.Begin); wb.Stream.Write(tmp, 0, (int)n);
                        HResult hr = inst.WriteFileData(dataStreamId, wb, pos, n);
                        if (hr != HResult.Ok) { Log("ERREUR écriture " + hr); return hr; }
                    }
                    lock (this) { BytesFetched += n; long v; PerFile.TryGetValue(relativePath, out v); PerFile[relativePath] = v + n; }
                    pos += n;
                }
            }
            return HResult.Ok;
        }
        catch (Exception ex) { Log("ERREUR " + ex.Message); return HResult.InternalError; }
    }
    public string Summary()
    {
        lock (this) return "demandes=" + Requests + "  demandé par Windows=" + (BytesRequested / 1048576) + " Mo  lu sur la cartouche=" + (BytesFetched / 1048576) + " Mo";
    }
    public List<string> Top()
    {
        List<string> l = new List<string>();
        lock (this) foreach (KeyValuePair<string, long> kv in PerFile) l.Add((kv.Value / 1048576).ToString().PadLeft(6) + " Mo  " + kv.Key);
        l.Sort(delegate (string a, string b) { return string.Compare(b, a, StringComparison.Ordinal); });
        return l;
    }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies $dll.FullName -Language CSharp

$prov = New-Object CcProvider($Source, $Root, $Journal)
$prov.Start()
Write-Host ""
Write-Host "Dossier virtuel prêt : $Root   (reflète $Source)" -ForegroundColor Green
Write-Host "Lance maintenant le jeu depuis ce dossier. Ctrl+C pour arrêter et voir le bilan." -ForegroundColor Green
Write-Host "Journal détaillé : $Journal"
try {
  while ($true) { Start-Sleep -Seconds 2; Write-Host ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $prov.Summary()) }
} finally {
  $prov.Stop()
  Write-Host ""; Write-Host "Bilan : $($prov.Summary())" -ForegroundColor Cyan
  Write-Host "Fichiers les plus lus :"; $prov.Top() | Select-Object -First 12 | ForEach-Object { Write-Host "  $_" }
}
