using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Security.Principal;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// WGC activation is unavailable under LocalSystem on some Windows builds. Only
// ordinary-desktop capture/encoding moves to this read-only owner process. The
// authenticated SYSTEM worker retains input, secure desktops and stream lifetime.
internal static class DesktopUserVideo {
    static string Owner { get { return File.ReadAllText(Path.Combine(Path.GetDirectoryName(typeof(DesktopUserVideo).Assembly.Location),"owner.sid")).Trim(); } }
    sealed class State { public volatile bool Ended;public Exception Error;public long LastPacket,LastFrame; }
    static string Profile(NativeDesktop.VideoSettings s) { return new JavaScriptSerializer().Serialize(new {type="configure",maxEdge=s.Edge,quality=s.Quality,fps=s.Fps}); }
    static string Display(NativeDesktop.VideoSettings s) { return new JavaScriptSerializer().Serialize(new {type="display",id=s.DisplayId}); }
    static Dictionary<string,object> Message(string line,string expected) {
        if(line==null||!PiDesktopService.Allowed(line,false)) throw new IOException("Invalid user capture configuration");
        var value=new JavaScriptSerializer(){MaxJsonLength=16384,RecursionLimit=8}.Deserialize<Dictionary<string,object>>(line);
        if(!Equals(value["type"],expected)) throw new IOException("Unexpected user capture configuration");
        return value;
    }
    internal static void Worker(string name,string parent) {
        uint parentPid;
        using(var identity=WindowsIdentity.GetCurrent()) {
            if(identity.IsSystem||identity.User.Value!=Owner||!UInt32.TryParse(parent,out parentPid)||parentPid==0||!System.Text.RegularExpressions.Regex.IsMatch(name,"^pi-web-ui-user-video-[a-f0-9]{32}$")) throw new UnauthorizedAccessException("Invalid user capture identity");
        }
        using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)) {
            pipe.Connect(10000);uint actual;
            if(!Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out actual)||actual!=parentPid) throw new UnauthorizedAccessException("Invalid user capture parent");
            Dictionary<string,object> profile,display;
            using(var deadline=new Timer(_=>pipe.Dispose(),null,10000,Timeout.Infinite)) {
                profile=Message(PiDesktopService.ReadLine(pipe,16384),"configure");
                display=Message(PiDesktopService.ReadLine(pipe,16384),"display");
            }
            NativeDesktop.InitializeVideo((string)display["id"],Convert.ToInt32(profile["maxEdge"]),Convert.ToInt32(profile["quality"]),Convert.ToInt32(profile["fps"]));
            NativeDesktop.Run(true,false,true,false,pipe,pipe,message=>PiDesktopService.ErrorPacket(pipe,message),false,()=>{
                while(!NativeDesktop.VideoStopped) if(!DesktopHardware.StreamUser(NativeDesktop.ReadVideoSettings())) return;
            });
        }
    }
    static void Read(NamedPipeServerStream pipe,State state) {
        try {
            while(true) {
                int n=PiDesktopService.Length(PiDesktopService.ReadExact(pipe,4));
                if(n==0) {
                    int size=PiDesktopService.Length(PiDesktopService.ReadExact(pipe,4));
                    if(size<1||size>8192) throw new IOException("Invalid user capture error");
                    throw new IOException(Encoding.UTF8.GetString(PiDesktopService.ReadExact(pipe,size)));
                }
                if(n<1||n>4194314) throw new IOException("Invalid user capture packet size");
                var bytes=PiDesktopService.ReadExact(pipe,n);
                Forward(bytes);
                Interlocked.Exchange(ref state.LastPacket,DateTime.UtcNow.Ticks);
                if(bytes[0]==6) Interlocked.Exchange(ref state.LastFrame,DateTime.UtcNow.Ticks);
            }
        } catch(Exception error) { state.Error=error; } finally { state.Ended=true; }
    }
    // Treat all data from the lower-privilege process as untrusted. Never forward
    // commands, file paths, arbitrary metadata, raw images or unbounded allocations.
    internal static void Forward(byte[] bytes) {
        if(bytes==null||bytes.Length<1||bytes.Length>4194314) throw new IOException("Invalid user capture packet");
        if(bytes[0]==5&&bytes.Length==1) { NativeDesktop.VideoAlive();return; }
        if(bytes[0]==6&&bytes.Length>=11&&(bytes[1]&~3)==0) {
            ulong pts=0;for(int i=0;i<8;i++)pts=(pts<<8)|bytes[2+i];
            if(pts>long.MaxValue)throw new IOException("Invalid user capture timestamp");
            var data=new byte[bytes.Length-10];Buffer.BlockCopy(bytes,10,data,0,data.Length);
            NativeDesktop.VideoFrame(data,(bytes[1]&1)!=0,(bytes[1]&2)!=0,(long)pts);return;
        }
        if(bytes[0]=='{'&&bytes.Length<=16384) {
            var value=new JavaScriptSerializer(){MaxJsonLength=16384,RecursionLimit=8}.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes));
            object type,capture,codec,runtime;
            if(value==null||!value.TryGetValue("type",out type)||!Equals(type,"displays")||!value.TryGetValue("encoder",out codec))throw new IOException("Invalid user capture metadata");
            if(Equals(codec,"")) return; // Initial display enumeration, before the codec starts.
            if(!value.TryGetValue("capture",out capture)||!Equals(capture,"wgc")||!value.TryGetValue("encoderRuntime",out runtime)||!Equals(runtime,"native-d3d11")||!(Equals(codec,"h264_amf")||Equals(codec,"h264_nvenc")||Equals(codec,"h264_qsv")))throw new IOException("Invalid user capture backend");
            NativeDesktop.VideoBackend("wgc",(string)codec,"native-d3d11");return;
        }
        throw new IOException("Unsupported user capture packet");
    }
    internal static bool Stream(NativeDesktop.VideoSettings settings) {
        if(!String.Equals(settings.Desktop,"Default",StringComparison.OrdinalIgnoreCase))throw new IOException("User GPU capture requires the ordinary desktop");
        string name="pi-web-ui-user-video-"+Guid.NewGuid().ToString("N");
        using(var pipe=PiDesktopService.ServerPipe(name,Owner,1))
        using(var child=Native.LaunchUserVideo(Process.GetCurrentProcess().SessionId,name)) {
            var connected=pipe.BeginWaitForConnection(null,null);
            try { if(!connected.AsyncWaitHandle.WaitOne(10000))throw new IOException("User capture did not connect");pipe.EndWaitForConnection(connected); }
            finally { connected.AsyncWaitHandle.Close(); }
            uint pid;
            if(!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=child.Id)throw new UnauthorizedAccessException("Invalid user capture process");
            string identity=null;pipe.RunAsClient(()=>identity=WindowsIdentity.GetCurrent().User.Value);
            if(identity!=Owner)throw new UnauthorizedAccessException("User capture owner mismatch");
            PiDesktopService.WriteLine(pipe,Profile(settings));PiDesktopService.WriteLine(pipe,Display(settings));
            var state=new State();var reader=new Thread(()=>Read(pipe,state)){IsBackground=true};reader.Start();
            var clock=Stopwatch.StartNew();int generation=NativeDesktop.VideoGeneration;bool paused=!NativeDesktop.VideoPaused;
            try {
                while(!NativeDesktop.VideoStopped) {
                    var current=NativeDesktop.ReadVideoSettings();
                    if(!String.Equals(current.Desktop,settings.Desktop,StringComparison.OrdinalIgnoreCase))return true;
                    if(state.Ended||child.HasExited)throw state.Error??new IOException("User GPU capture stopped");
                    long last=Interlocked.Read(ref state.LastPacket);
                    if((last==0&&clock.ElapsedMilliseconds>6000)||(last!=0&&DateTime.UtcNow.Ticks-last>TimeSpan.FromSeconds(4).Ticks))throw new IOException("User GPU capture stopped responding");
                    if(!NativeDesktop.VideoPaused&&Interlocked.Read(ref state.LastFrame)==0&&clock.ElapsedMilliseconds>6000)throw new IOException("User GPU capture produced no frames");
                    if(current.Identity!=settings.Identity||current.DisplayId!=settings.DisplayId) {
                        PiDesktopService.WriteLine(pipe,Profile(current));PiDesktopService.WriteLine(pipe,Display(current));settings=current;
                    }
                    if(paused!=NativeDesktop.VideoPaused) { paused=NativeDesktop.VideoPaused;PiDesktopService.WriteLine(pipe,paused?"{\"type\":\"video_flow\",\"paused\":true}":"{\"type\":\"video_flow\",\"paused\":false}"); }
                    if(generation!=NativeDesktop.VideoGeneration) { generation=NativeDesktop.VideoGeneration;PiDesktopService.WriteLine(pipe,"{\"type\":\"video_keyframe\"}"); }
                    Thread.Sleep(40);
                }
                return false;
            } finally {
                pipe.Dispose();child.Dispose();
                if(!reader.Join(2000))throw new IOException("User video reader did not stop");
            }
        }
    }
}
