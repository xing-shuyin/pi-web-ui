import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const desktopPatchRevision = "desktop-timing-v2";

export async function patchDesktopFfmpeg(source) {
	async function patch(file, replacements) {
		const path = join(source, file);
		let text = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
		for (const [before, after] of replacements) {
			if (text.includes(after)) continue;
			if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before))
				throw new Error(`Pinned FFmpeg patch context changed: ${file}`);
			text = text.replace(before, after);
		}
		await writeFile(path, text);
	}
	await patch("libavutil/time.c", [
		[
			"int av_usleep(unsigned usec)\n{\n#if HAVE_NANOSLEEP",
			`int av_usleep(unsigned usec)
{
#if HAVE_WINDOWS_H && defined(_WIN32)
    if (usec) {
        HANDLE timer = CreateWaitableTimerExW(NULL, NULL, 0x00000002,
                                             TIMER_MODIFY_STATE | SYNCHRONIZE);
        if (timer) {
            LARGE_INTEGER due;
            DWORD result = WAIT_FAILED;
            due.QuadPart = -(int64_t)usec * 10;
            if (SetWaitableTimer(timer, &due, 0, NULL, NULL, FALSE))
                result = WaitForSingleObject(timer, INFINITE);
            CloseHandle(timer);
            if (result == WAIT_OBJECT_0)
                return 0;
        }
    }
#endif
#if HAVE_NANOSLEEP`,
		],
	]);
	await patch("libavfilter/vf_scale_d3d11.c", [
		[
			"    ///< Initialize filter's hardware device context",
			`    if (((AVHWFramesContext *)inl->hw_frames_ctx->data)->sw_format == AV_PIX_FMT_BGRA &&
        s->format == AV_PIX_FMT_NV12) {
        outlink->colorspace = AVCOL_SPC_BT709;
        outlink->color_range = AVCOL_RANGE_MPEG;
    }

    ///< Initialize filter's hardware device context`,
		],
		[".FourCC = s->input_format,", ".FourCC = 0,"],
		[
			"frames_ctx->initial_pool_size = 10;\n\n    if (ctx->extra_hw_frames > 0)\n        frames_ctx->initial_pool_size += ctx->extra_hw_frames;",
			"frames_ctx->initial_pool_size = 0;",
		],
		[
			"frames_hwctx->BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_VIDEO_ENCODER;",
			"frames_hwctx->BindFlags = D3D11_BIND_RENDER_TARGET;",
		],
		[
			"    ///< Process the frame\n",
			`    if (s->input_format == DXGI_FORMAT_B8G8R8A8_UNORM &&
        s->output_format == DXGI_FORMAT_NV12) {
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE input_space = { 0 };
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE output_space = { 0 };
        input_space.Usage = output_space.Usage = 1;
        input_space.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
        output_space.YCbCr_Matrix = 1;
        output_space.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        videoContext->lpVtbl->VideoProcessorSetStreamColorSpace(videoContext, s->processor, 0, &input_space);
        videoContext->lpVtbl->VideoProcessorSetOutputColorSpace(videoContext, s->processor, &output_space);
    }

    ///< Process the frame
`,
		],
		[
			"    out->format = AV_PIX_FMT_D3D11;",
			`    out->format = AV_PIX_FMT_D3D11;
    if (s->input_format == DXGI_FORMAT_B8G8R8A8_UNORM &&
        s->output_format == DXGI_FORMAT_NV12) {
        out->colorspace = AVCOL_SPC_BT709;
        out->color_range = AVCOL_RANGE_MPEG;
    }`,
		],
	]);
	await patch("libavfilter/vsrc_ddagrab.c", [
		["dda->time_timeout = av_rescale_q(1, dda->time_base, (AVRational) { 1, 1000 }) / 2;", "dda->time_timeout = 0;"],
		[
			"ret = next_frame_internal(avctx, &dda->probed_texture, 1);",
			"ret = next_frame_internal(avctx, &dda->probed_texture, 1);\n        if (ret == AVERROR(EAGAIN))\n            av_usleep(1000);",
		],
		[
			"ret = next_frame_internal(avctx, &cur_texture, 0);",
			"ret = next_frame_internal(avctx, &cur_texture, 0);\n            if (ret == AVERROR(EAGAIN) && !dda->dup_frames)\n                av_usleep(1000);",
		],
		["time_frame += TIMER_RES64;\n            }", "time_frame = now / av_q2d(dda->time_base);\n            }"],
		[
			"    if (dda->draw_mouse) {\n        ret = update_mouse_pointer",
			`    av_log(avctx, AV_LOG_DEBUG, "Desktop update: %lld, pointer: %lld, accumulated: %u\\n",
           (long long)frame_info.LastPresentTime.QuadPart,
           (long long)frame_info.LastMouseUpdateTime.QuadPart, frame_info.AccumulatedFrames);

    if (dda->draw_mouse) {
        ret = update_mouse_pointer`,
		],
	]);
}
