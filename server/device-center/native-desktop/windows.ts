export const windowsDesktopScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
using System.Web.Script.Serialization;
public static class NativeDesktop {
  // A persistent top-down DIB avoids GDI+ creating/copying a device bitmap on every frame.
  sealed class CaptureSurface : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfo { public uint Size; public int Width,Height; public ushort Planes,Bits; public uint Compression,ImageSize; public int X,Y; public uint Used,Important,Color; }
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window,IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc,ref BitmapInfo info,uint usage,out IntPtr bits,IntPtr section,uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc,IntPtr value);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll",SetLastError=true)] static extern bool BitBlt(IntPtr target,int x,int y,int width,int height,IntPtr source,int sourceX,int sourceY,uint operation);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    IntPtr screen,dc,bitmap,previous;
    public Bitmap Picture;
    public CaptureSurface(int width,int height) {
      try {
        screen=GetDC(IntPtr.Zero); dc=CreateCompatibleDC(screen);
        if(screen==IntPtr.Zero||dc==IntPtr.Zero) throw new Exception("Cannot create desktop surface.");
        var info=new BitmapInfo {Size=40,Width=width,Height=-height,Planes=1,Bits=32}; IntPtr pixels;
        bitmap=CreateDIBSection(screen,ref info,0,out pixels,IntPtr.Zero,0);
        if(bitmap==IntPtr.Zero||pixels==IntPtr.Zero) throw new Exception("Cannot allocate desktop surface.");
        previous=SelectObject(dc,bitmap);
        if(previous==IntPtr.Zero||previous==new IntPtr(-1)) throw new Exception("Cannot select desktop surface.");
        Picture=new Bitmap(width,height,width*4,PixelFormat.Format32bppRgb,pixels);
      } catch { Dispose(); throw; }
    }
    public void Read(int x,int y) {
      if(!BitBlt(dc,0,0,Picture.Width,Picture.Height,screen,x,y,0x40CC0020)) throw new Exception("Cannot copy desktop pixels: "+Marshal.GetLastWin32Error());
      // Required before the encoder or DXGI accesses DIB memory outside GDI.
      GdiFlush();
    }
    public void Dispose() {
      if(dc!=IntPtr.Zero&&previous!=IntPtr.Zero&&previous!=new IntPtr(-1)) SelectObject(dc,previous);
      if(bitmap!=IntPtr.Zero) { DeleteObject(bitmap); bitmap=IntPtr.Zero; }
      if(dc!=IntPtr.Zero) { DeleteDC(dc); dc=IntPtr.Zero; }
      if(screen!=IntPtr.Zero) { ReleaseDC(IntPtr.Zero,screen); screen=IntPtr.Zero; }
    }
  }
  // Desktop Duplication supplies fresh GPU frames; secure/unsupported desktops retain GDI fallback.
  sealed class Duplication : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct OutputDesc {
      [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Name;
      public Rect Bounds; public int Attached,Rotation; public IntPtr Monitor;
    }
    [StructLayout(LayoutKind.Sequential)] struct TextureDesc { public uint Width,Height,Mips,Array,Format,Samples,SampleQuality,Usage,Bind,Cpu,Misc; }
    [StructLayout(LayoutKind.Sequential)] struct FrameInfo { public long Present,Mouse; public uint Frames; public int Coalesced,Protected,X,Y,Visible; public uint Metadata,PointerBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Mapped { public IntPtr Data; public uint RowPitch,DepthPitch; }
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter,int driver,IntPtr software,uint flags,IntPtr levels,uint count,uint sdk,out IntPtr device,out int level,out IntPtr context);
    [DllImport("kernel32.dll",EntryPoint="RtlMoveMemory")] static extern void CopyMemory(IntPtr destination,IntPtr source,UIntPtr bytes);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetAdapter(IntPtr self,out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumOutput(IntPtr self,uint index,out IntPtr output);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DescribeOutput(IntPtr self,out OutputDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Duplicate(IntPtr self,IntPtr device,out IntPtr duplication);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Acquire(IntPtr self,uint timeout,out FrameInfo info,out IntPtr resource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ReleaseFrame(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void DescribeTexture(IntPtr self,out TextureDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self,ref TextureDesc desc,IntPtr data,out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResource(IntPtr self,IntPtr destination,IntPtr source);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Map(IntPtr self,IntPtr resource,uint subresource,int mode,uint flags,out Mapped mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Unmap(IntPtr self,IntPtr resource,uint subresource);
    static T Method<T>(IntPtr pointer,int slot) where T:class { return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(pointer),slot*IntPtr.Size),typeof(T)) as T; }
    static IntPtr Query(IntPtr pointer,string id) { var guid=new Guid(id); IntPtr result; Marshal.ThrowExceptionForHR(Marshal.QueryInterface(pointer,ref guid,out result)); return result; }
    static void Drop(ref IntPtr pointer) { if(pointer!=IntPtr.Zero) { Marshal.Release(pointer); pointer=IntPtr.Zero; } }
    IntPtr device,context,duplication,staging;
    Acquire acquire; ReleaseFrame release; CreateTexture create; CopyResource copy; Map map; Unmap unmap;
    public Duplication(Rectangle bounds) {
      IntPtr dxgi=IntPtr.Zero,adapter=IntPtr.Zero,output=IntPtr.Zero,output1=IntPtr.Zero;
      try {
        int level; Marshal.ThrowExceptionForHR(D3D11CreateDevice(IntPtr.Zero,1,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out device,out level,out context));
        dxgi=Query(device,"54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        Marshal.ThrowExceptionForHR(Method<GetAdapter>(dxgi,7)(dxgi,out adapter));
        for(uint index=0;index<32;index++) {
          if(Method<EnumOutput>(adapter,7)(adapter,index,out output)<0) break;
          OutputDesc desc; Marshal.ThrowExceptionForHR(Method<DescribeOutput>(output,7)(output,out desc));
          if(desc.Attached!=0 && desc.Rotation==1 && desc.Bounds.Left==bounds.Left && desc.Bounds.Top==bounds.Top && desc.Bounds.Right-desc.Bounds.Left==bounds.Width && desc.Bounds.Bottom-desc.Bounds.Top==bounds.Height) {
            output1=Query(output,"00cddea8-939b-4b83-a340-a685226666cc");
            Marshal.ThrowExceptionForHR(Method<Duplicate>(output1,22)(output1,device,out duplication)); break;
          }
          Drop(ref output);
        }
        if(duplication==IntPtr.Zero) throw new Exception("No compatible primary output.");
        acquire=Method<Acquire>(duplication,8); release=Method<ReleaseFrame>(duplication,14);
        create=Method<CreateTexture>(device,5); copy=Method<CopyResource>(context,47); map=Method<Map>(context,14); unmap=Method<Unmap>(context,15);
      } catch { Dispose(); throw; }
      finally { Drop(ref output1); Drop(ref output); Drop(ref adapter); Drop(ref dxgi); }
    }
    public bool Read(Bitmap bitmap) {
      IntPtr resource=IntPtr.Zero,texture=IntPtr.Zero; bool acquired=false,mapped=false; BitmapData bits=null;
      try {
        FrameInfo info; int hr=acquire(duplication,0,out info,out resource);
        if(hr==unchecked((int)0x887A0027)) return false;
        Marshal.ThrowExceptionForHR(hr); acquired=true;
        texture=Query(resource,"6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        TextureDesc desc; Method<DescribeTexture>(texture,10)(texture,out desc);
        if(desc.Width!=bitmap.Width||desc.Height!=bitmap.Height||desc.Format!=87) throw new Exception("Desktop surface changed.");
        if(staging==IntPtr.Zero) { desc.Mips=1;desc.Array=1;desc.Usage=3;desc.Bind=0;desc.Cpu=0x20000;desc.Misc=0;desc.Samples=1;desc.SampleQuality=0; Marshal.ThrowExceptionForHR(create(device,ref desc,IntPtr.Zero,out staging)); }
        copy(context,staging,texture);
        Mapped data; Marshal.ThrowExceptionForHR(map(context,staging,0,1,0,out data)); mapped=true;
        if(data.RowPitch<(uint)bitmap.Width*4) throw new Exception("Invalid desktop stride.");
        bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.WriteOnly,PixelFormat.Format32bppRgb);
        for(int y=0;y<bitmap.Height;y++) CopyMemory(IntPtr.Add(bits.Scan0,y*bits.Stride),IntPtr.Add(data.Data,checked(y*(int)data.RowPitch)),(UIntPtr)(bitmap.Width*4));
        return true;
      } finally {
        if(bits!=null) bitmap.UnlockBits(bits);
        if(mapped) unmap(context,staging,0);
        Drop(ref texture); Drop(ref resource); if(acquired) release(duplication);
      }
    }
    public void Dispose() { Drop(ref staging); Drop(ref duplication); Drop(ref context); Drop(ref device); }
  }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT m; [FieldOffset(0)] public KEYBDINPUT k; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] input, int size);
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr data,out int size);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [ThreadStatic] static IntPtr attachedDesktop;
  [ThreadStatic] static string attachedName;
  static bool systemDesktop;
  static Stream inputStream, outputStream;
  static Action<string> reportError;
  sealed class Display { public string Id; public Rectangle Bounds; public bool Primary; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct MonitorInfo { public int Size,Left,Top,Right,Bottom,WorkLeft,WorkTop,WorkRight,WorkBottom,Flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Device; }
  delegate bool MonitorCallback(IntPtr monitor,IntPtr dc,IntPtr rect,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorCallback callback,IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
  static Display[] displays=new Display[0];
  static string selectedDisplay="";
  static volatile bool reportDisplayMetadata=false;
  static string captureBackend="gdi";
  static string videoEncoder="";
  static string videoEncoderRuntime="default";
  static string videoFallback="";
  static Display CurrentDisplay() {
    foreach(var display in displays) if(display.Id==selectedDisplay) return display;
    foreach(var display in displays) if(display.Primary) return display;
    return displays.Length>0?displays[0]:new Display{Id="primary",Bounds=new Rectangle(0,0,GetSystemMetrics(0),GetSystemMetrics(1)),Primary=true};
  }
  static Rectangle Bounds() { lock(gate) return CurrentDisplay().Bounds; }
  static readonly object outputGate=new object();
  static void SendPacket(byte[] bytes) { lock(outputGate) { int n=bytes.Length; byte[] h={(byte)(n>>24),(byte)(n>>16),(byte)(n>>8),(byte)n}; outputStream.Write(h,0,4); outputStream.Write(bytes,0,n); outputStream.Flush(); } }
  public sealed class VideoSettings {
    public Rectangle Bounds; public int Edge,Quality,Fps; public string Desktop,DisplayId;
    public string Identity { get { return Bounds.ToString()+":"+Edge+":"+Quality+":"+Fps+":"+Desktop; } }
  }
  public static bool VideoStopped { get { return stopped; } }
  static DateTime videoDisplaysAt=DateTime.MinValue;
  public static VideoSettings ReadVideoSettings() {
    RequireDesktop(); if((DateTime.UtcNow-videoDisplaysAt).TotalSeconds>=1) { ReportDisplays(); videoDisplaysAt=DateTime.UtcNow; }
    lock(gate) return new VideoSettings{Bounds=Bounds(),Edge=maxEdge,Quality=quality,Fps=fps,Desktop=attachedName,DisplayId=selectedDisplay};
  }
  public static void InitializeVideo(string display,int edge,int q,int rate) {
    if(display==null||display.Length>128||display.IndexOf('\0')>=0||edge<640||edge>2560||q<35||q>85||rate<5||rate>240) throw new Exception("Invalid initial video profile.");
    lock(gate) { selectedDisplay=display;maxEdge=edge;quality=q;fps=rate;reportDisplayMetadata=true; }
  }
  public static void VideoBackend(string backend,string encoder,string runtime="default") { captureBackend=backend; videoEncoder=encoder; videoEncoderRuntime=runtime; ReportDisplays(); }
  public static void VideoFallback(string reason,bool append=false) { int line=reason.IndexOfAny(new char[]{'\r','\n'}); if(line>=0) reason=reason.Substring(0,line); if(reason.Length>160) reason=reason.Substring(0,160); videoFallback=append&&videoFallback.Length>0?videoFallback+"\n"+reason:reason; if(videoFallback.Length>1024) videoFallback=videoFallback.Substring(0,1024); ReportDisplays(); }
  public static void VideoChunk(byte[] bytes,int size,bool reset) {
    if(size<1||size>65536) throw new Exception("Invalid encoded desktop chunk.");
    byte[] packet=new byte[size+2]; packet[0]=4; packet[1]=reset?(byte)1:(byte)0; Buffer.BlockCopy(bytes,0,packet,2,size); SendPacket(packet);
  }
  public static void VideoFrame(byte[] bytes,bool key,bool reset,long pts) {
    if(bytes.Length<1||bytes.Length>4*1024*1024||pts<0) throw new Exception("Invalid native video frame.");
    byte[] packet=new byte[bytes.Length+10]; packet[0]=6; packet[1]=(byte)((key?1:0)|(reset?2:0));
    for(int i=0;i<8;i++) packet[2+i]=(byte)((ulong)pts>>(56-8*i));
    Buffer.BlockCopy(bytes,0,packet,10,bytes.Length); SendPacket(packet);
  }
  public static void VideoAlive() { SendPacket(new byte[]{5}); }
  static volatile bool videoPaused;
  public static bool VideoPaused { get { return videoPaused; } }
  static int videoGeneration;
  public static int VideoGeneration { get { return Interlocked.CompareExchange(ref videoGeneration,0,0); } }
  static void ReportDisplays() {
    var items=new List<Display>();
    EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,(monitor,dc,rect,data)=>{var info=new MonitorInfo();info.Size=Marshal.SizeOf(info);if(GetMonitorInfo(monitor,ref info)&&info.Right>info.Left&&info.Bottom>info.Top)items.Add(new Display{Id=info.Device,Bounds=Rectangle.FromLTRB(info.Left,info.Top,info.Right,info.Bottom),Primary=(info.Flags&1)!=0});return items.Count<32;},IntPtr.Zero);
    lock(gate) {
      displays=items.ToArray(); var selected=CurrentDisplay(); selectedDisplay=selected.Id;
      if(displays.Length==0) displays=new Display[]{selected};
      var values=new List<object>(); foreach(var display in displays) values.Add(new {id=display.Id,width=display.Bounds.Width,height=display.Bounds.Height,primary=display.Primary});
      if(reportDisplayMetadata) SendPacket(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new {type="displays",displays=values,selected=selected.Id,capture=captureBackend,encoder=videoEncoder,encoderRuntime=videoEncoderRuntime,fallback=videoFallback})));
    }
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int size,out int needed);
  static void RequireDesktop() {
    if(systemDesktop) {
      IntPtr current=OpenInputDesktop(0,false,0x01ff);
      if(current==IntPtr.Zero) throw new Exception("WINDOWS_DESKTOP_UNAVAILABLE: Input desktop is switching.");
      var currentName=new StringBuilder(256); int length;
      if(!GetUserObjectInformation(current,2,currentName,512,out length)) { CloseDesktop(current); throw new Exception("Cannot identify input desktop."); }
      if(attachedName==currentName.ToString()) { CloseDesktop(current); return; }
      if(!SetThreadDesktop(current)) { CloseDesktop(current); throw new Exception("Cannot attach input desktop: "+Marshal.GetLastWin32Error()); }
      if(attachedDesktop!=IntPtr.Zero) CloseDesktop(attachedDesktop);
      attachedDesktop=current; attachedName=currentName.ToString(); return;
    }
    int session; using(var process=System.Diagnostics.Process.GetCurrentProcess()) session=process.SessionId;
    if(session==0) throw new Exception("WINDOWS_SESSION_ZERO: No interactive user desktop.");
    IntPtr data; int size;
    if(WTSQuerySessionInformation(IntPtr.Zero,session,8,out data,out size)) {
      try { if(size>=4 && Marshal.ReadInt32(data)==4) throw new Exception("WINDOWS_SESSION_DISCONNECTED: The Windows user session is disconnected."); }
      finally { WTSFreeMemory(data); }
    }
    IntPtr desktop=OpenInputDesktop(0,false,1);
    if(desktop==IntPtr.Zero) throw new Exception("WINDOWS_DESKTOP_UNAVAILABLE: Cannot access the input desktop.");
    try {
      var name=new StringBuilder(256); int needed;
      if(!GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed) || !String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))
        throw new Exception("WINDOWS_DESKTOP_UNAVAILABLE: The interactive desktop is locked or protected.");
      attachedName=name.ToString();
    } finally { CloseDesktop(desktop); }
  }
  static readonly object gate = new object();
  static readonly HashSet<int> keys = new HashSet<int>();
  static readonly HashSet<int> buttons = new HashSet<int>();
  static readonly AutoResetEvent ack = new AutoResetEvent(false);
  static volatile bool stopped;
  static bool preview,rawFrames;
  static int maxEdge=1920, quality=65, fps=30;
  static void Send(INPUT i) { if(SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("SendInput failed; Windows blocks control of elevated apps and secure desktops."); }
  static INPUT KeyInput(int code,bool down) {
    int vk=code&0xffff;
    INPUT i=new INPUT(); i.type=1; i.u.k.vk=(ushort)vk; i.u.k.flags=down?0u:2u;
    // Preserve numpad Enter as a distinct held key and emit its extended-key flag on release too.
    if((code&0x10000)!=0||vk==0xA3||vk==0xA5||vk==0x5B||vk==0x5C||(vk>=0x21&&vk<=0x2E)) i.u.k.flags|=1;
    if(vk==0x90) i.u.k.scan=0x45;
    return i;
  }
  static void Key(int code,bool down) { Send(KeyInput(code,down)); }
  static void Mouse(int b,bool down) { INPUT i=new INPUT(); i.u.m.dwFlags=b==0?(down?2u:4u):b==1?(down?32u:64u):(down?8u:16u); Send(i); }
  static int Code(string c) {
    if(c.Length==4&&c.StartsWith("Key")&&c[3]>='A'&&c[3]<='Z') return c[3];
    if(c.Length==6&&c.StartsWith("Digit")&&c[5]>='0'&&c[5]<='9') return c[5];
    if(c.Length==7&&c.StartsWith("Numpad")&&c[6]>='0'&&c[6]<='9') return 0x60+c[6]-'0';
    int f; if(c.StartsWith("F")&&int.TryParse(c.Substring(1),out f)&&f>=1&&f<=12) return 111+f;
    switch(c) {
      case "Enter":return 13; case "Escape":return 27; case "Backspace":return 8; case "Tab":return 9; case "Space":return 32;
      case "NumpadEnter":return 0x1000D; case "NumLock":return 0x10090;
      case "NumpadMultiply":return 0x6A; case "NumpadAdd":return 0x6B; case "NumpadComma":return 0x6C;
      case "NumpadSubtract":return 0x6D; case "NumpadDecimal":return 0x6E; case "NumpadDivide":return 0x1006F;
      case "NumpadEqual":return 0xBB; case "NumpadClear":return 0x0C;
      case "ShiftLeft":return 160; case "ShiftRight":return 161; case "ControlLeft":return 162; case "ControlRight":return 163;
      case "AltLeft":return 164; case "AltRight":return 165; case "MetaLeft":return 91; case "MetaRight":return 92;
      case "ArrowLeft":return 37; case "ArrowUp":return 38; case "ArrowRight":return 39; case "ArrowDown":return 40;
      case "Home":return 36; case "End":return 35; case "PageUp":return 33; case "PageDown":return 34; case "Insert":return 45; case "Delete":return 46;
      case "CapsLock":return 20; case "Backquote":return 192; case "Minus":return 189; case "Equal":return 187;
      case "BracketLeft":return 219; case "BracketRight":return 221; case "Backslash":return 220; case "Semicolon":return 186;
      case "Quote":return 222; case "Comma":return 188; case "Period":return 190; case "Slash":return 191;
      default:return 0;
    }
  }
  static void Release() {
    lock(gate) {
      if(systemDesktop) { try { RequireDesktop(); } catch { keys.Clear(); buttons.Clear(); return; } }
      foreach(int k in keys) { try { Key(k,false); } catch {} } keys.Clear();
      foreach(int b in buttons) { try { Mouse(b,false); } catch {} } buttons.Clear();
    }
  }
  static void Apply(Dictionary<string,object> e) {
    string type=(string)e["type"];
    lock(gate) {
      if(stopped) return;
      if(systemDesktop) RequireDesktop();
      if(type=="pointer") {
        var r=Bounds();
        if(!SetCursorPos(r.Left+(int)Math.Round(Convert.ToDouble(e["x"])*(r.Width-1)),r.Top+(int)Math.Round(Convert.ToDouble(e["y"])*(r.Height-1)))) throw new Exception("Cannot move pointer on the current desktop.");
        string action=(string)e["action"]; if(action=="move") return;
        int b=Convert.ToInt32(e["button"]); bool down=action=="down";
        if(down) buttons.Add(b); Mouse(b,down); if(!down) buttons.Remove(b);
      } else if(type=="key") {
        int k=Code((string)e["code"]); if(k==0) return; bool down=(string)e["action"]=="down";
        if(down) keys.Add(k); Key(k,down); if(!down) keys.Remove(k);
      } else if(type=="wheel") {
        INPUT i=new INPUT(); i.u.m.dwFlags=0x800; i.u.m.mouseData=unchecked((uint)(int)-Convert.ToDouble(e["deltaY"])); Send(i);
      } else if(type=="text") {
        foreach(char ch in (string)e["text"]) { INPUT i=new INPUT(); i.type=1; i.u.k.scan=ch; i.u.k.flags=4; Send(i); i.u.k.flags=6; Send(i); }
      }
    }
  }
  static void Capture() {
    Bitmap full=null;
    CaptureSurface surface=null;
    byte[] rawPacket=null;
    bool preciseTimer=!preview&&timeBeginPeriod(1)==0;
    int lastEdge=-1,lastQuality=-1,lastRate=-1;
    bool populated=false;
    bool gpuHasFrame=false;
    Rectangle capturedBounds=Rectangle.Empty;
    Duplication duplicate=null;
    DateTime retryGpu=DateTime.MinValue;
    DateTime gpuStarted=DateTime.MinValue;
    DateTime lastFrameAt=DateTime.MinValue;
    try {
      Stream output=outputStream;
      ImageCodecInfo codec=Array.Find(ImageCodecInfo.GetImageEncoders(),c=>c.MimeType=="image/jpeg");
      DateTime checkedAt=DateTime.MinValue;
      while(!stopped) {
        var clock=System.Diagnostics.Stopwatch.StartNew();
        int edge, q, rate; lock(gate) { edge=preview?640:maxEdge; q=quality; rate=fps; }
        if((DateTime.UtcNow-checkedAt).TotalSeconds>=1) {
          string previousDesktop=attachedName;
          RequireDesktop(); ReportDisplays(); checkedAt=DateTime.UtcNow;
          if(previousDesktop!=attachedName&&full!=null) { full.Dispose(); full=null; if(surface!=null) {surface.Dispose();surface=null;} }
        }
        var r=Bounds();
        if(r.Width<1||r.Height<1||r.Width>32768||r.Height>32768||(long)r.Width*r.Height>64000000) throw new Exception("Unsupported display size.");
        if(full==null||capturedBounds!=r) {
          if(full!=null) full.Dispose();
          if(surface!=null) {surface.Dispose();surface=null;}
          try {surface=new CaptureSurface(r.Width,r.Height);full=surface.Picture;}
          catch {full=new Bitmap(r.Width,r.Height,PixelFormat.Format32bppRgb);}
          populated=false;
          capturedBounds=r;
          if(duplicate!=null) { duplicate.Dispose(); duplicate=null; } retryGpu=DateTime.MinValue;
        }
        {
          try {
            if(!preview && duplicate==null && DateTime.UtcNow>=retryGpu) {
              try { duplicate=new Duplication(r); gpuStarted=DateTime.UtcNow; gpuHasFrame=false; } catch { retryGpu=DateTime.UtcNow.AddSeconds(10); }
            }
            if(duplicate!=null) {
              try {
                if(duplicate.Read(full)) gpuHasFrame=true;
                else {
                  if(!gpuHasFrame && (DateTime.UtcNow-gpuStarted).TotalSeconds>2) throw new Exception("No GPU desktop frames.");
                  if(gpuHasFrame && populated && lastEdge==edge && lastQuality==q && lastRate==rate && (DateTime.UtcNow-lastFrameAt).TotalSeconds<(rawFrames?0.1:2)) { Thread.Sleep(2); continue; }
                }
              }
              catch { duplicate.Dispose(); duplicate=null; gpuHasFrame=false; retryGpu=DateTime.UtcNow.AddSeconds(10); }
            }
            if(duplicate==null||!gpuHasFrame) {
              if(surface!=null) surface.Read(r.Left,r.Top);
              else using(var g=Graphics.FromImage(full)) g.CopyFromScreen(r.Left,r.Top,0,0,r.Size,CopyPixelOperation.SourceCopy);
              captureBackend="gdi";
            }
            else captureBackend="dxgi";
            populated=true; lastEdge=edge; lastQuality=q; lastRate=rate;
          }
          catch { RequireDesktop(); throw; }
          double scale=Math.Min(1.0,(double)edge/Math.Max(r.Width,r.Height));
          using(var scaled=scale<1 ? new Bitmap(full,new Size(Math.Max(1,(int)(r.Width*scale)),Math.Max(1,(int)(r.Height*scale)))) : null)
          {
            var picture=scaled??full;
            if(rawFrames) {
              int width=picture.Width,height=picture.Height,n=checked(width*height*4+9);
              if(n>33554432) throw new Exception("Raw desktop frame exceeds limit.");
              if(rawPacket==null||rawPacket.Length!=n) rawPacket=new byte[n];
              var packet=rawPacket; packet[0]=3;
              packet[1]=(byte)(width>>24); packet[2]=(byte)(width>>16); packet[3]=(byte)(width>>8); packet[4]=(byte)width;
              packet[5]=(byte)(height>>24); packet[6]=(byte)(height>>16); packet[7]=(byte)(height>>8); packet[8]=(byte)height;
              var bits=picture.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppRgb);
              try { for(int row=0;row<height;row++) Marshal.Copy(IntPtr.Add(bits.Scan0,row*bits.Stride),packet,9+row*width*4,width*4); }
              finally { picture.UnlockBits(bits); }
              SendPacket(packet);
            } else using(var data=new MemoryStream()) using(var p=new EncoderParameters(1)) {
              p.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,(long)q);
              picture.Save(data,codec,p);
              if(data.Length>4194304) throw new Exception("JPEG exceeds 4 MB.");
              int n=(int)data.Length; byte[] h={(byte)(n>>24),(byte)(n>>16),(byte)(n>>8),(byte)n};
              output.Write(h,0,4); data.WriteTo(output); output.Flush();
            }
            lastFrameAt=DateTime.UtcNow;
          }
        }
        // One outstanding frame: pipe congestion never creates a growing frame queue.
        if(!ack.WaitOne(15000)) throw new Exception("Frame consumer stopped responding.");
        int remaining=(preview?3000:1000/rate)-(int)clock.ElapsedMilliseconds;
        if(remaining>0) Thread.Sleep(remaining);
      }
    } catch(Exception e) { if(!stopped) reportError(e.Message); stopped=true; Release(); Environment.Exit(1); }
    finally { if(duplicate!=null) duplicate.Dispose(); if(full!=null) full.Dispose(); if(surface!=null) surface.Dispose(); if(preciseTimer) timeEndPeriod(1); }
  }
  public static void Run(bool readOnly, bool previewMode, bool captureEnabled, bool raw=false) {
    Run(readOnly,previewMode,captureEnabled,false,Console.OpenStandardInput(),Console.OpenStandardOutput(),message=>Console.Error.WriteLine(message),raw);
  }
  public static void Run(bool readOnly, bool previewMode, bool captureEnabled, bool secure, Stream input, Stream output, Action<string> error, bool raw=false, Action videoCapture=null) {
    if(secure&&!System.Security.Principal.WindowsIdentity.GetCurrent().IsSystem) throw new Exception("System desktop requires the installed service.");
    systemDesktop=secure; inputStream=input; outputStream=output; reportError=error;
    preview=previewMode; rawFrames=raw&&!preview;
    SetProcessDPIAware();
    // Input-only helpers drive the H.264 capture backend: no frames, no display probing.
    if(captureEnabled) { Thread capture=new Thread(()=>{
      if(videoCapture==null) { Capture(); return; }
      try { videoCapture(); } catch(Exception e) { if(!stopped) { lock(outputGate) reportError("WINDOWS_DESKTOP_UNAVAILABLE: "+e.Message); } stopped=true; Release(); Environment.Exit(1); }
    }); capture.IsBackground=true; capture.Start(); }
    try {
      using(var reader=new StreamReader(inputStream,new UTF8Encoding(false))) {
        var json=new JavaScriptSerializer(); json.MaxJsonLength=32768;
        string line;
        while(!stopped&&(line=reader.ReadLine())!=null) {
          if(line.Length>32768) throw new Exception("Input exceeds limit.");
          var e=json.Deserialize<Dictionary<string,object>>(line); string type=(string)e["type"];
          if(type=="close") break;
          if(type=="ack") { ack.Set(); continue; }
          if(type=="video_flow") { videoPaused=Convert.ToBoolean(e["paused"]); continue; }
          if(type=="video_keyframe") { Interlocked.Increment(ref videoGeneration); continue; }
          if(type=="displays") { reportDisplayMetadata=true; continue; }
          if(type=="display") {
            var id=e["id"] as string; if(id==null||id.Length>128||id.IndexOf('\0')>=0) throw new Exception("Invalid display.");
            lock(gate) selectedDisplay=id; continue;
          }
          if(type=="configure"&&!preview) {
            int edge=Convert.ToInt32(e["maxEdge"]), q=Convert.ToInt32(e["quality"]), rate=Convert.ToInt32(e["fps"]);
            if(edge<640||edge>2560||q<35||q>85||rate<5||rate>240) throw new Exception("Invalid capture profile.");
            lock(gate) { maxEdge=edge; quality=q; fps=rate; } continue;
          }
          if(!readOnly) { if(type=="release") Release(); else Apply(e); }
        }
      }
    } finally { stopped=true; ack.Set(); Release(); }
  }
}
'@
[NativeDesktop]::Run($args[0] -notin @('control','raw-control'), $args[0] -eq 'preview', $args[0] -ne 'input', $args[0] -in @('raw-view','raw-control'))
`;
