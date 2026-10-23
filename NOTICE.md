# Third-party notices

`dsh-win32-cua` loads and drives Windows system libraries. It ships no
third-party code of its own beyond what is listed here.

## koffi

- Package: [`koffi`](https://www.npmjs.com/package/koffi)
- License: MIT
- Use: resolved at runtime from the DSH profile's `node_modules`, never bundled.
- Why: koffi is the FFI layer that calls `user32.dll` and `gdi32.dll` from Node.

## Windows API

`SendInput`, `SetCursorPos`, `GetCursorPos`, `GetSystemMetrics`, `EnumWindows`,
`GetWindowTextW`, `GetWindowRect`, `GetWindowThreadProcessId`,
`GetForegroundWindow`, `SetForegroundWindow`, `ShowWindow`, `BringWindowToTop`,
`GetDC`, `ReleaseDC`, `SetProcessDpiAwarenessContext` (user32) and `BitBlt`,
`CreateCompatibleDC`, `CreateCompatibleBitmap`, `SelectObject`, `DeleteObject`,
`DeleteDC`, `GetDIBits` (gdi32) are documented public Windows APIs. The
signatures in `index.js` follow the Microsoft documentation; no proprietary
header or binary is redistributed.

## Coopanion (inspiration, not code)

- Project: [Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion)
- Relationship: the **approach** of driving Win32 through koffi, capturing the
  screen with `BitBlt | CAPTUREBLT`, and declaring per-monitor DPI awareness was
  learned by reading Coopanion's Cortico `desktop-pet` extension
  (`src/cua/engine/win32.ts`).
- What was **not** taken: no source file, no type declaration, no string, no
  struct layout and no code path is copied from that project. `index.js` here is
  an independent implementation written against the public Win32 documentation,
  with its own PNG encoder, its own key table and its own tool surface.
- Coopanion is used as a reference for what is possible, not as a dependency.

## DSH

- Project: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- The `dsh.bundle` / `cordis.patch.yml` bundle format and the `ctx.tools`
  registration contract follow the DSH plugin documentation shipped with the
  DSH agent preset skills.
