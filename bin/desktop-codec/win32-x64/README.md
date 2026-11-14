# Embedded native desktop codec

The Windows x64 component is pi-web-ui's own MIT-licensed D3D11/FFmpeg adapter.
It contains no RustDesk `hwcodec` source, RustDesk application, or RustDesk-derived
FFmpeg patches. It follows the same broad GPU-first architecture: capture a GPU
texture, scale and convert on the GPU, then encode on NVIDIA NVENC, AMD AMF or Intel
QSV. The encoder uses the GPU that owns the selected output. Failures retain the
existing hardware and software fallback paths. Runtime metadata is `native-d3d11`.

`scripts/build-ffmpeg-compat.mjs` builds the pinned FFmpeg and vendor dependencies;
`scripts/build-native-desktop-codec.mjs` links this adapter against those static
libraries. `PI_FFMPEG_BUILD_DIR` optionally selects an existing build directory.
The latter refuses the earlier local RustDesk FFmpeg modifications. FFmpeg is
LGPL-2.1-or-later in this configuration. The DLL is replaceable and checksum-verified;
redistributions include full adapter/application source, FFmpeg/vendor source
archives, patches, build scripts and notices so recipients can rebuild/relink it.
The separate legacy FFmpeg executable retains its own GPL notices and source URL.

Release builds must prepare the codec on a Windows x64 build host before packaging:

```powershell
npm run build:desktop-codec
npm run pack:p2p
```

The first command builds the compatibility encoder and adapter from pinned sources.
It bundles the matching FFmpeg/vendor source archives, relinkable static libraries,
checksums, notices and build instructions under `bin/desktop-codec/win32-x64/relink/`.
`pack:p2p` and `prepublishOnly` fail if the binary or relink materials are absent or
do not match their manifests. Publishing from another OS requires copying both the
Windows `bin/desktop-codec/win32-x64/` and `bin/ffmpeg/win32-x64/nvenc-compat/`
build outputs from that same build host before running the release commands. Release
owners should review the included notices and source/relink obligations for their
distribution. No contributor-hosted binary download is required.

DXGI is preferred. WGC is available for normal desktops when duplication fails.
Where SYSTEM cannot activate WinRT capture, the protected service launches its same
executable as the authenticated session owner for read-only GPU capture. The private
pipe checks SID/PID, validates bounded packets and has a kill-on-close job. Input
and secure-desktop capture remain in the SYSTEM service. A desktop change shuts
down user capture and restores the protected capture path. GDI remains a fallback.

Only real desktop updates are encoded by the new native path; unchanged desktops
use independent heartbeat packets. Full access units include timestamps and reset
flags. Browser acknowledgements after drawing bound the outstanding frame window;
automatic quality reduces bitrate before FPS. Profile changes preserve the browser
connection; dimensions/desktop changes reopen the codec. AMF also reopens on bitrate
or FPS changes because this FFmpeg version applies those properties only at
initialization; NVENC/QSV use their runtime reconfiguration. The ABI returns `1`
when the caller must reopen and send a stream reset, `0` on in-place success,
and `-1` on invalid arguments. Frame rate settings are
upper limits, not a promise of 120/240 distinct frames on a 60 Hz display.

Validation uses `tests/desktop-rustdesk-codec-test.mjs` (historical filename): generated
GPU textures, live bitrate/FPS changes, complete frame order and decoded color.
`tests/desktop-rustdesk-stream-test.mjs` exercises the protected service and real
Chrome WebCodecs using its own nonactivating animation, then idle liveness. Set
`PI_DESKTOP_TEST_PACKAGE_ROOT`, `PI_DESKTOP_TEST_EDGE` and `PI_DESKTOP_TEST_MIN_FPS`
to validate installed artifacts and an explicit performance threshold. Tests reject
silent fallback even after profile changes. Physical Intel/NVIDIA and high-refresh
acceptance remain separate from local AMD measurements.

macOS continues to use ScreenCaptureKit/VideoToolbox. Existing pi authentication,
clipboard, group routing and P2P remain their respective owners. This does not
implement RustDesk protocol or a new WebRTC video transport. Public billd-desk's
MediaStream/WebRTC flow remains a design reference, not code included in this DLL.
