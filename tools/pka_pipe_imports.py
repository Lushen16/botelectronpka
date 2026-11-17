"""Lista quais APIs de pipe cada binario importa."""
from pathlib import Path
import pefile

ROOT = Path(__file__).resolve().parent.parent
names = ["CreateNamedPipeW", "ConnectNamedPipe", "DisconnectNamedPipe", "CreateFileW",
         "ReadFile", "WriteFile", "ReadFileEx", "WriteFileEx", "PeekNamedPipe",
         "GetQueuedCompletionStatus", "CreateIoCompletionPort", "NtReadFile",
         "NtWriteFile", "TransactNamedPipe", "CallNamedPipe", "DeviceIoControl",
         "PostMessageW", "SendMessageW", "GetNamedPipeClientProcessId"]

for target in (ROOT / "dumps" / "payload_reconstructed.dll", ROOT / "native" / "pka_native.dll"):
    pe = pefile.PE(str(target))
    found = set()
    for entry in pe.DIRECTORY_ENTRY_IMPORT:
        for imp in entry.imports:
            if imp.name:
                found.add(imp.name.decode())
    print("==", target.name)
    for name in names:
        print(f"   {name:<32} {'SIM' if name in found else '-'}")
    print()
