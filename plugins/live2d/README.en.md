**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Live2D Companion Plugin

A page-level agent desktop companion based on **Live2D Cubism 2 / 3 / 4** and **PixiJS**, injecting lively interactive presence into `pi-web-ui`.

---

## 🌟 Core Features

- **Full support for multiple Live2D model generations**: supports both Cubism 2 (`.model.json`) and Cubism 3/4 (`.model3.json`), with 4 official open-source models bundled offline (🌸 Shizuku / 🌿 Haru / ☀️ Hiyori / 🐶 Mochishiba) — instant load with zero internet access!
- **Natural gaze and head tracking**:
  - **👀 Mouse Tracking**: pupils and head turn naturally as the cursor moves across the screen;
  - **💤 Natural Idle**: gentle breathing and random blinking;
- **Rich touch and motion feedback**:
  - Click the head: triggers a head-pat motion with a happy smile and a friendly speech bubble;
  - Click the body: shy or startled micro-reaction;
  - Double-click the character: triggers a wobble and randomly drops a warm greeting or an inspiration reminder;
- **Deep linkage with AI conversation sentiment**:
  - Agent thinking / calling tools: the companion shows a focused thinking face and pops a thought bubble;
  - Agent finishes a reply: the companion nods happily and greets;
  - Agent hits an error: the companion looks concerned and startled;
- **Fully free-floating page widget**:
  - **Free drag**: hold the left mouse button to drag anywhere on screen, with coordinates remembered automatically;
  - **Wheel zoom**: scroll the wheel over the widget to scale it as you like (0.4x ~ 2.0x);
  - **Quick floating action bar**: hover beside the widget and the expression, outfit, mode, settings and collapse buttons slide out smoothly;
  - **Right-click context menu**: right-click to open the full control menu;
  - **Minimal parked capsule**: after collapsing, a cute cat paw (🐾) stays in the bottom-right corner; click it to summon the companion back at any time;
  - **Global hotkey**: press `Alt+L`, or click the top-bar button, to toggle visibility at any time.
- **Click-through and transparent passthrough**:
  - **✨ Smart transparent-pixel passthrough**: on by default! While the cursor is over transparent areas around the character, all mouse clicks, text selection and wheel scrolling pass 100% naturally through to the underlying page and never block interaction; moving the cursor onto the character's solid body automatically enables head-pat and drag;
  - **👻 Full click-through mode (Ghost mode)**: enable in one click from the right-click menu, the floating quick bar (👻) or the settings panel; the companion turns purely decorative and intercepts no mouse interaction at all, never getting in the way of typing or reading docs;
- **One-click local model upload and management**:
  - **📦 ZIP archive upload**: drag in or pick a downloaded Live2D model `.zip`; the server unpacks it automatically, sniffs out `.model3.json` / `.model.json` and changes outfit immediately;
  - **📂 Local model folder upload**: select an already-extracted model directory on your computer and upload it in bulk;
  - **🗑️ Model management and cleanup**: delete uploaded custom models with one click in the settings panel to reclaim disk space.

---

## 🤖 Dedicated Agent Control Tool

The plugin registers a unified control tool `live2d` with the pi coding agent, so the agent can proactively interact with the companion while replying to the user:

| Tool name | Description                                                                                                        | Core actions (action)                                                                                                                                                |
| :-------- | :----------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live2d`  | Unified companion control tool: model switching, expressions, bubbles, music lip-sync alignment, blinking and more | `list_models`, `get_current_model`, `list_expressions`, `play_expression`, `show_bubble`, `switch_mode`, `switch_model`, `play_audio`, `stop_audio`, `trigger_blink` |

---

## 📡 HTTP API

The plugin exposes HTTP routes under `/plugins-api/live2d/*`:

- `GET /models`: list every configured model and the current state;
- `GET /current-model`: get the model currently on display;
- `GET /expressions`: list the model's expressions;
- `POST /action`: trigger a companion action (compatible with the `live2d_pet` protocol):
  - Play an expression: `{"action": "expression", "name": "happy"}`
  - Show a bubble: `{"action": "message", "text": "你好！", "duration": 4000}`
  - Switch mode: `{"action": "mode", "mode": "mouse"}`
  - Switch model: `{"action": "model_switch", "model": "shizuku"}`
