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
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT m; [FieldOffset(0)] public KEYBDINPUT k; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] input, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static readonly object gate = new object();
  static readonly HashSet<int> keys = new HashSet<int>();
  static readonly HashSet<int> buttons = new HashSet<int>();
  static readonly AutoResetEvent ack = new AutoResetEvent(false);
  static volatile bool stopped;
  static void Send(INPUT i) { if(SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("SendInput failed; Windows blocks control of elevated apps and secure desktops."); }
  static void Key(int vk,bool down) { INPUT i=new INPUT(); i.type=1; i.u.k.vk=(ushort)vk; i.u.k.flags=down?0u:2u; if(vk==0xA3||vk==0xA5||vk==0x5B||vk==0x5C||(vk>=0x21&&vk<=0x2E)) i.u.k.flags|=1; Send(i); }
  static void Mouse(int b,bool down) { INPUT i=new INPUT(); i.u.m.dwFlags=b==0?(down?2u:4u):b==1?(down?32u:64u):(down?8u:16u); Send(i); }
  static int Code(string c) {
    if(c.Length==4&&c.StartsWith("Key")&&c[3]>='A'&&c[3]<='Z') return c[3];
    if(c.Length==6&&c.StartsWith("Digit")&&c[5]>='0'&&c[5]<='9') return c[5];
    int f; if(c.StartsWith("F")&&int.TryParse(c.Substring(1),out f)&&f>=1&&f<=12) return 111+f;
    switch(c) {
      case "Enter":return 13; case "Escape":return 27; case "Backspace":return 8; case "Tab":return 9; case "Space":return 32;
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
      foreach(int k in keys) { try { Key(k,false); } catch {} } keys.Clear();
      foreach(int b in buttons) { try { Mouse(b,false); } catch {} } buttons.Clear();
    }
  }
  static void Apply(Dictionary<string,object> e) {
    string type=(string)e["type"];
    lock(gate) {
      if(stopped) return;
      if(type=="pointer") {
        var r=System.Windows.Forms.Screen.PrimaryScreen.Bounds;
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
    try {
      Stream output=Console.OpenStandardOutput();
      ImageCodecInfo codec=Array.Find(ImageCodecInfo.GetImageEncoders(),c=>c.MimeType=="image/jpeg");
      while(!stopped) {
        var r=System.Windows.Forms.Screen.PrimaryScreen.Bounds;
        if(r.Width<1||r.Height<1||r.Width>32768||r.Height>32768||(long)r.Width*r.Height>64000000) throw new Exception("Unsupported display size.");
        using(var full=new Bitmap(r.Width,r.Height,PixelFormat.Format24bppRgb)) {
          using(var g=Graphics.FromImage(full)) g.CopyFromScreen(r.Left,r.Top,0,0,r.Size,CopyPixelOperation.SourceCopy);
          double scale=Math.Min(1.0,1920.0/Math.Max(r.Width,r.Height));
          using(var image=new Bitmap(full,new Size(Math.Max(1,(int)(r.Width*scale)),Math.Max(1,(int)(r.Height*scale)))))
          using(var data=new MemoryStream())
          using(var p=new EncoderParameters(1)) {
            p.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,65L);
            image.Save(data,codec,p);
            if(data.Length>4194304) throw new Exception("JPEG exceeds 4 MB.");
            int n=(int)data.Length; byte[] h={(byte)(n>>24),(byte)(n>>16),(byte)(n>>8),(byte)n};
            output.Write(h,0,4); data.WriteTo(output); output.Flush();
          }
        }
        // One outstanding frame: pipe congestion never creates a growing frame queue.
        if(!ack.WaitOne(15000)) throw new Exception("Frame consumer stopped responding.");
        Thread.Sleep(100);
      }
    } catch(Exception e) { if(!stopped) Console.Error.WriteLine(e.Message); stopped=true; Release(); Environment.Exit(1); }
  }
  public static void Run(bool readOnly) {
    SetProcessDPIAware();
    Thread capture=new Thread(Capture); capture.IsBackground=true; capture.Start();
    try {
      using(var input=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false))) {
        var json=new JavaScriptSerializer(); json.MaxJsonLength=32768;
        string line;
        while(!stopped&&(line=input.ReadLine())!=null) {
          if(line.Length>32768) throw new Exception("Input exceeds limit.");
          var e=json.Deserialize<Dictionary<string,object>>(line); string type=(string)e["type"];
          if(type=="close") break;
          if(type=="ack") { ack.Set(); continue; }
          if(!readOnly) { if(type=="release") Release(); else Apply(e); }
        }
      }
    } finally { stopped=true; ack.Set(); Release(); }
  }
}
'@
[NativeDesktop]::Run($args[0] -ne 'control')
`;
