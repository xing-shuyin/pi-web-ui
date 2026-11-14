using System;
using System.IO;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;

// The built-in FFmpeg adapter owns hardware encoding and D3D11 conversion. This adapter
// keeps pi's authenticated service/session/input boundary and never accepts a DLL path.
internal static class DesktopHardware {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string name,IntPtr file,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr Open(IntPtr device,int width,int height,int kbps,int fps);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void Packet(IntPtr bytes,int size,int key,IntPtr opaque,long pts);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Encode(IntPtr encoder,IntPtr texture,Packet callback,IntPtr opaque,long pts);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Configure(IntPtr encoder,int kbps,int fps);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void Close(IntPtr encoder);
    static IntPtr module; static Open open; static Encode encode; static Configure configure; static Close close;
    static T Symbol<T>(string name) where T:class {
        IntPtr p=GetProcAddress(module,name); if(p==IntPtr.Zero) throw new IOException("Missing desktop codec entry point");
        return Marshal.GetDelegateForFunctionPointer(p,typeof(T)) as T;
    }
    internal static bool Available {
        get {
            string directory=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            return Environment.Is64BitProcess&&File.Exists(Path.Combine(directory,"pi-desktop-codec.dll"))&&File.Exists(Path.Combine(directory,"codec.sha256"));
        }
    }
    static void Load() {
        if(module!=IntPtr.Zero) return;
        string directory=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), path=Path.Combine(directory,"pi-desktop-codec.dll");
        using(var hash=System.Security.Cryptography.SHA256.Create()) using(var file=File.OpenRead(path)) {
            string actual=BitConverter.ToString(hash.ComputeHash(file)).Replace("-","");
            if(!String.Equals(actual,File.ReadAllText(Path.Combine(directory,"codec.sha256")).Trim(),StringComparison.OrdinalIgnoreCase)) throw new IOException("Desktop codec integrity check failed");
        }
        module=LoadLibraryEx(path,IntPtr.Zero,0x00000900); // DLL directory + System32 only
        if(module==IntPtr.Zero) throw new IOException("Cannot load embedded hardware codec: "+Marshal.GetLastWin32Error());
        open=Symbol<Open>("pi_codec_open"); encode=Symbol<Encode>("pi_codec_encode"); configure=Symbol<Configure>("pi_codec_configure"); close=Symbol<Close>("pi_codec_close");
    }
    static int Bitrate(NativeDesktop.VideoSettings s) {
        return (int)((s.Edge>=2400?14000:s.Edge>=1700?9000:s.Edge>=1200?5000:2500)*Math.Max(0.6,Math.Min(1.25,s.Quality/70.0))*(s.Fps>=90?1.4:1));
    }
    internal static bool Stream(NativeDesktop.VideoSettings settings) {
        try { return StreamCore(settings,true,false); }
        catch(UserCaptureRequired) {
            try { return DesktopUserVideo.Stream(settings); }
            catch(Exception error) {
                NativeDesktop.VideoFallback("User GPU capture: "+error.Message,true);
                return StreamCore(NativeDesktop.ReadVideoSettings(),false,false);
            }
        }
    }
    internal static bool StreamUser(NativeDesktop.VideoSettings settings) { return StreamCore(settings,false,true); }
    sealed class UserCaptureRequired : Exception {}
    static bool StreamCore(NativeDesktop.VideoSettings settings,bool allowUser,bool wgcOnly) {
        Load();
        using(var awake=new DisplayWake()) using(var capture=new TextureCapture(settings.Bounds,String.Equals(settings.Desktop,"Default",StringComparison.OrdinalIgnoreCase),allowUser,wgcOnly)) using(var timer=new FrameTimer()) {
            double scale=Math.Min(1,(double)settings.Edge/Math.Max(settings.Bounds.Width,settings.Bounds.Height));
            int width=Math.Max(2,(int)(settings.Bounds.Width*scale)/2*2),height=Math.Max(2,(int)(settings.Bounds.Height*scale)/2*2);
            IntPtr encoder=open(capture.Device,width,height,Bitrate(settings),settings.Fps);
            if(encoder==IntPtr.Zero) throw new IOException("Native hardware encoder probe failed");
            bool first=true; Exception failure=null;
            Packet packet=(bytes,size,key,opaque,pts)=>{
                try {
                    if(size<1||size>4*1024*1024) throw new IOException("Invalid native access unit");
                    byte[] data=new byte[size]; Marshal.Copy(bytes,data,0,size);
                    NativeDesktop.VideoFrame(data,key!=0,first,pts); first=false;
                } catch(Exception e) { failure=e; }
            };
            try {
                NativeDesktop.VideoBackend(capture.Backend,capture.Codec,"native-d3d11");
                var clock=Stopwatch.StartNew(); double next=0; long heartbeat=0,waitingSince=0; int generation=NativeDesktop.VideoGeneration;
                while(!NativeDesktop.VideoStopped) {
                    var current=NativeDesktop.ReadVideoSettings();
                    if(current.Desktop!=settings.Desktop||current.Bounds!=settings.Bounds||current.Edge!=settings.Edge||generation!=NativeDesktop.VideoGeneration) return true;
                    if(current.Fps!=settings.Fps||current.Quality!=settings.Quality) {
                        if(configure(encoder,Bitrate(current),current.Fps)!=0) return true;
                        settings=current; next=clock.Elapsed.TotalMilliseconds;
                    }
                    if(clock.ElapsedMilliseconds-heartbeat>=500) { NativeDesktop.VideoAlive(); heartbeat=clock.ElapsedMilliseconds; }
                    if(NativeDesktop.VideoPaused) { timer.Wait(4); next=clock.Elapsed.TotalMilliseconds; continue; }
                    double now=clock.Elapsed.TotalMilliseconds;
                    if(now<next) { timer.Wait(next-now); continue; }
                    bool updated=capture.Read(texture=>{
                        if(encode(encoder,texture,packet,IntPtr.Zero,clock.ElapsedMilliseconds)!=0) throw new IOException("Native hardware encoder failed");
                    });
                    if(failure!=null) throw failure;
                    // Keep the cadence on a fixed timeline. Starting a fresh interval
                    // after every late surface accumulates polling/scheduler jitter.
                    if(updated||capture.IsGdi) next=Math.Max(next+1000.0/settings.Fps,clock.Elapsed.TotalMilliseconds);
                    else {
                        if(first&&clock.ElapsedMilliseconds-waitingSince>1500) {
                            capture.UseCompatible();waitingSince=clock.ElapsedMilliseconds;
                            NativeDesktop.VideoBackend(capture.Backend,capture.Codec,"native-d3d11");
                        }
                        timer.Wait(1);
                    }
                }
                return false;
            } finally { close(encoder); GC.KeepAlive(packet); }
        }
    }
    // Desktop duplication can stop producing surfaces when the console display sleeps.
    // Like RustDesk's Windows WakeLock, hold a per-thread request only while streaming;
    // this neither changes power-plan settings nor unlocks the Windows session.
    sealed class DisplayWake : IDisposable {
        [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
        uint previous=SetThreadExecutionState(0x80000003);
        public void Dispose() { if(previous!=0) { SetThreadExecutionState(previous|0x80000000); previous=0; } }
    }
    sealed class FrameTimer : IDisposable {
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWaitableTimerEx(IntPtr attributes,string name,uint flags,uint access);
        [DllImport("kernel32.dll")] static extern bool SetWaitableTimer(IntPtr timer,ref long due,int period,IntPtr routine,IntPtr argument,bool resume);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        IntPtr handle=CreateWaitableTimerEx(IntPtr.Zero,null,2,0x1f0003);
        public void Wait(double milliseconds) {
            if(handle!=IntPtr.Zero) { long due=-(long)Math.Max(1,milliseconds*10000); if(SetWaitableTimer(handle,ref due,0,IntPtr.Zero,IntPtr.Zero,false)) { WaitForSingleObject(handle,100); return; } }
            Thread.Sleep(Math.Max(1,(int)Math.Ceiling(milliseconds)));
        }
        public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
    }
    // Same adapter must own capture and encoding. Enumerate all adapters, including
    // secondary GPUs; DISPLAYn is not a DXGI index. Mouse-only/idle events aren't video frames.
    sealed class TextureCapture : IDisposable {
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct OutputDesc { [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Name; public Rect Bounds; public int Attached,Rotation; public IntPtr Monitor; }
        [StructLayout(LayoutKind.Sequential)] struct FrameInfo { public long Present,Mouse; public uint Frames; public int Coalesced,Protected,X,Y,Visible; public uint Metadata,PointerBytes; }
        [StructLayout(LayoutKind.Sequential)] struct TextureDesc { public uint Width,Height,Mips,Array,Format,Samples,SampleQuality,Usage,Bind,Cpu,Misc; }
        [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid guid,out IntPtr factory);
        [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter,int driver,IntPtr software,uint flags,IntPtr levels,uint count,uint sdk,out IntPtr device,out int level,out IntPtr context);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Enumerate(IntPtr self,uint index,out IntPtr result);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Describe(IntPtr self,out OutputDesc desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DescribeAdapter(IntPtr self,IntPtr desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Duplicate(IntPtr self,IntPtr device,out IntPtr result);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Acquire(IntPtr self,uint timeout,out FrameInfo info,out IntPtr resource);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Release(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void DescribeTexture(IntPtr self,out TextureDesc desc);
        static T Method<T>(IntPtr self,int slot) where T:class { return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self),slot*IntPtr.Size),typeof(T)) as T; }
        static IntPtr Query(IntPtr p,string id) { IntPtr value; var guid=new Guid(id); Marshal.ThrowExceptionForHR(Marshal.QueryInterface(p,ref guid,out value)); return value; }
        static void Drop(ref IntPtr p) { if(p!=IntPtr.Zero) { Marshal.Release(p); p=IntPtr.Zero; } }
        IntPtr device,context,duplication,monitor; Rectangle bounds; bool first=true,wgcTried; readonly bool allowWgc; GdiTexture gdi; DesktopWgc wgc;
        Acquire acquire; Release release; DescribeTexture describeTexture;
        public IntPtr Device { get { return device; } }
        public string Codec { get; private set; }
        public bool IsGdi { get { return gdi!=null; } }
        public string Backend { get { return IsGdi?"gdi":wgc!=null?"wgc":"dxgi"; } }
        public void UseCompatible() {
            if(allowWgc&&!wgcTried) {
                wgcTried=true;
                bool system;using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())system=identity.IsSystem;
                if(system&&allowUser) throw new UserCaptureRequired();
                if(!system&&DesktopWgc.TryCreate(device,context,monitor,bounds.Width,bounds.Height,out wgc)) {
                    Drop(ref duplication);NativeDesktop.VideoFallback("DXGI unavailable; using WGC GPU capture with RustDesk hardware encoding.",true);return;
                }
            }
            if(wgc!=null) { wgc.Dispose();wgc=null; }
            if(wgcOnly) throw new IOException("WGC could not produce GPU frames in the user session");
            if(gdi==null) { gdi=new GdiTexture(device,context,bounds);Drop(ref duplication); }
            NativeDesktop.VideoFallback("GPU capture unavailable; using GDI capture with RustDesk GPU conversion and hardware encoding.",true);
        }
        readonly bool allowUser,wgcOnly;
        public TextureCapture(Rectangle target,bool allowWgc,bool allowUser,bool wgcOnly) {
            bounds=target;this.allowWgc=allowWgc;this.allowUser=allowUser;this.wgcOnly=wgcOnly; IntPtr factory=IntPtr.Zero,adapter=IntPtr.Zero,output=IntPtr.Zero,output1=IntPtr.Zero,data=Marshal.AllocHGlobal(512);
            try {
                var guid=new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref guid,out factory));
                for(uint a=0;a<16;a++) {
                    if(Method<Enumerate>(factory,12)(factory,a,out adapter)<0) break;
                    for(uint o=0;o<32;o++) {
                        if(Method<Enumerate>(adapter,7)(adapter,o,out output)<0) break;
                        OutputDesc desc; Marshal.ThrowExceptionForHR(Method<Describe>(output,7)(output,out desc));
                        if(desc.Attached!=0&&desc.Rotation==1&&desc.Bounds.Left==target.Left&&desc.Bounds.Top==target.Top&&desc.Bounds.Right==target.Right&&desc.Bounds.Bottom==target.Bottom) {
                            monitor=desc.Monitor;
                            int level; Marshal.ThrowExceptionForHR(D3D11CreateDevice(adapter,0,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out device,out level,out context));
                            Marshal.ThrowExceptionForHR(Method<DescribeAdapter>(adapter,8)(adapter,data));
                            int vendor=Marshal.ReadInt32(data,256); Codec=vendor==0x10de?"h264_nvenc":vendor==0x8086?"h264_qsv":vendor==0x1002?"h264_amf":"unknown";
                            if(wgcOnly) { UseCompatible();return; }
                            output1=Query(output,"00cddea8-939b-4b83-a340-a685226666cc");
                            int result=Method<Duplicate>(output1,22)(output1,device,out duplication);
                            if(result<0) {
                                UseCompatible();
                                return;
                            }
                            acquire=Method<Acquire>(duplication,8); release=Method<Release>(duplication,14);
                            return;
                        }
                        Drop(ref output);
                    }
                    Drop(ref adapter);
                }
                throw new IOException("No compatible unrotated DXGI output");
            } catch { Dispose(); throw; }
            finally { Marshal.FreeHGlobal(data); Drop(ref output1); Drop(ref output); Drop(ref adapter); Drop(ref factory); }
        }
        public bool Read(Action<IntPtr> consume) {
            if(gdi!=null) return gdi.Read(consume);
            if(wgc!=null) return wgc.Read(consume);
            IntPtr resource=IntPtr.Zero,texture=IntPtr.Zero; bool acquired=false;
            try {
                FrameInfo info; int hr=acquire(duplication,0,out info,out resource);
                if(hr==unchecked((int)0x887A0027)) return false;
                Marshal.ThrowExceptionForHR(hr); acquired=true;
                if(!first&&(info.Present==0||info.Frames==0)) return false;
                texture=Query(resource,"6f15aaf2-d208-4e89-9ab4-489535d34f9c"); if(describeTexture==null) describeTexture=Method<DescribeTexture>(texture,10); TextureDesc desc; describeTexture(texture,out desc);
                if(desc.Width!=bounds.Width||desc.Height!=bounds.Height||desc.Format!=87) throw new IOException("Desktop texture changed");
                consume(texture); first=false; return true;
            } finally { Drop(ref texture); Drop(ref resource); if(acquired) release(duplication); }
        }
        public void Dispose() { if(wgc!=null) { wgc.Dispose();wgc=null; } if(gdi!=null) { gdi.Dispose(); gdi=null; } Drop(ref duplication); Drop(ref context); Drop(ref device); }
        // RustDesk also falls back when desktop duplication cannot produce a surface.
        // Keep hardware encoding: capture into a reusable DIB, upload BGRA once, then
        // let hwcodec do scaling/color conversion on the same GPU. No FFmpeg raw pipe.
        sealed class GdiTexture : IDisposable {
            [StructLayout(LayoutKind.Sequential)] struct BitmapInfo { public uint Size; public int Width,Height; public ushort Planes,Bits; public uint Compression,ImageSize; public int XPels,YPels; public uint Used,Important; }
            [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
            [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window,IntPtr dc);
            [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
            [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc,ref BitmapInfo info,uint usage,out IntPtr bits,IntPtr section,uint offset);
            [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
            [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
            [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
            [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst,int x,int y,int width,int height,IntPtr src,int sx,int sy,uint mode);
            [DllImport("gdi32.dll")] static extern bool GdiFlush();
            [DllImport("msvcrt.dll",CallingConvention=CallingConvention.Cdecl)] static extern int memcmp(IntPtr left,IntPtr right,UIntPtr size);
            [DllImport("kernel32.dll",EntryPoint="RtlMoveMemory")] static extern void CopyMemory(IntPtr dst,IntPtr src,UIntPtr size);
            [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self,ref TextureDesc desc,IntPtr initial,out IntPtr texture);
            [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UpdateTexture(IntPtr self,IntPtr texture,uint subresource,IntPtr box,IntPtr data,uint rowPitch,uint depthPitch);
            readonly Rectangle bounds; readonly IntPtr context; readonly UIntPtr bytes; readonly UpdateTexture upload;
            IntPtr screen,dc,bitmap,old,bits,previous,texture; bool initial=true;
            public GdiTexture(IntPtr device,IntPtr context,Rectangle bounds) {
                this.bounds=bounds; this.context=context;
                long size=(long)bounds.Width*bounds.Height*4;
                if(bounds.Width<1||bounds.Height<1||size>64*1024*1024) throw new IOException("Desktop exceeds native GDI texture limit");
                bytes=new UIntPtr((uint)size);
                try {
                    screen=GetDC(IntPtr.Zero); if(screen==IntPtr.Zero) throw new IOException("Cannot open desktop DC");
                    dc=CreateCompatibleDC(screen); if(dc==IntPtr.Zero) throw new IOException("Cannot create capture DC");
                    var info=new BitmapInfo{Size=40,Width=bounds.Width,Height=-bounds.Height,Planes=1,Bits=32};
                    bitmap=CreateDIBSection(screen,ref info,0,out bits,IntPtr.Zero,0);
                    if(bitmap==IntPtr.Zero||bits==IntPtr.Zero) throw new IOException("Cannot create desktop surface");
                    old=SelectObject(dc,bitmap); if(old==IntPtr.Zero||old==new IntPtr(-1)) throw new IOException("Cannot select desktop surface");
                    previous=Marshal.AllocHGlobal((int)size);
                    var desc=new TextureDesc{Width=(uint)bounds.Width,Height=(uint)bounds.Height,Mips=1,Array=1,Format=87,Samples=1,Bind=0x28};
                    Marshal.ThrowExceptionForHR(Method<CreateTexture>(device,5)(device,ref desc,IntPtr.Zero,out texture));
                    upload=Method<UpdateTexture>(context,48);
                } catch { Dispose(); throw; }
            }
            public bool Read(Action<IntPtr> consume) {
                if(!BitBlt(dc,0,0,bounds.Width,bounds.Height,screen,bounds.Left,bounds.Top,0x40cc0020)||!GdiFlush()) throw new IOException("Cannot capture desktop surface");
                if(!initial&&memcmp(bits,previous,bytes)==0) return false;
                upload(context,texture,0,IntPtr.Zero,bits,(uint)bounds.Width*4,0);
                consume(texture);
                CopyMemory(previous,bits,bytes); initial=false; return true;
            }
            public void Dispose() {
                Drop(ref texture);
                if(previous!=IntPtr.Zero) { Marshal.FreeHGlobal(previous); previous=IntPtr.Zero; }
                if(old!=IntPtr.Zero&&old!=new IntPtr(-1)&&dc!=IntPtr.Zero) { SelectObject(dc,old); old=IntPtr.Zero; }
                if(bitmap!=IntPtr.Zero) { DeleteObject(bitmap); bitmap=IntPtr.Zero; }
                if(dc!=IntPtr.Zero) { DeleteDC(dc); dc=IntPtr.Zero; }
                if(screen!=IntPtr.Zero) { ReleaseDC(IntPtr.Zero,screen); screen=IntPtr.Zero; }
            }
        }
    }
}
