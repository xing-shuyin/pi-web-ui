// SPDX-License-Identifier: MIT
#include <windows.h>
#include <d3d11.h>
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
    ComPtr<ID3D11VideoDevice> videoDevice;
    ComPtr<ID3D11VideoContext> videoContext;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    ComPtr<ID3D11VideoProcessor> processor;
    ComPtr<ID3D11Texture2D> input;
    ComPtr<ID3D11VideoProcessorInputView> inputView;
    UINT sourceWidth = 0, sourceHeight = 0;
    uint64_t submitted = 0, received = 0;
    ~Session() {
        av_packet_free(&packet); av_bsf_free(&filter); avcodec_free_context(&codec);
        av_buffer_unref(&qsvFrames); av_buffer_unref(&qsvDevice);
        av_buffer_unref(&frames); av_buffer_unref(&deviceRef);
    }
    void option(const char* name, const char* value) { check(av_opt_set(codec->priv_data, name, value, 0), name); }
    void initialize(ID3D11Device* supplied, int width, int height, int kbps, int fps) {
        device = supplied; device->GetImmediateContext(&context);
        ComPtr<ID3D10Multithread> multi;
        check(context.As(&multi), "D3D11 multithread protection"); multi->SetMultithreadProtected(TRUE);
        check(device.As(&videoDevice), "D3D11 video device"); check(context.As(&videoContext), "D3D11 video context");
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
        codec->colorspace = AVCOL_SPC_SMPTE170M; codec->color_range = AVCOL_RANGE_MPEG;
        if (desc.VendorId == 0x10de) {
            option("preset", "p1"); option("tune", "ull"); option("rc", "cbr");
            option("zerolatency", "1"); option("delay", "0"); option("rc-lookahead", "0");
        } else if (desc.VendorId == 0x1002) {
            option("usage", "ultralowlatency"); option("quality", "speed"); option("rc", "cbr");
            option("filler_data", "0"); option("preanalysis", "0");
        } else { option("preset", "veryfast"); option("async_depth", "1"); option("look_ahead", "0"); }
        check(avcodec_open2(codec, encoder, nullptr), "Hardware encoder initialization");
        check(av_bsf_alloc(av_bsf_get_by_name("h264_metadata"), &filter), "H264 metadata allocation");
        check(avcodec_parameters_from_context(filter->par_in, codec), "H264 metadata parameters");
        filter->time_base_in = codec->time_base;
        check(av_opt_set(filter->priv_data, "matrix_coefficients", "6", 0), "H264 matrix");
        check(av_opt_set(filter->priv_data, "video_full_range_flag", "0", 0), "H264 range");
        check(av_bsf_init(filter), "H264 metadata initialization");
        packet = av_packet_alloc(); if (!packet) throw std::bad_alloc();
    }
    void prepareInput(const D3D11_TEXTURE2D_DESC& source) {
        if (input && sourceWidth == source.Width && sourceHeight == source.Height) return;
        inputView.Reset(); input.Reset(); processor.Reset(); enumerator.Reset();
        D3D11_VIDEO_PROCESSOR_CONTENT_DESC content = {};
        content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        content.InputWidth = source.Width; content.InputHeight = source.Height;
        content.OutputWidth = codec->width; content.OutputHeight = codec->height;
        content.InputFrameRate = content.OutputFrameRate = DXGI_RATIONAL{UINT(codec->framerate.num), 1};
        content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
        check(videoDevice->CreateVideoProcessorEnumerator(&content, &enumerator), "Video processor enumeration");
        check(videoDevice->CreateVideoProcessor(enumerator.Get(), 0, &processor), "Video processor creation");
        D3D11_TEXTURE2D_DESC tex = source;
        tex.MipLevels = tex.ArraySize = 1; tex.Usage = D3D11_USAGE_DEFAULT;
        tex.BindFlags = D3D11_BIND_RENDER_TARGET; tex.CPUAccessFlags = tex.MiscFlags = 0;
        check(device->CreateTexture2D(&tex, nullptr, &input), "GPU input surface");
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC view = {};
        view.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        check(videoDevice->CreateVideoProcessorInputView(input.Get(), enumerator.Get(), &view, &inputView), "Video input view");
        RECT sourceRect = {0, 0, LONG(source.Width), LONG(source.Height)};
        RECT targetRect = {0, 0, codec->width, codec->height};
        videoContext->VideoProcessorSetStreamFrameFormat(processor.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        videoContext->VideoProcessorSetStreamAutoProcessingMode(processor.Get(), 0, FALSE);
        videoContext->VideoProcessorSetStreamSourceRect(processor.Get(), 0, TRUE, &sourceRect);
        videoContext->VideoProcessorSetStreamDestRect(processor.Get(), 0, TRUE, &targetRect);
        videoContext->VideoProcessorSetOutputTargetRect(processor.Get(), TRUE, &targetRect);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE rgb = {}, yuv = {};
        rgb.RGB_Range = 0; rgb.Nominal_Range = 2; yuv.YCbCr_Matrix = 0; yuv.Nominal_Range = 1;
        videoContext->VideoProcessorSetStreamColorSpace(processor.Get(), 0, &rgb);
        videoContext->VideoProcessorSetOutputColorSpace(processor.Get(), &yuv);
        sourceWidth = source.Width; sourceHeight = source.Height;
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
        Frame frame(av_frame_alloc()); if (!frame) throw std::bad_alloc();
        check(av_hwframe_get_buffer(frames, frame.get(), 0), "GPU frame allocation");
        auto output = (ID3D11Texture2D*)frame->data[0];
        D3D11_TEXTURE2D_DESC outputDesc = {}; output->GetDesc(&outputDesc);
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC view = {};
        if (outputDesc.ArraySize > 1) {
            view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2DARRAY;
            view.Texture2DArray.FirstArraySlice = UINT(uintptr_t(frame->data[1])); view.Texture2DArray.ArraySize = 1;
        } else view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
        ComPtr<ID3D11VideoProcessorOutputView> outputView;
        check(videoDevice->CreateVideoProcessorOutputView(output, enumerator.Get(), &view, &outputView), "Video output view");
        context->CopySubresourceRegion(input.Get(), 0, 0, 0, 0, texture, 0, nullptr);
        D3D11_VIDEO_PROCESSOR_STREAM stream = {}; stream.Enable = TRUE; stream.pInputSurface = inputView.Get();
        check(videoContext->VideoProcessorBlt(processor.Get(), outputView.Get(), 0, 1, &stream), "GPU scaling and color conversion");
        context->Flush(); frame->pts = pts;
        frame->color_range = codec->color_range; frame->colorspace = codec->colorspace;
        Frame mapped;
        if (qsvFrames) {
            mapped.reset(av_frame_alloc()); if (!mapped) throw std::bad_alloc();
            mapped->format = AV_PIX_FMT_QSV; mapped->hw_frames_ctx = av_buffer_ref(qsvFrames);
            if (!mapped->hw_frames_ctx) throw std::bad_alloc();
            check(av_hwframe_map(mapped.get(), frame.get(), AV_HWFRAME_MAP_READ), "QSV GPU mapping");
            mapped->pts = pts;
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
API void* pi_codec_open(void* device, int width, int height, int kbps, int fps) noexcept {
    try {
        if (!device || width < 2 || height < 2 || width > 2560 || height > 2560 || width % 2 || height % 2 || kbps < 100 || kbps > 50000 || fps < 5 || fps > 240) return nullptr;
        av_log_set_level(AV_LOG_ERROR);
        auto s = std::make_unique<Session>(); s->initialize((ID3D11Device*)device, width, height, kbps, fps); return s.release();
    } catch (const std::exception& e) { fprintf(stderr, "[native-codec] %s\n", e.what()); return nullptr; } catch (...) { return nullptr; }
}
API int pi_codec_encode(void* handle, void* texture, Encoded callback, void* opaque, int64_t pts) noexcept {
    try { if (!handle || !texture || !callback || pts < 0) return -1; ((Session*)handle)->encode((ID3D11Texture2D*)texture, callback, opaque, pts); return 0; }
    catch (const std::exception& e) { fprintf(stderr, "[native-codec] %s\n", e.what()); return -1; } catch (...) { return -1; }
}
API int pi_codec_configure(void* handle, int kbps, int fps) noexcept {
    if (!handle || kbps < 100 || kbps > 50000 || fps < 5 || fps > 240) return -1;
    auto c = ((Session*)handle)->codec;
    // This FFmpeg AMF implementation reads these values only during initialization.
    // Request a clean encoder restart in the caller, preserving the browser connection.
    if (!strcmp(c->codec->name, "h264_amf") && (c->bit_rate != int64_t(kbps) * 1000 || c->framerate.num != fps)) return 1;
    c->bit_rate = int64_t(kbps) * 1000; c->rc_max_rate = c->bit_rate; c->rc_buffer_size = kbps * 1000 / fps;
    c->framerate = AVRational{fps, 1}; return 0;
}
API void pi_codec_close(void* handle) noexcept { try { delete (Session*)handle; } catch (...) {} }
