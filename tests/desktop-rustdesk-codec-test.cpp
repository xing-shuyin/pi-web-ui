// Generates its own GPU textures; never captures the user's desktop or sends input.
#include <windows.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstdint>
#include <chrono>
#include <io.h>
#include <fcntl.h>
using Microsoft::WRL::ComPtr;
typedef void (*Packet)(const uint8_t*,int32_t,int32_t,const void*,int64_t);
typedef void* (*Open)(void*,int,int,int,int);
typedef int (*Encode)(void*,void*,Packet,void*,int64_t);
typedef int (*Configure)(void*,int,int);
typedef void (*Close)(void*);
int frames=0; long long bytes=0;
void output(const uint8_t* data,int32_t size,int32_t key,const void*,int64_t pts) {
  if(pts!=frames*10 || (frames==0 && !key)) exit(12);
  frames++; bytes+=size;
  if(size<1||size>4*1024*1024) exit(7);
  fwrite(data,1,size,stdout);
}
int main(int argc,char** argv) {
  if(argc!=2) return 2;
  _setmode(_fileno(stdout),_O_BINARY);
  HMODULE dll=LoadLibraryExA(argv[1],nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
  if(!dll) { fprintf(stderr,"load_error=%lu\n",GetLastError()); return 3; }
  auto open=(Open)GetProcAddress(dll,"pi_codec_open"); auto encode=(Encode)GetProcAddress(dll,"pi_codec_encode");
  auto configure=(Configure)GetProcAddress(dll,"pi_codec_configure"); auto close=(Close)GetProcAddress(dll,"pi_codec_close");
  if(!open||!encode||!configure||!close) return 4;
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL feature;
  if(FAILED(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,&feature,&context))) return 5;
  D3D11_TEXTURE2D_DESC desc={}; desc.Width=1920;desc.Height=1080;desc.MipLevels=desc.ArraySize=1;desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;desc.SampleDesc.Count=1;desc.BindFlags=D3D11_BIND_RENDER_TARGET;
  ComPtr<ID3D11Texture2D> texture; ComPtr<ID3D11RenderTargetView> target;
  if(FAILED(device->CreateTexture2D(&desc,nullptr,&texture))||FAILED(device->CreateRenderTargetView(texture.Get(),nullptr,&target))) return 6;
  if(open(device.Get(),1279,720,8000,120) || open(device.Get(),1280,720,8000,241)) return 13;
  auto encoder=open(device.Get(),1280,720,8000,120); if(!encoder) { fprintf(stderr,"open_failed\n"); return 8; }
  const float colors[][4]={{1,0,0,1},{0,1,0,1},{0,0,1,1},{1,1,1,1},{0,0,0,1}};
  auto start=std::chrono::steady_clock::now();
  for(int i=0;i<120;i++) {
    context->ClearRenderTargetView(target.Get(),colors[i%5]);
    if(i==60) {
      int configured=configure(encoder,4000,60);
      if(configured==1) { close(encoder); encoder=open(device.Get(),1280,720,4000,60); if(!encoder) return 10; }
      else if(configured!=0) { close(encoder); return 10; }
    }
    if(encode(encoder,texture.Get(),output,nullptr,i*10)!=0) { close(encoder); fprintf(stderr,"encode_failed=%d\n",i); return 9; }
    if(frames!=i+1) { close(encoder); return 14; }
  }
  close(encoder);
  double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  fprintf(stderr,"frames=%d bytes=%lld elapsed_ms=%.1f\n",frames,bytes,ms);
  return frames==120 ? 0 : 11;
}
