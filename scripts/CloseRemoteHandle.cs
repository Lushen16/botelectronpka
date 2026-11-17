using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class CloseRemoteHandle {
    const uint SystemExtendedHandleInformation = 64;
    const uint STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
    const uint FILE_TYPE_DISK = 1;

    [DllImport("ntdll.dll")]
    static extern uint NtQuerySystemInformation(uint SystemInformationClass, IntPtr SystemInformation, uint SystemInformationLength, out uint ReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool DuplicateHandle(IntPtr hSourceProcessHandle, IntPtr hSourceHandle, IntPtr hTargetProcessHandle, out IntPtr lpTargetHandle, uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, uint dwOptions);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetFileType(IntPtr hFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(IntPtr hFile, [Out] StringBuilder lpszFilePath, uint cchFilePath, uint dwFlags);

    const uint PROCESS_DUP_HANDLE = 0x0040;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const uint DUPLICATE_CLOSE_SOURCE = 0x00000001;

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX {
        public IntPtr Object;
        public IntPtr UniqueProcessId;
        public IntPtr HandleValue;
        public uint GrantedAccess;
        public ushort CreatorBackTraceIndex;
        public ushort ObjectTypeIndex;
        public uint HandleAttributes;
        public uint Reserved;
    }

    static void Main(string[] args) {
        if (args.Length < 2) {
            Console.WriteLine("Usage: CloseRemoteHandle <PID> <target_substring>");
            return;
        }

        int targetPid = int.Parse(args[0]);
        string targetSubstring = args[1].ToLowerInvariant();

        IntPtr hProcess = OpenProcess(PROCESS_DUP_HANDLE, false, targetPid);
        if (hProcess == IntPtr.Zero) {
            Console.WriteLine("Failed to OpenProcess for PID " + targetPid + ", error: " + Marshal.GetLastWin32Error());
            return;
        }

        int size = 0x10000;
        IntPtr info = Marshal.AllocHGlobal(size);
        uint length;

        while (NtQuerySystemInformation(SystemExtendedHandleInformation, info, (uint)size, out length) == STATUS_INFO_LENGTH_MISMATCH) {
            size = (int)length * 2;
            Marshal.FreeHGlobal(info);
            info = Marshal.AllocHGlobal(size);
        }

        long handleCount = Marshal.ReadInt64(info);
        Console.WriteLine("Total system handles: " + handleCount);

        IntPtr entryPtr = new IntPtr(info.ToInt64() + 16);
        int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));

        IntPtr currentProcess = new IntPtr(-1);

        int closedCount = 0;

        for (long i = 0; i < handleCount; i++) {
            SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX entry = (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(entryPtr, typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
            entryPtr = new IntPtr(entryPtr.ToInt64() + entrySize);

            if (entry.UniqueProcessId.ToInt64() != targetPid) continue;

            IntPtr hDup;
            if (DuplicateHandle(hProcess, entry.HandleValue, currentProcess, out hDup, 0, false, DUPLICATE_SAME_ACCESS)) {
                if (GetFileType(hDup) == FILE_TYPE_DISK) {
                    StringBuilder sb = new StringBuilder(1024);
                    uint res = GetFinalPathNameByHandle(hDup, sb, 1024, 0);
                    if (res > 0 && res < 1024) {
                        string path = sb.ToString().ToLowerInvariant();
                        if (path.Contains(targetSubstring)) {
                            Console.WriteLine("Found matching handle: " + entry.HandleValue + " Path: " + path);
                            IntPtr dummy;
                            if (DuplicateHandle(hProcess, entry.HandleValue, IntPtr.Zero, out dummy, 0, false, DUPLICATE_CLOSE_SOURCE)) {
                                Console.WriteLine("SUCCESS: Closed handle in PID " + targetPid);
                                closedCount++;
                            } else {
                                Console.WriteLine("Failed DUPLICATE_CLOSE_SOURCE: " + Marshal.GetLastWin32Error());
                            }
                        }
                    }
                }
                CloseHandle(hDup);
            }
        }

        CloseHandle(hProcess);
        Marshal.FreeHGlobal(info);
        Console.WriteLine("Done! Closed handles count: " + closedCount);
    }
}
