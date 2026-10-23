# dsh-win-cua

Windows computer-use for DeepSeek Harness: **real** mouse and keyboard input plus screen
capture, with no external driver.

## How it works

| Capability | Win32 API |
|---|---|
| Mouse move, click, wheel | `user32!SendInput` (INPUT_MOUSE) |
| Keyboard taps and shortcuts | `user32!SendInput` (INPUT_KEYBOARD) |
| Type literal text (incl. CJK) | `SendInput` with `KEYEVENTF_UNICODE` |
| Screen capture | `gdi32!BitBlt` + `CAPTUREBLT` (layered windows included) |
| Window list / focus | `user32!EnumWindows`, `ShowWindow`, `SetForegroundWindow` |
| DPI | `SetProcessDpiAwarenessContext(-4)` — per-monitor v2 |

FFI is [koffi](https://www.npmjs.com/package/koffi). Coordinates are physical pixels of
the virtual screen; the primary display's top-left is `(0, 0)`.

## Tools

**Look**
- `cua_screenshot` — capture the whole virtual screen to a PNG
- `cua_screenshot_window` — capture one window by handle (`PrintWindow`, screen-blit fallback)
- `cua_zoom` — capture a region and upscale it x1–x4 for reading small UI text
- `cua_windows` — visible top-level windows with bounds and flags
- `cua_app_list` — same list enriched with the process executable name
- `cua_cursor` — pointer position and virtual-screen geometry

**Act**
- `cua_mouse_move` — move the pointer along a human path
- `cua_mouse_click` — click / double / right / middle, optionally at x,y
- `cua_drag` — press, travel and release with the button held
- `cua_scroll` — wheel, vertical or horizontal
- `cua_key` — one key with optional modifiers
- `cua_type` — type text (unicode, incl. surrogate pairs)

**Window & app**
- `cua_focus_window` — restore and foreground a window
- `cua_wait` — sleep and/or poll until a window title appears
- `cua_app_launch` — launch an executable without a shell

Every tool declares `output { schema, render }` — the DSH tool registry rejects raw
definitions without it, so keep that shape when adding tools. Read-only tools are marked
`readOnly` and register as `isConcurrencySafe`.

## Config

Set in this bundle's `cordis.patch.yml` under `config`:

| Key | Default | Meaning |
|---|---|---|
| `humanize` | `true` | Pointer travels a smoothstep path, typing and clicking keep a human cadence |
| `keepScreenshots` | `30` | Newest captures kept per directory |
| `moveSteps` | `16` | Max pointer steps for a humanized move |
| `keyDelayMs` | `[12, 34]` | Per-character delay range for humanized typing |
| `clickSettleMs` | `[60, 140]` | Pause between the pointer arriving and the button press |
| `zoomFactor` | `2` | Default `cua_zoom` upscale factor (hard cap 4) |
| `zoomMaxPixels` | `24000000` | Largest upscaled image allowed |
| `maxWaitMs` | `10000` | Upper bound for `cua_wait` |
| `allowLaunch` | `true` | Set `false` to disable `cua_app_launch` |

Pointer targets are clamped into the virtual screen, and astral code points (emoji,
CJK extension B) are sent as surrogate pairs so `KEYEVENTF_UNICODE` types them correctly.

## No external driver

Unlike `dsh-computer-use` (which shells out to the `cua-driver` binary) this plugin calls
Win32 through koffi **inside the host process**: nothing to install, no daemon, no
`CUA_DRIVER_BIN`. The trade-off is honest: without the driver there is no UIA/accessibility
tree, so targeting is pixel-based — use `cua_zoom` / `cua_screenshot_window` to read a
window precisely before clicking.

## Install

From npm:

```powershell
dsh plugin --profile <profile> add dsh-win-cua
```

Or from a checkout / local directory:

```powershell
dsh plugin --profile <profile> add <this directory>
```

Or in the Desktop app: Plugin Manager → install bundle → pick this directory.

Windows only. `SendInput` injects into the session whose input queue is active — a window
on a locked or disconnected desktop receives nothing.

## Changelog

### 0.2.0

- New look tools: `cua_screenshot_window` (PrintWindow with screen-blit fallback),
  `cua_zoom` (region capture upscaled x1–x4), `cua_app_list` (windows with process names).
- New act tools: `cua_drag`, `cua_wait`, `cua_app_launch` (disabled with `allowLaunch: false`).
- `humanize` is now a real config knob: smoothstep pointer path, per-character typing
  delay and click settle range, with `moveSteps` / `keyDelayMs` / `clickSettleMs` tuning.
- PNG encoder, screenshot retention (`keepScreenshots`) and coordinate clamping tightened.

### 0.1.0

First public release: screenshot, cursor, window list/focus, mouse move/click/scroll,
key press and unicode typing.
