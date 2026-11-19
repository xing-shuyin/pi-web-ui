// SPDX-License-Identifier: MIT
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <d3d10.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <stdexcept>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libavutil/opt.h>
}
using Microsoft::WRL::ComPtr;
using Encoded = void (*)(const uint8_t*, int32_t, int32_t, const void*, int64_t);
#define API extern "C" __declspec(dllexport)
static void check(int result, const char* operation) {
    if (result < 0) { fprintf(stderr, "[native-codec] %s: 0x%08x\n", operation, unsigned(result)); throw std::runtime_error(operation); }
}
struct FrameDeleter { void operator()(AVFrame* p) const { av_frame_free(&p); } };
using Frame = std::unique_ptr<AVFrame, FrameDeleter>;
struct Session {
    AVCodecContext* codec = nullptr;
    AVBufferRef *deviceRef = nullptr, *frames = nullptr, *qsvDevice = nullptr, *qsvFrames = nullptr;
    AVBSFContext* filter = nullptr;
    AVPacket* packet = nullptr;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11Texture2D> input;
    ComPtr<ID3D11ShaderResourceView> inputView;
    ComPtr<ID3D11VertexShader> vertexShader;
    ComPtr<ID3D11PixelShader> lumaShader, chromaShader;
    ComPtr<ID3D11SamplerState> sampler;
    ComPtr<ID3D11RasterizerState> rasterizer;
    ComPtr<ID3D11Buffer> colorConstants;
    UINT sourceWidth = 0, sourceHeight = 0;
    uint64_t submitted = 0, received = 0;
    bool fullRange = false;
    ~Session() {
        av_packet_free(&packet); av_bsf_free(&filter); avcodec_free_context(&codec);
        av_buffer_unref(&qsvFrames); av_buffer_unref(&qsvDevice);
        av_buffer_unref(&frames); av_buffer_unref(&deviceRef);
    }
    void option(const char* name, const char* value) { check(av_opt_set(codec->priv_data, name, value, 0), name); }
    void initialize(ID3D11Device* supplied, int width, int height, int kbps, int fps, bool full) {
        fullRange = full;
        device = supplied; device->GetImmediateContext(&context);
        ComPtr<ID3D10Multithread> multi;
        check(context.As(&multi), "D3D11 multithread protection"); multi->SetMultithreadProtected(TRUE);
        initializeColorShader();
        ComPtr<IDXGIDevice> dxgi; ComPtr<IDXGIAdapter> adapter; DXGI_ADAPTER_DESC desc = {};
        check(device.As(&dxgi), "DXGI device"); check(dxgi->GetAdapter(&adapter), "DXGI adapter");
        check(adapter->GetDesc(&desc), "DXGI adapter description");
        const char* name = desc.VendorId == 0x10de ? "h264_nvenc" : desc.VendorId == 0x1002 ? "h264_amf" : desc.VendorId == 0x8086 ? "h264_qsv" : nullptr;
        if (!name) throw std::runtime_error("Unsupported hardware encoder vendor");
        const AVCodec* encoder = avcodec_find_encoder_by_name(name);
        if (!encoder || !(codec = avcodec_alloc_context3(encoder))) throw std::bad_alloc();
        deviceRef = av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA);
        if (!deviceRef) throw std::bad_alloc();
        auto d3d = (AVD3D11VADeviceContext*)((AVHWDeviceContext*)deviceRef->data)->hwctx;
        d3d->device = device.Get(); d3d->device->AddRef();
        check(av_hwdevice_ctx_init(deviceRef), "D3D11 hardware context");
        frames = av_hwframe_ctx_alloc(deviceRef); if (!frames) throw std::bad_alloc();
        auto fc = (AVHWFramesContext*)frames->data;
        fc->format = AV_PIX_FMT_D3D11; fc->sw_format = AV_PIX_FMT_NV12;
        fc->width = width; fc->height = height;
        ((AVD3D11VAFramesContext*)fc->hwctx)->BindFlags = D3D11_BIND_RENDER_TARGET;
        check(av_hwframe_ctx_init(frames), "D3D11 NV12 frame pool");
        if (desc.VendorId == 0x8086) {
            check(av_hwdevice_ctx_create_derived(&qsvDevice, AV_HWDEVICE_TYPE_QSV, deviceRef, 0), "QSV device");
            check(av_hwframe_ctx_create_derived(&qsvFrames, AV_PIX_FMT_QSV, qsvDevice, frames, 0), "QSV frame pool");
        }
        codec->width = width; codec->height = height;
        codec->pix_fmt = qsvFrames ? AV_PIX_FMT_QSV : AV_PIX_FMT_D3D11;
        codec->hw_frames_ctx = av_buffer_ref(qsvFrames ? qsvFrames : frames);
        codec->hw_device_ctx = av_buffer_ref(qsvDevice ? qsvDevice : deviceRef);
        if (!codec->hw_frames_ctx || !codec->hw_device_ctx) throw std::bad_alloc();
        codec->time_base = AVRational{1, 1000}; codec->framerate = AVRational{fps, 1};
        codec->bit_rate = int64_t(kbps) * 1000; codec->rc_max_rate = codec->bit_rate;
        codec->rc_buffer_size = kbps * 1000 / fps;
        codec->gop_size = fps; codec->max_b_frames = 0; codec->flags |= AV_CODEC_FLAG_LOW_DELAY;
        codec->colorspace = AVCOL_SPC_BT709; codec->color_range = fullRange ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
        codec->color_primaries = AVCOL_PRI_BT709; codec->color_trc = AVCOL_TRC_IEC61966_2_1;
        if (desc.VendorId == 0x10de) {
            option("preset", "p1"); option("tune", "ull"); option("rc", "cbr");
            option("zerolatency", "1"); option("delay", "0"); option("rc-lookahead", "0");
        } else if (desc.VendorId == 0x1002) {
            option("usage", "ultralowlatency"); option("quality", fps <= 60 ? "balanced" : "speed"); option("rc", "cbr");
            option("filler_data", "0"); option("preanalysis", "0");
        } else { option("preset", "veryfast"); option("async_depth", "1"); option("look_ahead", "0"); }
        check(avcodec_open2(codec, encoder, nullptr), "Hardware encoder initialization");
        check(av_bsf_alloc(av_bsf_get_by_name("h264_metadata"), &filter), "H264 metadata allocation");
        check(avcodec_parameters_from_context(filter->par_in, codec), "H264 metadata parameters");
        filter->time_base_in = codec->time_base;
        check(av_opt_set(filter->priv_data, "matrix_coefficients", "1", 0), "H264 matrix");
        check(av_opt_set(filter->priv_data, "video_full_range_flag", fullRange ? "1" : "0", 0), "H264 range");
        check(av_opt_set(filter->priv_data, "colour_primaries", "1", 0), "H264 primaries");
        check(av_opt_set(filter->priv_data, "transfer_characteristics", "13", 0), "H264 sRGB transfer");
        check(av_bsf_init(filter), "H264 metadata initialization");
        packet = av_packet_alloc(); if (!packet) throw std::bad_alloc();
    }
    // Explicit GPU matrix math avoids vendor video-processor enhancements/gamma
    // conversion. RGB bytes are sRGB; only the BT.709 matrix and range change.
    void initializeColorShader() {
        static const char* shader = R"(
Texture2D source : register(t0); SamplerState linearClamp : register(s0);
cbuffer Color : register(b0) { float4 range; }
struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };
Vertex vs(uint id : SV_VertexID) {
    Vertex v; v.uv = float2((id << 1) & 2, id & 2);
    v.position = float4(v.uv * float2(2,-2) + float2(-1,1), 0, 1); return v;
}
float3 sampleDesktop(float2 uv) {
    uint width,height; source.GetDimensions(width,height);
    float2 span = float2(ddx(uv.x),ddy(uv.y));
    float footprint = max(span.x*width,span.y*height);
    if(footprint<=2.001) return source.SampleLevel(linearClamp,uv,0).rgb;
    // The texture has no mip chain. One bilinear tap misses entire glyph strokes
    // when shrinking more than 2:1, especially on the half-resolution UV plane.
    int taps = footprint<=4.001 ? 2 : 4;
    float3 sum = 0;
    for(int y=0;y<taps;y++) for(int x=0;x<taps;x++)
        sum += source.SampleLevel(linearClamp,uv+((float2(x,y)+0.5)/taps-0.5)*span,0).rgb;
    return sum/(taps*taps);
}
float4 ps(Vertex v) : SV_Target {
    float3 rgb = sampleDesktop(v.uv);
    float y = dot(rgb, float3(0.2126,0.7152,0.0722));
#ifdef CHROMA
    return float4(float2((rgb.b-y)/1.8556,(rgb.r-y)/1.5748)*range.z+range.w,0,1);
#else
    return float4(y*range.x+range.y,0,0,1);
#endif
})";
        auto compile = [&](const char* entry, const char* target, bool chroma) {
            ComPtr<ID3DBlob> blob, error;
            D3D_SHADER_MACRO macros[] = {{"CHROMA","1"},{nullptr,nullptr}};
            HRESULT result = D3DCompile(shader, strlen(shader), nullptr, chroma ? macros : nullptr, nullptr, entry, target, D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &blob, &error);
            check(result, "Desktop color shader compilation"); return blob;
        };
        auto vertex=compile("vs","vs_4_0",false), luma=compile("ps","ps_4_0",false), chroma=compile("ps","ps_4_0",true);
        check(device->CreateVertexShader(vertex->GetBufferPointer(),vertex->GetBufferSize(),nullptr,&vertexShader),"Color vertex shader");
        check(device->CreatePixelShader(luma->GetBufferPointer(),luma->GetBufferSize(),nullptr,&lumaShader),"Luma shader");
        check(device->CreatePixelShader(chroma->GetBufferPointer(),chroma->GetBufferSize(),nullptr,&chromaShader),"Chroma shader");
        D3D11_SAMPLER_DESC sample={}; sample.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sample.AddressU=sample.AddressV=sample.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;
        sample.MaxLOD=D3D11_FLOAT32_MAX;
        check(device->CreateSamplerState(&sample,&sampler),"Color sampler");
        D3D11_RASTERIZER_DESC raster={}; raster.FillMode=D3D11_FILL_SOLID; raster.CullMode=D3D11_CULL_NONE; raster.DepthClipEnable=TRUE;
        check(device->CreateRasterizerState(&raster,&rasterizer),"Color rasterizer");
        const float values[] = {fullRange ? 1.f : 219.f/255, fullRange ? 0.f : 16.f/255, fullRange ? 1.f : 224.f/255,128.f/255};
        D3D11_BUFFER_DESC desc={}; desc.ByteWidth=sizeof(values); desc.Usage=D3D11_USAGE_IMMUTABLE; desc.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        D3D11_SUBRESOURCE_DATA data={}; data.pSysMem=values;
        check(device->CreateBuffer(&desc,&data,&colorConstants),"Color constants");
    }
    void prepareInput(const D3D11_TEXTURE2D_DESC& source) {
        if (input && sourceWidth == source.Width && sourceHeight == source.Height) return;
        inputView.Reset(); input.Reset();
        D3D11_TEXTURE2D_DESC tex=source;
        tex.MipLevels=tex.ArraySize=1; tex.Usage=D3D11_USAGE_DEFAULT;
        tex.BindFlags=D3D11_BIND_SHADER_RESOURCE; tex.CPUAccessFlags=tex.MiscFlags=0;
        check(device->CreateTexture2D(&tex,nullptr,&input),"GPU input surface");
        check(device->CreateShaderResourceView(input.Get(),nullptr,&inputView),"GPU input view");
        sourceWidth=source.Width; sourceHeight=source.Height;
    }
    void convert(ID3D11Texture2D* output, UINT index) {
        D3D11_TEXTURE2D_DESC desc={}; output->GetDesc(&desc);
        context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertexShader.Get(),nullptr,0); context->RSSetState(rasterizer.Get());
        context->OMSetBlendState(nullptr,nullptr,0xffffffff); context->OMSetDepthStencilState(nullptr,0);
        ID3D11ShaderResourceView* resource=inputView.Get(); ID3D11SamplerState* sample=sampler.Get(); ID3D11Buffer* constants=colorConstants.Get();
        context->PSSetShaderResources(0,1,&resource); context->PSSetSamplers(0,1,&sample); context->PSSetConstantBuffers(0,1,&constants);
        for(int plane=0;plane<2;plane++) {
            D3D11_RENDER_TARGET_VIEW_DESC view={}; view.Format=plane ? DXGI_FORMAT_R8G8_UNORM : DXGI_FORMAT_R8_UNORM;
            if(desc.ArraySize>1) {view.ViewDimension=D3D11_RTV_DIMENSION_TEXTURE2DARRAY; view.Texture2DArray.FirstArraySlice=index; view.Texture2DArray.ArraySize=1;}
            else view.ViewDimension=D3D11_RTV_DIMENSION_TEXTURE2D;
            ComPtr<ID3D11RenderTargetView> target; check(device->CreateRenderTargetView(output,&view,&target),"NV12 plane render target");
            D3D11_VIEWPORT viewport={}; viewport.Width=float(codec->width/(plane?2:1)); viewport.Height=float(codec->height/(plane?2:1)); viewport.MaxDepth=1;
            context->RSSetViewports(1,&viewport); context->PSSetShader(plane?chromaShader.Get():lumaShader.Get(),nullptr,0);
            auto pointer=target.Get(); context->OMSetRenderTargets(1,&pointer,nullptr); context->Draw(3,0);
        }
        context->OMSetRenderTargets(0,nullptr,nullptr); resource=nullptr; context->PSSetShaderResources(0,1,&resource);
    }
    void deliver(Encoded callback, void* opaque) {
        check(av_bsf_send_packet(filter, packet), "H264 metadata input");
        for (;;) {
            int result = av_bsf_receive_packet(filter, packet);
            if (result == AVERROR(EAGAIN)) break;
            check(result, "H264 metadata output");
            if (packet->size < 1 || packet->size > 4 * 1024 * 1024 || packet->pts == AV_NOPTS_VALUE) throw std::runtime_error("Invalid encoded access unit");
            callback(packet->data, packet->size, !!(packet->flags & AV_PKT_FLAG_KEY), opaque, packet->pts);
            av_packet_unref(packet); received++;
        }
    }
    void encode(ID3D11Texture2D* texture, Encoded callback, void* opaque, int64_t pts) {
        D3D11_TEXTURE2D_DESC source = {}; texture->GetDesc(&source);
        if (source.Format != DXGI_FORMAT_B8G8R8A8_UNORM || source.SampleDesc.Count != 1 || source.Width > 16384 || source.Height > 16384) throw std::runtime_error("Unsupported capture surface");
        prepareInput(source);
        context->CopySubresourceRegion(input.Get(), 0, 0, 0, 0, texture, 0, nullptr);
        encodeCached(callback, opaque, pts);
    }
    void encodeCached(Encoded callback, void* opaque, int64_t pts) {
        if (!input) throw std::runtime_error("No cached desktop surface");
        Frame frame(av_frame_alloc()); if (!frame) throw std::bad_alloc();
        check(av_hwframe_get_buffer(frames, frame.get(), 0), "GPU frame allocation");
        auto output = (ID3D11Texture2D*)frame->data[0];
        convert(output, UINT(uintptr_t(frame->data[1])));
        context->Flush(); frame->pts = pts;
        frame->color_range = codec->color_range; frame->colorspace = codec->colorspace;
        frame->color_primaries = codec->color_primaries; frame->color_trc = codec->color_trc;
        Frame mapped;
        if (qsvFrames) {
            mapped.reset(av_frame_alloc()); if (!mapped) throw std::bad_alloc();
            mapped->format = AV_PIX_FMT_QSV; mapped->hw_frames_ctx = av_buffer_ref(qsvFrames);
            if (!mapped->hw_frames_ctx) throw std::bad_alloc();
            check(av_hwframe_map(mapped.get(), frame.get(), AV_HWFRAME_MAP_READ), "QSV GPU mapping");
            check(av_frame_copy_props(mapped.get(), frame.get()), "QSV frame properties");
        }
        check(avcodec_send_frame(codec, mapped ? mapped.get() : frame.get()), "Hardware encoder input");
        submitted++;
        // Drain the current frame even when the desktop stops changing. No duplicate input.
        ULONGLONG deadline = GetTickCount64() + 1000;
        while (received < submitted) {
            int result = avcodec_receive_packet(codec, packet);
            if (result == AVERROR(EAGAIN)) {
                if (GetTickCount64() >= deadline) throw std::runtime_error("Hardware encoder output timed out");
                Sleep(1); continue;
            }
            check(result, "Hardware encoder output"); deliver(callback, opaque);
        }
    }
};
API void* pi_codec_open_color(void* device, int width, int height, int kbps, int fps, int fullRange) noexcept {
    try {
        if (!device || width < 2 || height < 2 || width > 4096 || height > 4096 || int64_t(width) * height > 16777216 || (fullRange != 0 && fullRange != 1) || width % 2 || height % 2 || kbps < 100 || kbps > 50000 || fps < 5 || fps > 240) return nullptr;
        av_log_set_level(AV_LOG_ERROR);
        auto s = std::make_unique<Session>(); s->initialize((ID3D11Device*)device, width, height, kbps, fps, fullRange != 0); return s.release();
    } catch (const std::exception& e) { fprintf(stderr, "[native-codec] %s\n", e.what()); return nullptr; } catch (...) { return nullptr; }
}
API void* pi_codec_open(void* device, int width, int height, int kbps, int fps) noexcept {
    return pi_codec_open_color(device, width, height, kbps, fps, 0);
}
API int pi_codec_encode(void* handle, void* texture, Encoded callback, void* opaque, int64_t pts) noexcept {
    try { if (!handle || !texture || !callback || pts < 0) return -1; ((Session*)handle)->encode((ID3D11Texture2D*)texture, callback, opaque, pts); return 0; }
    catch (const std::exception& e) { fprintf(stderr, "[native-codec] %s\n", e.what()); return -1; } catch (...) { return -1; }
}
API int pi_codec_repeat(void* handle, Encoded callback, void* opaque, int64_t pts) noexcept {
    try { if (!handle || !callback || pts < 0) return -1; ((Session*)handle)->encodeCached(callback, opaque, pts); return 0; }
    catch (const std::exception& e) { fprintf(stderr, "[native-codec] %s\n", e.what()); return -1; } catch (...) { return -1; }
}
API int pi_codec_configure(void* handle, int kbps, int fps) noexcept {
    if (!handle || kbps < 100 || kbps > 50000 || fps < 5 || fps > 240) return -1;
    auto c = ((Session*)handle)->codec;
    // Starting a fresh encoder updates hardware timing, GOP and H.264 headers together.
    // Updating AVCodecContext alone leaves the initialized driver's old frame rate.
    if (c->framerate.num != fps || (!strcmp(c->codec->name, "h264_amf") && c->bit_rate != int64_t(kbps) * 1000)) return 1;
    c->bit_rate = int64_t(kbps) * 1000; c->rc_max_rate = c->bit_rate; c->rc_buffer_size = kbps * 1000 / fps;
    c->framerate = AVRational{fps, 1}; return 0;
}
API void pi_codec_close(void* handle) noexcept { try { delete (Session*)handle; } catch (...) {} }
