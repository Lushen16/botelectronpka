Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class Locker {
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded,
        ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    public static void Check(string path) {
        uint handle;
        int res = RmStartSession(out handle, 0, Guid.NewGuid().ToString());
        if (res != 0) { Console.WriteLine("RmStartSession failed: " + res); return; }
        try {
            string[] files = new string[] { path };
            res = RmRegisterResources(handle, 1, files, 0, IntPtr.Zero, 0, null);
            if (res != 0) { Console.WriteLine("RmRegisterResources failed: " + res); return; }
            uint needed = 0;
            uint count = 0;
            uint reasons = 0;
            res = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (needed == 0) { Console.WriteLine("No lockers found"); return; }
            RM_PROCESS_INFO[] apps = new RM_PROCESS_INFO[needed];
            count = needed;
            res = RmGetList(handle, out needed, ref count, apps, ref reasons);
            for (int i = 0; i < count; i++) {
                Console.WriteLine("Locker: PID=" + apps[i].Process.dwProcessId + " AppName=" + apps[i].strAppName);
            }
        } finally {
            RmEndSession(handle);
        }
    }
}
"@

[Locker]::Check("C:\Users\yago\AppData\Local\ShibaLauncher\Apps\64eed53ddf85f863cf163e5d07c45c60\current\Shiba Bots - Poke Alliance v3.2.9\dll\resources\app.asar")
