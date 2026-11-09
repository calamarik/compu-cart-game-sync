# Compu-Cart safe eject. $Lettre is prepended by core.cjs (validated D-Z).
# Output (stdout, one line): OK | BUSY | VETO:<type>:<name> | ERR:<message>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CcEject {
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
  const uint FSCTL_LOCK_VOLUME = 0x00090018, FSCTL_DISMOUNT_VOLUME = 0x00090020;
  const uint IOCTL_STORAGE_MEDIA_REMOVAL = 0x002D4804;
  const uint IOCTL_STORAGE_GET_DEVICE_NUMBER = 0x002D1080;
  const uint DIGCF_PRESENT = 0x2, DIGCF_DEVICEINTERFACE = 0x10;

  [StructLayout(LayoutKind.Sequential)]
  struct STORAGE_DEVICE_NUMBER { public uint DeviceType; public uint DeviceNumber; public uint PartitionNumber; }
  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVINFO_DATA { public uint cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVICE_INTERFACE_DATA { public uint cbSize; public Guid InterfaceClassGuid; public uint Flags; public IntPtr Reserved; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FlushFileBuffers(SafeFileHandle h);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, IntPtr enumerator, IntPtr parent, uint flags);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr devInfo, ref Guid classGuid, uint index, ref SP_DEVICE_INTERFACE_DATA data);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SetupDiGetDeviceInterfaceDetailW")]
  static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, uint size, out uint required, ref SP_DEVINFO_DATA info);
  [DllImport("setupapi.dll", SetLastError = true)]
  static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("cfgmgr32.dll")]
  static extern int CM_Get_Parent(out uint parent, uint devInst, uint flags);
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Request_Device_EjectW")]
  static extern int CM_Request_Device_Eject(uint devInst, out int vetoType, StringBuilder vetoName, int nameLength, uint flags);

  static uint DeviceNumber(SafeFileHandle h, out uint deviceType) {
    int size = Marshal.SizeOf(typeof(STORAGE_DEVICE_NUMBER));
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      uint ret;
      if (!DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, IntPtr.Zero, 0, buf, (uint)size, out ret, IntPtr.Zero))
        throw new Exception("Numéro de périphérique illisible (" + Marshal.GetLastWin32Error() + ")");
      STORAGE_DEVICE_NUMBER n = (STORAGE_DEVICE_NUMBER)Marshal.PtrToStructure(buf, typeof(STORAGE_DEVICE_NUMBER));
      deviceType = n.DeviceType;
      return n.DeviceNumber;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static uint FindDiskDevInst(uint number) {
    Guid disk = new Guid("53f56307-b6bf-11d0-94f2-00a0c91efb8b");
    IntPtr set = SetupDiGetClassDevs(ref disk, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set == IntPtr.Zero || set == new IntPtr(-1)) return 0;
    try {
      for (uint i = 0; ; i++) {
        SP_DEVICE_INTERFACE_DATA data = new SP_DEVICE_INTERFACE_DATA();
        data.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref disk, i, ref data)) return 0;
        SP_DEVINFO_DATA info = new SP_DEVINFO_DATA();
        info.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
        uint required;
        SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out required, ref info);
        if (required == 0) continue;
        IntPtr detail = Marshal.AllocHGlobal((int)required);
        try {
          Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
          if (!SetupDiGetDeviceInterfaceDetail(set, ref data, detail, required, out required, ref info)) continue;
          string devicePath = Marshal.PtrToStringUni(IntPtr.Add(detail, 4));
          using (SafeFileHandle h = CreateFile(devicePath, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero)) {
            if (h.IsInvalid) continue;
            uint type;
            try { if (DeviceNumber(h, out type) == number) return info.DevInst; } catch { }
          }
        } finally { Marshal.FreeHGlobal(detail); }
      }
    } finally { SetupDiDestroyDeviceInfoList(set); }
  }

  public static string Eject(string letter) {
    string volume = "\\\\.\\" + letter + ":";
    uint number, type;
    using (SafeFileHandle probe = CreateFile(volume, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero)) {
      if (probe.IsInvalid) return "ERR:Lecteur " + letter + ": introuvable";
      number = DeviceNumber(probe, out type);
    }
    // 1) Flush, then lock (fails if a program still has files open), then dismount.
    using (SafeFileHandle h = CreateFile(volume, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero)) {
      if (h.IsInvalid) return "ERR:Accès au lecteur refusé (" + Marshal.GetLastWin32Error() + ")";
      FlushFileBuffers(h);
      uint ret;
      bool locked = false;
      for (int i = 0; i < 20 && !locked; i++) {
        locked = DeviceIoControl(h, FSCTL_LOCK_VOLUME, IntPtr.Zero, 0, IntPtr.Zero, 0, out ret, IntPtr.Zero);
        if (!locked) Thread.Sleep(250);
      }
      if (!locked) return "BUSY";
      if (!DeviceIoControl(h, FSCTL_DISMOUNT_VOLUME, IntPtr.Zero, 0, IntPtr.Zero, 0, out ret, IntPtr.Zero))
        return "ERR:Démontage impossible (" + Marshal.GetLastWin32Error() + ")";
      IntPtr allow = Marshal.AllocHGlobal(1);
      try { Marshal.WriteByte(allow, 0); DeviceIoControl(h, IOCTL_STORAGE_MEDIA_REMOVAL, allow, 1, IntPtr.Zero, 0, out ret, IntPtr.Zero); }
      finally { Marshal.FreeHGlobal(allow); }
    }
    // 2) Ask Windows to remove the device (same as "Retirer le périphérique en toute sécurité").
    uint diskInst = FindDiskDevInst(number);
    if (diskInst == 0) return "VETO:0:périphérique introuvable";
    uint parent;
    uint[] targets = CM_Get_Parent(out parent, diskInst, 0) == 0 ? new uint[] { parent, diskInst } : new uint[] { diskInst };
    int vetoType = 0;
    string vetoName = "";
    for (int attempt = 0; attempt < 3; attempt++) {
      foreach (uint target in targets) {
        StringBuilder sb = new StringBuilder(260);
        int cr = CM_Request_Device_Eject(target, out vetoType, sb, sb.Capacity, 0);
        if (cr == 0 && vetoType == 0) return "OK";
        vetoName = sb.ToString();
      }
      Thread.Sleep(500);
    }
    return "VETO:" + vetoType + ":" + vetoName;
  }
}
'@
  [Console]::Out.WriteLine([CcEject]::Eject($Lettre))
} catch {
  [Console]::Out.WriteLine('ERR:' + $_.Exception.Message)
}
