using System;
using System.Runtime.InteropServices;

internal enum DesktopEncoderBuild { Default, NvidiaCompatible }

// Driver capabilities, not GPU model names, choose the embedded codec ABI. RustDesk
// also pins its FFmpeg NVIDIA headers to 12.1 and checks the installed vendor runtime.
internal static class DesktopEncoder {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string name,IntPtr file,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetNvVersion(out uint version);

    internal static uint? NvidiaApiVersion() {
        IntPtr module=IntPtr.Zero;
        try {
            // Never load a vendor DLL from the application directory or current directory.
            module=LoadLibraryEx(Environment.Is64BitProcess?"nvEncodeAPI64.dll":"nvEncodeAPI.dll",IntPtr.Zero,0x00000800);
            if(module==IntPtr.Zero) return null;
            IntPtr address=GetProcAddress(module,"NvEncodeAPIGetMaxSupportedVersion");
            if(address==IntPtr.Zero) return null;
            uint version;
            return ((GetNvVersion)Marshal.GetDelegateForFunctionPointer(address,typeof(GetNvVersion)))(out version)==0?(uint?)version:null;
        } catch { return null; }
        finally { if(module!=IntPtr.Zero) FreeLibrary(module); }
    }

    internal static DesktopEncoderBuild[] NvidiaBuilds(uint? api,bool compatibleInstalled) {
        var builds=new System.Collections.Generic.List<DesktopEncoderBuild>();
        if(compatibleInstalled&&(!api.HasValue||api.Value>=0xc1)) builds.Add(DesktopEncoderBuild.NvidiaCompatible);
        if(!api.HasValue||api.Value>=0xd1) builds.Add(DesktopEncoderBuild.Default);
        // Unknown/older installations retain the existing bounded probe and its error report.
        if(builds.Count==0) builds.Add(DesktopEncoderBuild.Default);
        return builds.ToArray();
    }

    internal static DesktopEncoderBuild[] Builds(string codec,uint? api,bool compatibleInstalled) {
        if(codec=="h264_nvenc") return NvidiaBuilds(api,compatibleInstalled);
        if(codec!="libx264"&&compatibleInstalled) return new[]{DesktopEncoderBuild.NvidiaCompatible,DesktopEncoderBuild.Default};
        return new[]{DesktopEncoderBuild.Default};
    }

    internal static string Label(DesktopEncoderBuild build) {
        return build==DesktopEncoderBuild.NvidiaCompatible?"desktop-timing-v2":"default";
    }
}
