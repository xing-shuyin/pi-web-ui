using System;
using System.IO;
using System.Runtime.InteropServices;
#if PI_DESKTOP_WGC
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
#endif

// Optional Windows GPU capture fallback. Uses OS WinRT projections, not another app.
// The installer enables this only when the local Windows metadata is available.
internal sealed class DesktopWgc : IDisposable {
#if PI_DESKTOP_WGC
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr device,out IntPtr result);
    [DllImport("combase.dll",CharSet=CharSet.Unicode)] static extern int WindowsCreateString(string value,uint length,out IntPtr result);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name,ref Guid iid,out IntPtr factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateItem(IntPtr self,IntPtr monitor,ref Guid iid,out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetTexture(IntPtr self,ref Guid iid,out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ProtectContext(IntPtr self,int enabled);
    static T Method<T>(IntPtr p,int slot) where T:class { return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(p),slot*IntPtr.Size),typeof(T)) as T; }
    static IntPtr Query(IntPtr p,string id) { IntPtr result;var guid=new Guid(id);Marshal.ThrowExceptionForHR(Marshal.QueryInterface(p,ref guid,out result));return result; }
    static void Drop(ref IntPtr p) { if(p!=IntPtr.Zero) { Marshal.Release(p);p=IntPtr.Zero; } }
    IDirect3DDevice projected;
    Direct3D11CaptureFramePool pool;
    GraphicsCaptureSession session;
    readonly int width,height;
    DesktopWgc(IntPtr device,IntPtr context,IntPtr monitor,int width,int height) {
        this.width=width;this.height=height;
        string stage="support";
        IntPtr dxgi=IntPtr.Zero,inspectable=IntPtr.Zero,name=IntPtr.Zero,factory=IntPtr.Zero,itemPtr=IntPtr.Zero,multithread=IntPtr.Zero;
        try {
            if(!GraphicsCaptureSession.IsSupported()) throw new IOException("WGC is unavailable on this Windows session");
            stage="device";
            multithread=Query(context,"9b7e4e00-342c-4106-a19f-4f2704f689f0");
            Method<ProtectContext>(multithread,5)(multithread,1);
            dxgi=Query(device,"54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out inspectable));
            projected=(IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable);
            const string className="Windows.Graphics.Capture.GraphicsCaptureItem";
            stage="factory";
            Marshal.ThrowExceptionForHR(WindowsCreateString(className,(uint)className.Length,out name));
            var interop=new Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356");
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(name,ref interop,out factory));
            var guid=new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
            stage="monitor";
            Marshal.ThrowExceptionForHR(Method<CreateItem>(factory,4)(factory,monitor,ref guid,out itemPtr));
            var item=(GraphicsCaptureItem)Marshal.GetObjectForIUnknown(itemPtr);
            if(item.Size.Width!=width||item.Size.Height!=height) throw new IOException("WGC display dimensions changed");
            stage="frame pool";
            pool=Direct3D11CaptureFramePool.CreateFreeThreaded(projected,DirectXPixelFormat.B8G8R8A8UIntNormalized,2,item.Size);
            stage="session";session=pool.CreateCaptureSession(item);
            stage="start";session.StartCapture();
        } catch(Exception error) { Dispose();throw new IOException(stage+" 0x"+Marshal.GetHRForException(error).ToString("X8")+": "+error.Message,error); }
        finally { Drop(ref itemPtr);Drop(ref factory);Drop(ref inspectable);Drop(ref dxgi);Drop(ref multithread);if(name!=IntPtr.Zero)WindowsDeleteString(name); }
    }
    public bool Read(Action<IntPtr> consume) {
        Direct3D11CaptureFrame frame=null;
        try {
            // Keep the latest available surface, bounded by the two-buffer pool.
            for(int i=0;i<2;i++) { var next=pool.TryGetNextFrame();if(next==null)break;if(frame!=null)frame.Dispose();frame=next; }
            if(frame==null) return false;
            if(frame.ContentSize.Width!=width||frame.ContentSize.Height!=height) throw new IOException("WGC frame dimensions changed");
            IntPtr surface=Marshal.GetIUnknownForObject(frame.Surface),access=IntPtr.Zero,texture=IntPtr.Zero;
            try {
                access=Query(surface,"a9b3d012-3df2-4ee3-b8d1-8695f457d3c1");
                var id=new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
                Marshal.ThrowExceptionForHR(Method<GetTexture>(access,3)(access,ref id,out texture));
                consume(texture);return true;
            } finally { Drop(ref texture);Drop(ref access);Drop(ref surface); }
        } finally { if(frame!=null)frame.Dispose(); }
    }
    public void Dispose() {
        var oldSession=session;session=null;try { if(oldSession!=null)oldSession.Dispose(); } catch {}
        var oldPool=pool;pool=null;try { if(oldPool!=null)oldPool.Dispose(); } catch {}
        var oldDevice=projected;projected=null;try { if(oldDevice!=null)oldDevice.Dispose(); } catch {}
    }
#else
    public bool Read(Action<IntPtr> consume) { return false; }
    public void Dispose() {}
#endif
    public static bool TryCreate(IntPtr device,IntPtr context,IntPtr monitor,int width,int height,out DesktopWgc value) {
        value=null;
#if PI_DESKTOP_WGC
        try { value=new DesktopWgc(device,context,monitor,width,height);return true; }
        catch(Exception error) { NativeDesktop.VideoFallback("WGC: "+error.Message+" (0x"+Marshal.GetHRForException(error).ToString("X8")+")",true);return false; }
#else
        NativeDesktop.VideoFallback("WGC OS integration is unavailable in this build.",true);
        return false;
#endif
    }
}
