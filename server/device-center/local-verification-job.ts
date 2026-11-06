export const WINDOWS_VERIFICATION_SUPERVISOR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
public static class PiVerificationJob {
 [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT value,uint length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING value,uint length,IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int value);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SECURITY_ATTRIBUTES security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 static uint Active(IntPtr job) { ACCOUNTING value; Check(QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)); return value.ActiveProcesses; }
 static void Empty(IntPtr job) { var until=DateTime.UtcNow.AddSeconds(5); while(Active(job)!=0) { if(DateTime.UtcNow>until) throw new Exception("Job stop unconfirmed"); Thread.Sleep(10); } }
 public static void Run() {
  string receiptSecret=Console.In.ReadLine();
  if(receiptSecret==null || receiptSecret.Length!=64) Environment.Exit(126);
  string command=Environment.GetEnvironmentVariable("PI_LOCAL_VERIFICATION_COMMAND");
  string pipeName=Environment.GetEnvironmentVariable("PI_LOCAL_VERIFICATION_PIPE");
  Environment.SetEnvironmentVariable("PI_LOCAL_VERIFICATION_COMMAND",null);
  Environment.SetEnvironmentVariable("PI_LOCAL_VERIFICATION_PIPE",null);
  IntPtr job=IntPtr.Zero,nul=IntPtr.Zero; PROCESS_INFORMATION process=new PROCESS_INFORMATION(); bool assigned=false,confirmed=false; int result=125;
  try {
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
   var limits=new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway
   Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
   var security=new SECURITY_ATTRIBUTES(); security.nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); security.bInheritHandle=1;
   nul=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(nul!=new IntPtr(-1));
   var startup=new STARTUPINFO(); startup.cb=Marshal.SizeOf(typeof(STARTUPINFO)); startup.dwFlags=0x100; startup.hStdInput=nul; startup.hStdOutput=GetStdHandle(-11); startup.hStdError=GetStdHandle(-12);
   Check(SetHandleInformation(startup.hStdOutput,1,1)); Check(SetHandleInformation(startup.hStdError,1,1));
   Check(SetHandleInformation(GetStdHandle(-10),1,0)); // Private control input never enters the command's handle table.
   string shell=Environment.GetEnvironmentVariable("COMSPEC") ?? (Environment.GetEnvironmentVariable("SystemRoot")+"\\System32\\cmd.exe");
   Check(CreateProcess(shell,new StringBuilder("\""+shell+"\" /d /s /c \""+command+"\""),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out process));
   Check(AssignProcessToJobObject(job,process.hProcess)); assigned=true;
   Check(ResumeThread(process.hThread)!=0xffffffff);
   Task<string> stop=Task.Run(() => Console.In.ReadLine());
   bool cancelled=false;
   while(WaitForSingleObject(process.hProcess,10)!=0) {
    if(stop.IsCompleted) { Check(TerminateJobObject(job,130)); cancelled=true; break; }
   }
   uint code; Check(GetExitCodeProcess(process.hProcess,out code));
   result=cancelled ? 130 : unchecked((int)code);
   // A successful shell with surviving descendants is a failed command. Reap the whole job.
   if(!cancelled && Active(job)!=0) Thread.Sleep(20);
   if(Active(job)!=0) { if(!cancelled) result=1; Check(TerminateJobObject(job,(uint)result)); }
   Empty(job); confirmed=true;
  } catch {
   try {
    if(process.hProcess!=IntPtr.Zero && !assigned) { TerminateProcess(process.hProcess,125); Check(WaitForSingleObject(process.hProcess,5000)==0); }
    if(job!=IntPtr.Zero) { Check(TerminateJobObject(job,125)); Empty(job); }
    confirmed=true;
   } catch { confirmed=false; }
   result=125;
  } finally {
   if(process.hThread!=IntPtr.Zero) CloseHandle(process.hThread);
   if(process.hProcess!=IntPtr.Zero) CloseHandle(process.hProcess);
   if(nul!=IntPtr.Zero && nul!=new IntPtr(-1)) CloseHandle(nul);
   if(job!=IntPtr.Zero) CloseHandle(job);
  }
  if(confirmed) {
   try {
    using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.Out)) {
     pipe.Connect(2000);
     using(var writer=new StreamWriter(pipe,new UTF8Encoding(false))) { writer.WriteLine(receiptSecret+":"+result.ToString(System.Globalization.CultureInfo.InvariantCulture)); writer.Flush(); }
    }
   } catch { Environment.Exit(126); }
  }
  Environment.Exit(confirmed ? result : 126);
 }
}
'@
[PiVerificationJob]::Run()
`;
