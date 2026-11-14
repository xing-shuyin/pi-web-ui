using System;
using System.Drawing;
using System.Diagnostics;
using System.Windows.Forms;
using System.Runtime.InteropServices;
// An opt-in, non-activating test surface. Closes itself even if the parent test stops.
class DesktopMotion : Form {
    readonly Stopwatch clock=Stopwatch.StartNew(); readonly Timer tick=new Timer(); int paints;
    protected override bool ShowWithoutActivation { get { return true; } }
    DesktopMotion() {
        Text="pi-web-ui motion test (closes automatically)"; ClientSize=new Size(960,540);
        StartPosition=FormStartPosition.Manual; Location=new Point(20,80); TopMost=true;
        DoubleBuffered=true; ShowInTaskbar=false;
        tick.Interval=8; tick.Tick+=(s,e)=>{if(clock.ElapsedMilliseconds>=20000)Close();else Invalidate();}; tick.Start();
    }
    protected override void OnPaint(PaintEventArgs e) {
        paints++; int offset=(int)(clock.ElapsedMilliseconds/4)%Width;
        for(int y=0;y<Height;y+=32) for(int x=0;x<Width;x+=32) {
            using(var brush=new SolidBrush(Color.FromArgb((x+offset)%256,(y+offset/2)%256,(x+y+offset)%256))) e.Graphics.FillRectangle(brush,x,y,32,32);
        }
        using(var brush=new SolidBrush(Color.White)) e.Graphics.DrawString("pi-web-ui motion test — auto-close 20s",Font,brush,12,12);
    }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [STAThread] static void Main() {
        SetProcessDPIAware(); using(var form=new DesktopMotion()){ Application.Run(form); Console.WriteLine("painted="+form.paints+" elapsed="+form.clock.ElapsedMilliseconds); }
    }
}
