using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Drawing;
using System.Runtime.InteropServices;

// Pixels stay inside the native encoder. The service transports bounded Annex-B chunks only.
internal static class DesktopVideo {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct OutputDesc {
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Name;
        public Rect Bounds; public int Attached,Rotation; public IntPtr Monitor;
    }
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory(ref Guid id,out IntPtr factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Enumerate(IntPtr self,uint index,out IntPtr item);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Describe(IntPtr self,out OutputDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int AdapterDescription(IntPtr self,IntPtr desc);
    static T Method<T>(IntPtr p,int slot) where T:class { return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(p),slot*IntPtr.Size),typeof(T)) as T; }
    static void Drop(ref IntPtr p) { if(p!=IntPtr.Zero) { Marshal.Release(p); p=IntPtr.Zero; } }
    sealed class Output { public int Adapter,Index,Vendor; }
    static string HardwareCodec(int vendor) { return vendor==0x10de?"h264_nvenc":vendor==0x8086?"h264_qsv":vendor==0x1002?"h264_amf":null; }
    static string[] HardwareCodecs() {
        var codecs=new System.Collections.Generic.List<string>();
        IntPtr factory=IntPtr.Zero,adapter=IntPtr.Zero,data=Marshal.AllocHGlobal(512);
        try {
            var id=new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"); Marshal.ThrowExceptionForHR(CreateDXGIFactory(ref id,out factory));
            for(uint a=0;a<16;a++) {
                if(Method<Enumerate>(factory,7)(factory,a,out adapter)<0) break;
                if(Method<AdapterDescription>(adapter,8)(adapter,data)>=0) {
                    string codec=HardwareCodec(Marshal.ReadInt32(data,256));
                    if(codec!=null&&!codecs.Contains(codec)) codecs.Add(codec);
                }
                Drop(ref adapter);
            }
        } catch {} finally { Marshal.FreeHGlobal(data); Drop(ref adapter); Drop(ref factory); }
        // RustDesk's hwcodec discovery tests encoders, not only visible DXGI adapters. Remote or
        // protected sessions may hide adapter identities while a vendor runtime remains usable.
        foreach(string codec in new string[]{"h264_nvenc","h264_qsv","h264_amf","h264_mf"}) if(!codecs.Contains(codec)) codecs.Add(codec);
        return codecs.ToArray();
    }
    // Windows DISPLAY numbers are not DXGI output indices (especially across multiple GPUs).
    static Output FindOutput(Rectangle bounds) {
        IntPtr factory=IntPtr.Zero,adapter=IntPtr.Zero,output=IntPtr.Zero;
        try {
            var id=new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
            Marshal.ThrowExceptionForHR(CreateDXGIFactory(ref id,out factory));
            for(uint a=0;a<16;a++) {
                if(Method<Enumerate>(factory,7)(factory,a,out adapter)<0) break;
                for(uint o=0;o<32;o++) {
                    if(Method<Enumerate>(adapter,7)(adapter,o,out output)<0) break;
                    OutputDesc desc;
                    int result=Method<Describe>(output,7)(output,out desc); Drop(ref output);
                    if(result>=0&&desc.Attached!=0&&desc.Rotation==1&&desc.Bounds.Left==bounds.Left&&desc.Bounds.Top==bounds.Top&&desc.Bounds.Right-desc.Bounds.Left==bounds.Width&&desc.Bounds.Bottom-desc.Bounds.Top==bounds.Height) {
                        IntPtr data=Marshal.AllocHGlobal(512);
                        try { Marshal.ThrowExceptionForHR(Method<AdapterDescription>(adapter,8)(adapter,data)); return new Output{Adapter=(int)a,Index=(int)o,Vendor=Marshal.ReadInt32(data,256)}; }
                        finally { Marshal.FreeHGlobal(data); }
                    }
                }
                Drop(ref adapter);
            }
        } catch { /* Protected, rotated or unsupported outputs use native GDI capture. */ }
        finally { Drop(ref output); Drop(ref adapter); Drop(ref factory); }
        return null;
    }
    sealed class Candidate { public Output Output; public string Codec; public bool Readback,DirectTexture; public DesktopEncoderBuild Build; public string Backend { get { return Output==null?"gdi":"dxgi"; } } }
    static Candidate[] Candidates(NativeDesktop.VideoSettings settings) {
        var values=new System.Collections.Generic.List<Candidate>();
        var output=FindOutput(settings.Bounds);
        var hardware=new System.Collections.Generic.List<string>(HardwareCodecs());
        // RustDesk get_encoder_cfg: VRAM hardware -> RAM hardware -> software. A display missing
        // from DXGI (RDP/secure desktop) must not hide otherwise usable hardware encoders.
        if(output!=null) {
            string preferred=HardwareCodec(output.Vendor);
            if(preferred!=null) {
                hardware.Remove(preferred); hardware.Insert(0,preferred);
                if(preferred=="h264_nvenc"&&Math.Max(settings.Bounds.Width,settings.Bounds.Height)<=settings.Edge)
                    values.Add(new Candidate{Output=output,Codec=preferred,DirectTexture=true});
                values.Add(new Candidate{Output=output,Codec=preferred});
            }
            values.Add(new Candidate{Output=output,Codec="h264_mf"});
            foreach(string codec in hardware) values.Add(new Candidate{Output=output,Codec=codec,Readback=true});
        }
        foreach(string codec in hardware) values.Add(new Candidate{Codec=codec});
        if(output!=null) values.Add(new Candidate{Output=output,Codec="libx264"});
        values.Add(new Candidate{Codec="libx264"});
        var resolved=new System.Collections.Generic.List<Candidate>();
        var nvidiaApi=DesktopEncoder.NvidiaApiVersion();
        bool compatible=Native.HasCompatibleEncoder();
        foreach(var candidate in values) {
            foreach(var build in DesktopEncoder.Builds(candidate.Codec,nvidiaApi,compatible)) resolved.Add(new Candidate{Output=candidate.Output,Codec=candidate.Codec,Readback=candidate.Readback,DirectTexture=candidate.DirectTexture,Build=build});
        }
        return resolved.ToArray();
    }
    static string Args(NativeDesktop.VideoSettings s,Candidate c) {
        var b=s.Bounds; double scale=Math.Min(1,(double)s.Edge/Math.Max(b.Width,b.Height));
        int w=Math.Max(2,(int)(b.Width*scale)/2*2),h=Math.Max(2,(int)(b.Height*scale)/2*2);
        int bitrate=(int)((s.Edge>=2400?14000000:s.Edge>=1700?9000000:s.Edge>=1200?5000000:2500000)*Math.Max(0.6,Math.Min(1.25,s.Quality/70.0))*(s.Fps>=90?1.4:1));
        string args="-hide_banner -loglevel error -nostdin -flags low_delay -filter_threads 2 -filter_complex_threads 2 -probesize 32 -analyzeduration 0 ";
        string filter;
        if(c.Output!=null) {
            // A lavfi input creates a separate device and ignores filter_hw_device. Keep the
            // capture source in the filter graph so the selected monitor's adapter is used.
            args+="-init_hw_device d3d11va=capture:"+c.Output.Adapter+" -filter_hw_device capture -filter_complex ddagrab=output_idx="+c.Output.Index+":framerate="+s.Fps+":draw_mouse=1:dup_frames=1:output_fmt=bgra";
            if(c.DirectTexture) filter="";
            else if(c.Codec=="libx264"||c.Readback) {
                filter="hwdownload,format=bgra,scale="+w+":"+h+":flags=fast_bilinear,format="+(c.Codec=="libx264"?"yuv420p":"nv12,hwupload");
            } else filter="scale_d3d11=width="+w+":height="+h+":format=nv12";
            // D3D11 NVENC sessions require texture input; CPU frames must be uploaded again.
            // This preserves DXGI capture when the driver's GPU video processor is unavailable.
            if(c.Codec=="h264_qsv") filter+=",hwmap=derive_device=qsv";
            if(filter.Length>0) args+=","+filter;
            args+=" ";
        } else {
            args+="-r "+s.Fps+" -f gdigrab -framerate "+s.Fps+" -draw_mouse 1 -offset_x "+b.Left+" -offset_y "+b.Top+" -video_size "+b.Width+"x"+b.Height+" -i desktop ";
            filter="scale="+w+":"+h+":flags=fast_bilinear,format=yuv420p";
            args+="-vf "+filter+" ";
        }
        // gdigrab timestamps use microseconds; never let the muxer turn that timebase into a
        // million-FPS CFR stream by synthesizing duplicate pictures. Preserve capture timing.
        args+="-an -enc_time_base 1:"+s.Fps+" -fps_mode passthrough -c:v "+c.Codec+" ";
        if(c.Codec=="h264_nvenc") args+="-preset p1 -tune ull -rc cbr -zerolatency 1 ";
        else if(c.Codec=="h264_qsv") args+="-preset veryfast -async_depth 1 -look_ahead 0 ";
        else if(c.Codec=="h264_amf") args+="-usage ultralowlatency -quality speed ";
        else if(c.Codec=="h264_mf") args+="-hw_encoding 1 -scenario display_remoting -rate_control cbr ";
        else args+="-preset ultrafast -tune zerolatency -threads "+Math.Min(8,Environment.ProcessorCount)+" -x264-params repeat-headers=1:aud=1:scenecut=0 ";
        // AUDs delimit pictures without waiting for the next full encoded frame.
        string metadata="h264_metadata=aud=insert";
        if(c.Output!=null&&c.Build==DesktopEncoderBuild.NvidiaCompatible&&!c.DirectTexture&&!c.Readback&&c.Codec!="libx264")
            metadata+=":matrix_coefficients=1:video_full_range_flag=0";
        // A half-second VBV permits large periodic IDRs that block the ordered WAN
        // stream. Budget 100 ms, retaining the requested average bitrate and FPS.
        return args+"-b:v "+bitrate+" -maxrate "+bitrate+" -bufsize "+(bitrate/10)+" -g "+s.Fps+" -bf 0 -bsf:v "+metadata+" -flush_packets 1 -f h264 pipe:1";
    }
    static IntPtr ClientHandle(AnonymousPipeServerStream pipe) { return new IntPtr(Int64.Parse(pipe.GetClientHandleAsString())); }
    sealed class StreamState { public long LastOutput; public volatile bool Ended; public string Error=""; }
    // Returns true for profile/desktop changes, false when the backend fails before/after output.
    static bool Stream(NativeDesktop.VideoSettings settings,Candidate candidate,out bool produced,out string reason) {
        var state=new StreamState(); int generation=NativeDesktop.VideoGeneration;
        using(var output=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable))
        using(var error=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable))
        using(var input=new AnonymousPipeServerStream(PipeDirection.Out,HandleInheritability.Inheritable))
        using(var child=Native.LaunchEncoder(Args(settings,candidate),settings.Desktop,ClientHandle(input),ClientHandle(output),ClientHandle(error),candidate.Build)) {
            output.DisposeLocalCopyOfClientHandle(); error.DisposeLocalCopyOfClientHandle(); input.DisposeLocalCopyOfClientHandle(); input.Dispose();
            var reader=new Thread(()=>{
                try {
                    var bytes=new byte[65536]; int n; bool first=true;
                    while(!NativeDesktop.VideoStopped&&(n=output.Read(bytes,0,bytes.Length))>0) {
                        NativeDesktop.VideoChunk(bytes,n,first); first=false;
                        Interlocked.Exchange(ref state.LastOutput,DateTime.UtcNow.Ticks);
                    }
                } catch {} finally { state.Ended=true; }
            }){IsBackground=true};
            var errors=new Thread(()=>{
                try { var bytes=new byte[1024]; int n; while((n=error.Read(bytes,0,bytes.Length))>0) { lock(state) { state.Error+=Encoding.UTF8.GetString(bytes,0,n); if(state.Error.Length>4096) state.Error=state.Error.Substring(state.Error.Length-4096); } } } catch {}
            }){IsBackground=true};
            NativeDesktop.VideoBackend(candidate.Backend,candidate.Codec,DesktopEncoder.Label(candidate.Build));
            reader.Start(); errors.Start();
            long start=DateTime.UtcNow.Ticks; bool changed=false;
            try {
                while(!NativeDesktop.VideoStopped&&!state.Ended&&!child.HasExited) {
                    Thread.Sleep(100);
                    if(NativeDesktop.ReadVideoSettings().Identity!=settings.Identity||generation!=NativeDesktop.VideoGeneration) { changed=true; break; }
                    long last=Interlocked.Read(ref state.LastOutput);
                    if(DateTime.UtcNow.Ticks-(last==0?start:last)>TimeSpan.FromSeconds(last==0?4:8).Ticks) break;
                }
            } finally {
                child.Dispose();
                // Never let a stalled writer from the old encoder interleave a replacement stream.
                if(!reader.Join(2000)) throw new IOException("Desktop video consumer stopped responding.");
                errors.Join(1000);
            }
            produced=Interlocked.Read(ref state.LastOutput)!=0;
            lock(state) reason=state.Error.Trim();
            return changed;
        }
    }
    internal static void Run(bool nativeAllowed=false) {
        Candidate preferred=null; string previousDesktop=null; int failures=0; bool nativeFailed=false;
        while(!NativeDesktop.VideoStopped) {
            var settings=NativeDesktop.ReadVideoSettings();
            string desktop=settings.Desktop+settings.Bounds.ToString();
            if(desktop!=previousDesktop) { preferred=null; failures=0; nativeFailed=false; previousDesktop=desktop; NativeDesktop.VideoFallback(""); }
            if(nativeAllowed&&!nativeFailed&&DesktopHardware.Available) {
                try { if(DesktopHardware.Stream(settings)) continue; return; }
                catch(Exception error) { nativeFailed=true; NativeDesktop.VideoFallback("native-d3d11: "+error.Message,true); }
            }
            if(preferred!=null&&preferred.DirectTexture&&Math.Max(settings.Bounds.Width,settings.Bounds.Height)>settings.Edge) preferred=null;
            var candidates=preferred==null?Candidates(settings):new Candidate[]{preferred};
            bool restart=false,dxgiStalled=false;
            string reason="Native desktop encoder did not produce video.";
            foreach(var candidate in candidates) {
                // Some display/driver states stall DDA before its first frame. Trying every
                // encoder on that same capture would repeat the full timeout and look black.
                if(dxgiStalled&&candidate.Output!=null) continue;
                bool produced; string error;
                bool changed=Stream(settings,candidate,out produced,out error);
                if(NativeDesktop.VideoStopped) return;
                if(changed) { if(produced) preferred=candidate; restart=true; failures=0; break; }
                if(error.Length>0) reason=error;
                if(!produced&&error.Length==0&&candidate.Output!=null) dxgiStalled=true;
                NativeDesktop.VideoFallback(candidate.Backend+" / "+candidate.Codec+" / "+DesktopEncoder.Label(candidate.Build)+": "+(error.Length>0?error:"Native encoder exited or produced no video before its deadline."),true);
                // A partial failed stream is replaced by a fresh encoder starting with SPS/PPS + IDR.
            }
            if(restart) continue;
            if(preferred!=null) { preferred=null; continue; }
            if(++failures>=2) throw new IOException(reason);
            Thread.Sleep(250);
        }
    }
}
