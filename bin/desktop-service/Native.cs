using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class Native {
    [DllImport("kernel32.dll")] internal static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int impersonation,int type,out IntPtr duplicate);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int info,ref int value,int size);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out long luid);
    [StructLayout(LayoutKind.Sequential,Pack=1)] struct PRIVILEGE { public uint count; public long luid; public uint attributes; }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref PRIVILEGE value,int length,IntPtr previous,IntPtr needed);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUP {
        public int cb; public string reserved,desktop,title; public int x,y,width,height,xChars,yChars,fill,flags; public short show,reservedSize; public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUP startup,out PROCESS process);
    [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
    [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSQueryUserToken(uint session,out IntPtr token);
    [DllImport("userenv.dll",SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr environment,IntPtr token,bool inherit);
    [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern IntPtr OpenSCManager(string machine,string database,uint access);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern IntPtr OpenService(IntPtr manager,string name,uint access);
    [DllImport("advapi32.dll")] static extern bool QueryServiceStatusEx(IntPtr service,int info,byte[] buffer,int size,out int needed);
    [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref JOB value,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr minimum,maximum; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct JOB { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    static void Check(bool value) { if(!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    internal static void EnablePrivilege(string name) {
        IntPtr token; Check(OpenProcessToken(Process.GetCurrentProcess().Handle,0x28,out token));
        try { long id; Check(LookupPrivilegeValue(null,name,out id)); var p=new PRIVILEGE{count=1,luid=id,attributes=2}; Check(AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero)); if(Marshal.GetLastWin32Error()!=0) throw new IOException("Privilege unavailable: "+name); }
        finally { CloseHandle(token); }
    }
    internal static string SessionText(int session,int info) {
        IntPtr p; int bytes; Check(WTSQuerySessionInformation(IntPtr.Zero,session,info,out p,out bytes));
        try { return Marshal.PtrToStringUni(p)??""; } finally { WTSFreeMemory(p); }
    }
    internal static int SessionState(int session) {
        IntPtr p; int bytes; if(!WTSQuerySessionInformation(IntPtr.Zero,session,8,out p,out bytes)) return -1;
        try { return bytes>=4?Marshal.ReadInt32(p):-1; } finally { WTSFreeMemory(p); }
    }
    internal static uint ServiceProcessId(string name) {
        IntPtr manager=OpenSCManager(null,null,1); if(manager==IntPtr.Zero) throw new IOException("Cannot query desktop service");
        try {
            IntPtr service=OpenService(manager,name,4); if(service==IntPtr.Zero) throw new IOException("Desktop service is not installed");
            try { var bytes=new byte[36]; int needed; Check(QueryServiceStatusEx(service,0,bytes,bytes.Length,out needed)); if(BitConverter.ToInt32(bytes,4)!=4) throw new IOException("Desktop service is stopped"); return BitConverter.ToUInt32(bytes,28); }
            finally { CloseServiceHandle(service); }
        } finally { CloseServiceHandle(manager); }
    }
    internal sealed class Child : IDisposable {
        IntPtr job; Process process;
        public int Id { get { return process.Id; } }
        public bool HasExited { get { return process.HasExited; } }
        public Child(IntPtr handle,Process child) { job=handle; process=child; }
        public void Dispose() { if(job!=IntPtr.Zero) { try { process.WaitForExit(250); } catch {} CloseHandle(job); job=IntPtr.Zero; } process.Dispose(); }
    }
    // Only the protected, installer-verified encoder can run with desktop-service privileges.
    static readonly System.Collections.Generic.Dictionary<DesktopEncoderBuild,string> verifiedEncoders=new System.Collections.Generic.Dictionary<DesktopEncoderBuild,string>();
    internal static bool HasCompatibleEncoder() {
        string directory=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        return File.Exists(Path.Combine(directory,"ffmpeg-nvenc-compat.exe"))&&File.Exists(Path.Combine(directory,"encoder-nvenc-compat.sha256"));
    }
    internal static Child LaunchEncoder(string args,string desktop,IntPtr input,IntPtr output,IntPtr error,DesktopEncoderBuild build=DesktopEncoderBuild.Default) {
        string directory=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        if(build!=DesktopEncoderBuild.Default&&build!=DesktopEncoderBuild.NvidiaCompatible) throw new IOException("Invalid embedded encoder selection");
        string exe=Path.Combine(directory,build==DesktopEncoderBuild.NvidiaCompatible?"ffmpeg-nvenc-compat.exe":"ffmpeg.exe");
        string checksum=Path.Combine(directory,build==DesktopEncoderBuild.NvidiaCompatible?"encoder-nvenc-compat.sha256":"encoder.sha256");
        if(!verifiedEncoders.ContainsKey(build)) {
            using(var hash=System.Security.Cryptography.SHA256.Create())
            using(var file=File.OpenRead(exe)) {
                string actual=BitConverter.ToString(hash.ComputeHash(file)).Replace("-","");
                if(!String.Equals(actual,File.ReadAllText(checksum).Trim(),StringComparison.OrdinalIgnoreCase)) throw new IOException("Installed desktop encoder integrity check failed");
            }
            verifiedEncoders[build]=exe;
        }
        if(String.IsNullOrEmpty(desktop)||desktop.Length>128||desktop.IndexOfAny(new char[]{'\\','/','\0','"'})>=0) throw new IOException("Invalid input desktop");
        return Launch(Process.GetCurrentProcess().SessionId,verifiedEncoders[build],args,"winsta0\\"+desktop,input,output,error);
    }
    internal static Child Launch(int session,string exe,string args,string desktop="winsta0\\default",IntPtr input=default(IntPtr),IntPtr output=default(IntPtr),IntPtr error=default(IntPtr)) {
        return LaunchCore(session,exe,args,desktop,input,output,error,false);
    }
    internal static Child LaunchUserVideo(int session,string pipeName) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(pipeName,"^pi-web-ui-user-video-[a-f0-9]{32}$")) throw new IOException("Invalid user video pipe");
        return LaunchCore(session,System.Reflection.Assembly.GetExecutingAssembly().Location,"--user-video "+pipeName+" "+Process.GetCurrentProcess().Id,"winsta0\\default",IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,true);
    }
    static Child LaunchCore(int session,string exe,string args,string desktop,IntPtr input,IntPtr output,IntPtr error,bool asOwner) {
        IntPtr token=IntPtr.Zero,primary=IntPtr.Zero,job=IntPtr.Zero,environment=IntPtr.Zero; PROCESS child=new PROCESS(); bool launched=false;
        try {
            if(asOwner) {
                Check(WTSQueryUserToken((uint)session,out primary));
                using(var identity=new System.Security.Principal.WindowsIdentity(primary)) {
                    string owner=File.ReadAllText(Path.Combine(Path.GetDirectoryName(exe),"owner.sid")).Trim();
                    if(identity.User.Value!=owner) throw new UnauthorizedAccessException("User video desktop owner mismatch");
                }
                Check(CreateEnvironmentBlock(out environment,primary,false));
            } else {
                Check(OpenProcessToken(Process.GetCurrentProcess().Handle,0xF01FF,out token));
                Check(DuplicateTokenEx(token,0x02000000,IntPtr.Zero,2,1,out primary));
                Check(SetTokenInformation(primary,12,ref session,4));
            }
            job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new IOException("Cannot create worker job");
            var limits=new JOB(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(JOB))));
            bool redirected=output!=IntPtr.Zero;
            var startup=new STARTUP{cb=Marshal.SizeOf(typeof(STARTUP)),desktop=desktop,flags=redirected?0x100:0,input=input,output=output,error=error};
            Check(CreateProcessAsUser(primary,exe,new StringBuilder("\""+exe+"\" "+args),IntPtr.Zero,IntPtr.Zero,redirected,0x08000004|(asOwner?0x400u:0u),environment,Path.GetDirectoryName(exe),ref startup,out child));
            Check(AssignProcessToJobObject(job,child.process));
            if(ResumeThread(child.thread)==uint.MaxValue) throw new IOException("Cannot start desktop worker");
            var result=new Child(job,Process.GetProcessById((int)child.pid)); job=IntPtr.Zero; launched=true; return result;
        } finally {
            if(!launched&&child.process!=IntPtr.Zero) TerminateProcess(child.process,1);
            if(job!=IntPtr.Zero) CloseHandle(job);
            if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
            if(child.process!=IntPtr.Zero) CloseHandle(child.process);
            if(primary!=IntPtr.Zero) CloseHandle(primary);
            if(token!=IntPtr.Zero) CloseHandle(token);
            if(environment!=IntPtr.Zero) DestroyEnvironmentBlock(environment);
        }
    }
}
