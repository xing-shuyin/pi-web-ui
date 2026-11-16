**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Image OCR

Click “识别文字”(Recognize text) in any image preview. When the plugin is not installed the same button installs it; after installation, click again to recognize.

- Recognizes Simplified Chinese and English by default; the result can be selected or copied in one click.
- No API key needed; images are recognized locally in the browser and never uploaded to an OCR service.
- First use downloads Tesseract.js 6.0.1, WASM and language data from jsDelivr; the language data is cached in the browser. The download can be cancelled.
- Remote images require CORS permission from the server. When reading fails, save the image as a local attachment and recognize that.
- Very small fonts, rotated text, handwriting and low-resolution images may be recognized inaccurately.
- Cancelling, closing the preview, switching images or disabling the plugin stops the task. There is no background polling and no always-on recognition engine.

`view:false` / `preload:true`: the client top level only registers the host API v15 `imageOcrProviders`, and a Worker is created only on click. Image reads reuse the app's original address and same-origin authentication, and app credentials are never sent to the CDN.

Image OCR recognizes Simplified Chinese and English in the shared image preview. The first click installs the plugin when needed. Recognition runs locally, requires no API key, and supports cancellation and copying. First use needs internet access for engine/language downloads. Remote images require CORS; attach them locally if access is blocked.
