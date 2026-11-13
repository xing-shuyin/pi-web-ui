using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// This binary is installed in an administrator-owned directory. Neither IPC mode accepts code or paths.
public sealed class PiDesktopService : ServiceBase {
    const string ServiceId="PiWebDesktop";
    static string Exe { get { return System.Reflection.Assembly.GetExecutingAssembly().Location; } }
    static string Owner { get { return new SecurityIdentifier(File.ReadAllText(Path.Combine(Path.GetDirectoryName(Exe),"owner.sid")).Trim()).Value; } }
    static string PipeName(string owner) { return "pi-web-ui-desktop-"+owner; }
    readonly object gate=new object();
    readonly HashSet<IDisposable> connections=new HashSet<IDisposable>();
    readonly SemaphoreSlim slots=new SemaphoreSlim(4);
    volatile bool stopping;
    string owner;
    public PiDesktopService() { ServiceName=ServiceId; CanStop=true; AutoLog=false; }
    protected override void OnStart(string[] args) {
        owner=Owner;
        Native.EnablePrivilege("SeTcbPrivilege");
        Native.EnablePrivilege("SeAssignPrimaryTokenPrivilege");
        Native.EnablePrivilege("SeIncreaseQuotaPrivilege");
        new Thread(Listen){IsBackground=true}.Start();
    }
    protected override void OnStop() {
        stopping=true;
        lock(gate) { foreach(var stream in connections) { try { stream.Dispose(); } catch {} } connections.Clear(); }
    }
    void Track(IDisposable stream) { lock(gate) { if(stopping) { stream.Dispose(); throw new IOException("Service stopped"); } connections.Add(stream); } }
    void Untrack(IDisposable stream) { lock(gate) connections.Remove(stream); }
    static NamedPipeServerStream ServerPipe(string name,string allowed,int instances) {
        var acl=new PipeSecurity(); acl.SetAccessRuleProtection(true,false);
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
        if(allowed!=null) acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(allowed),PipeAccessRights.ReadWrite,AccessControlType.Allow));
        return new NamedPipeServerStream(name,PipeDirection.InOut,instances,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,acl);
    }
    void Listen() {
        while(!stopping) {
            NamedPipeServerStream pipe=null;
            try {
                pipe=ServerPipe(PipeName(owner),owner,5); Track(pipe); pipe.WaitForConnection();
                var accepted=pipe; ThreadPool.QueueUserWorkItem(_=>Handle(accepted)); pipe=null;
            } catch { if(!stopping) Thread.Sleep(500); }
            finally { if(pipe!=null) { Untrack(pipe); pipe.Dispose(); } }
        }
    }
    void Handle(NamedPipeServerStream client) {
        bool acquired=false;
        try {
            uint pid;
            if(!Native.GetNamedPipeClientProcessId(client.SafePipeHandle.DangerousGetHandle(),out pid)) throw new IOException("Cannot identify client");
            string identity=null;
            client.RunAsClient(()=>identity=WindowsIdentity.GetCurrent().User.Value);
            if(identity!=owner) throw new UnauthorizedAccessException("Desktop owner mismatch");
            acquired=slots.Wait(0); if(!acquired) throw new IOException("Desktop connection limit reached");
            string mode;
            using(var deadline=new Timer(_=>client.Dispose(),null,10000,Timeout.Infinite)) mode=ReadLine(client,32);
            if(mode!="view"&&mode!="control"&&mode!="preview") throw new IOException("Invalid desktop mode");
            int callerSession=Process.GetProcessById((int)pid).SessionId;
            int session=SelectSession(callerSession,owner);
            var pipeName="pi-web-ui-capture-"+Guid.NewGuid().ToString("N");
            using(var worker=ServerPipe(pipeName,null,1)) {
                Track(worker);
                try {
                    using(var child=Native.Launch(session,Exe,"--worker "+pipeName+" "+mode)) {
                        var connected=worker.BeginWaitForConnection(null,null);
                        if(!connected.AsyncWaitHandle.WaitOne(15000)) throw new IOException("Desktop worker did not connect");
                        worker.EndWaitForConnection(connected); connected.AsyncWaitHandle.Close();
                        uint workerPid;
                        if(!Native.GetNamedPipeClientProcessId(worker.SafePipeHandle.DangerousGetHandle(),out workerPid)||workerPid!=child.Id) throw new IOException("Invalid capture worker");
                        var writer=new Thread(()=>{
                            try {
                                string line;
                                while((line=ReadLine(client,16384))!=null) {
                                    if(Allowed(line,mode=="control")) WriteLine(worker,line);
                                    else throw new IOException("Invalid desktop input");
                                }
                            } catch {} finally { try { worker.Dispose(); } catch {} try { client.Dispose(); } catch {} }
                        }){IsBackground=true};
                        writer.Start();
                        using(var monitor=new Timer(_=>{
                            try { if(stopping||SelectSession(callerSession,owner)!=session||child.HasExited) worker.Dispose(); }
                            catch { try { worker.Dispose(); } catch {} }
                        },null,1000,1000)) worker.CopyTo(client,65536);
                    }
                } finally { Untrack(worker); }
            }
        } catch(Exception e) { try { ErrorPacket(client,"WINDOWS_DESKTOP_UNAVAILABLE: "+e.Message); } catch {} }
        finally { Untrack(client); client.Dispose(); if(acquired) slots.Release(); }
    }
    static int SelectSession(int caller,string owner) {
        int session=Native.SessionState(caller)==0?caller:unchecked((int)Native.WTSGetActiveConsoleSessionId());
        if(session<=0) throw new IOException("No interactive Windows session");
        string user=Native.SessionText(session,5),domain=Native.SessionText(session,7);
        if(user.Length>0&&new NTAccount(domain,user).Translate(typeof(SecurityIdentifier)).Value!=owner) throw new UnauthorizedAccessException("A different user owns the active desktop");
        return session;
    }
    static bool Allowed(string line,bool control) {
        var json=new JavaScriptSerializer(){MaxJsonLength=16384,RecursionLimit=8};
        var e=json.Deserialize<Dictionary<string,object>>(line);
        if(e==null||!e.ContainsKey("type")||!(e["type"] is string)) return false;
        string type=(string)e["type"];
        if(type=="close"||type=="ack") return e.Count==1;
        if(type=="configure") return e.Count==4&&Number(e,"maxEdge",640,2560)&&Number(e,"quality",35,85)&&Number(e,"fps",5,240);
        if(type=="display") return e.Count==2&&e.ContainsKey("id")&&e["id"] is string&&((string)e["id"]).Length<=128&&((string)e["id"]).IndexOf('\0')<0;
        if(type=="displays") return e.Count==1;
        if(!control) return false;
        if(type=="release") return e.Count==1;
        if(type=="text") return e.Count==2&&e.ContainsKey("text")&&e["text"] is string&&((string)e["text"]).Length<=2048&&!((string)e["text"]).Contains("\0");
        if(type=="key") return e.Count==3&&e.ContainsKey("code")&&e["code"] is string&&System.Text.RegularExpressions.Regex.IsMatch((string)e["code"],"^[A-Za-z][A-Za-z0-9]{0,39}$")&&e.ContainsKey("action")&&(Equals(e["action"],"down")||Equals(e["action"],"up"));
        if(type=="wheel") return e.Count==2&&Number(e,"deltaY",-1200,1200);
        return type=="pointer"&&e.Count==5&&Number(e,"x",0,1)&&Number(e,"y",0,1)&&Number(e,"button",0,2)&&e.ContainsKey("action")&&(Equals(e["action"],"move")||Equals(e["action"],"down")||Equals(e["action"],"up"));
    }
    static bool Number(Dictionary<string,object> e,string key,double min,double max) {
        if(!e.ContainsKey(key)||(e[key] is string)||(e[key] is bool)||e[key]==null) return false;
        double n; try { n=Convert.ToDouble(e[key]); } catch { return false; }
        return !Double.IsNaN(n)&&!Double.IsInfinity(n)&&n>=min&&n<=max;
    }
    static string ReadLine(Stream stream,int max) {
        using(var data=new MemoryStream()) {
            int value; while((value=stream.ReadByte())!=-1) { if(value==10) return Encoding.UTF8.GetString(data.ToArray()); if(data.Length>=max) throw new IOException("Input exceeds limit"); data.WriteByte((byte)value); }
            return null;
        }
    }
    static void WriteLine(Stream stream,string line) { var bytes=Encoding.UTF8.GetBytes(line+"\n"); stream.Write(bytes,0,bytes.Length); stream.Flush(); }
    static byte[] ReadExact(Stream stream,int size) {
        var bytes=new byte[size]; int offset=0,count;
        while(offset<size&&(count=stream.Read(bytes,offset,size-offset))>0) offset+=count;
        if(offset!=size) throw new IOException("Desktop service connection closed; retrying after session change");
        return bytes;
    }
    static int Length(byte[] bytes) { return (bytes[0]<<24)|(bytes[1]<<16)|(bytes[2]<<8)|bytes[3]; }
    static void ErrorPacket(Stream stream,string message) {
        var bytes=Encoding.UTF8.GetBytes(message); int n=Math.Min(bytes.Length,8192);
        stream.Write(new byte[]{0,0,0,0,0,0,(byte)(n>>8),(byte)n},0,8); stream.Write(bytes,0,n); stream.Flush();
    }
    static void Client(string mode) {
        if(mode!="view"&&mode!="control"&&mode!="preview") throw new IOException("Invalid mode");
        using(var pipe=new NamedPipeClientStream(".",PipeName(WindowsIdentity.GetCurrent().User.Value),PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)) {
            pipe.Connect(5000); uint server;
            if(!Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out server)||server!=Native.ServiceProcessId(ServiceId)) throw new IOException("Invalid desktop service");
            WriteLine(pipe,mode);
            new Thread(()=>{
                try { string line; var input=Console.OpenStandardInput(); while((line=ReadLine(input,16384))!=null) WriteLine(pipe,line); }
                catch {} finally { pipe.Dispose(); }
            }){IsBackground=true}.Start();
            var output=Console.OpenStandardOutput();
            while(true) {
                var header=ReadExact(pipe,4); int n=Length(header);
                if(n==0) { int size=Length(ReadExact(pipe,4)); if(size<1||size>8192) throw new IOException("Invalid service error"); throw new IOException(Encoding.UTF8.GetString(ReadExact(pipe,size))); }
                if(n<4||n>4194304) throw new IOException("Invalid desktop frame");
                var frame=ReadExact(pipe,n); output.Write(header,0,4); output.Write(frame,0,n); output.Flush();
            }
        }
    }
    static void Worker(string pipeName,string mode) {
        if(!WindowsIdentity.GetCurrent().IsSystem||!System.Text.RegularExpressions.Regex.IsMatch(pipeName,"^pi-web-ui-capture-[a-f0-9]{32}$")) throw new UnauthorizedAccessException();
        using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous)) {
            pipe.Connect(10000);
            NativeDesktop.Run(mode!="control",mode=="preview",true,true,pipe,pipe,message=>ErrorPacket(pipe,message));
        }
    }
    public static int Main(string[] args) {
        try {
            if(args.Length==1&&args[0]=="--service") { ServiceBase.Run(new PiDesktopService()); return 0; }
            if(args.Length==2&&args[0]=="--client") { Client(args[1]); return 0; }
            if(args.Length==3&&args[0]=="--worker") { Worker(args[1],args[2]); return 0; }
            throw new IOException("Invalid desktop helper command");
        } catch(Exception e) { Console.Error.WriteLine("WINDOWS_DESKTOP_UNAVAILABLE: "+e.Message); return 1; }
    }
}
