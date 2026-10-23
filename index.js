/**
 * dsh-win-cua — Windows computer-use for DeepSeek Harness.
 *
 * Real mouse and keyboard input through user32 `SendInput`, screen capture through
 * GDI `BitBlt` (CAPTUREBLT so layered windows are included), and a top-level window
 * list through `EnumWindows`. The FFI layer is koffi, the same approach Coopanion's
 * desktop-pet uses; no external driver process is involved.
 *
 * Coordinates are physical pixels of the virtual screen (primary top-left is 0,0),
 * because the process declares itself per-monitor DPI aware before anything else.
 */
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCREEN_DIR = join(tmpdir(), 'dsh-cua-screens');
const CAPTURE_PREFIXES = ['screen-', 'window-', 'zoom-'];

/**
 * Resolve koffi from wherever this profile keeps its packages. A bundle installed by
 * link lives outside the profile, so a plain `import 'koffi'` cannot see it; the host
 * exposes DSH_PROFILE_DIR for exactly that case. The fallbacks cover running from the
 * profile itself and a checkout next to it.
 */
function loadKoffi() {
  const candidates = [
    process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'node_modules', 'koffi'),
    join(process.cwd(), 'node_modules', 'koffi'),
    join(import.meta.dirname, 'node_modules', 'koffi'),
  ].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      return createRequire(join(candidate, 'noop.cjs'))(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`cannot load koffi (tried ${candidates.length} locations): ${errors.join(' | ')}`);
}

let native = null;

/** Load Win32 through koffi once. */
function loadNative() {
  if (native) return native;
  if (process.platform !== 'win32') throw new Error('dsh-win32-cua only works on Windows');
  const koffi = loadKoffi();

  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  koffi.alias('HANDLE', 'void *');
  koffi.alias('HWND', 'HANDLE');

  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long', dy: 'long', mouseData: 'uint32_t', dwFlags: 'uint32_t',
    time: 'uint32_t', dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t',
    time: 'uint32_t', dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
    uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t',
  });
  const INPUT = koffi.struct('INPUT', {
    type: 'uint32_t',
    u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
  });
  const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t',
    biPlanes: 'uint16_t', biBitCount: 'uint16_t', biCompression: 'uint32_t',
    biSizeImage: 'uint32_t', biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t',
    biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
  });
  const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)');

  const api = {
    koffi,
    SetProcessDpiAwarenessContext: user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)'),
    SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int size)'),
    GetDC: user32.func('HANDLE __stdcall GetDC(HWND hwnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(HWND hwnd, HANDLE dc)'),
    EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(HWND hwnd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(HWND hwnd, _Out_ uint16_t *buf, int max)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hwnd, _Out_ RECT *rect)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32_t *pid)'),
    GetForegroundWindow: user32.func('HWND __stdcall GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(HWND hwnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(HWND hwnd, int cmd)'),
    BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(HWND hwnd)'),
    CreateCompatibleDC: gdi32.func('HANDLE __stdcall CreateCompatibleDC(HANDLE dc)'),
    CreateCompatibleBitmap: gdi32.func('HANDLE __stdcall CreateCompatibleBitmap(HANDLE dc, int w, int h)'),
    SelectObject: gdi32.func('HANDLE __stdcall SelectObject(HANDLE dc, HANDLE obj)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(HANDLE obj)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(HANDLE dc)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(HANDLE dst, int x, int y, int w, int h, HANDLE src, int sx, int sy, uint32_t rop)'),
    GetDIBits: gdi32.func('int __stdcall GetDIBits(HANDLE dc, HANDLE bmp, uint32_t start, uint32_t lines, void *bits, _Inout_ BITMAPINFOHEADER *bmi, uint32_t usage)'),
    PrintWindow: user32.func('bool __stdcall PrintWindow(HWND hwnd, HANDLE dc, uint32_t flags)'),
    GetWindowDC: user32.func('HANDLE __stdcall GetWindowDC(HWND hwnd)'),
    OpenProcess: kernel32.func('HANDLE __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(HANDLE proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(HANDLE handle)'),
    structs: { POINT, RECT, INPUT, BITMAPINFOHEADER },
  };
  try {
    // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    api.SetProcessDpiAwarenessContext(-4);
  } catch {
    /* older Windows: best effort */
  }
  native = api;
  return api;
}

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const MAX_COORD = 65535;
const SW_RESTORE = 9;
const MOUSEEVENTF_HWHEEL = 0x01000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PW_RENDERFULLCONTENT = 0x00000002;
const MAX_CAPTURE_PIXELS = 40_000_000;

/** Behaviour defaults; the host may override them through cordis.patch.yml config. */
const DEFAULTS = {
  humanize: true,
  keepScreenshots: 30,
  moveSteps: 16,
  keyDelayMs: [12, 34],
  clickSettleMs: [60, 140],
  zoomFactor: 2,
  zoomMaxPixels: 24_000_000,
  maxWaitMs: 10_000,
  allowLaunch: true,
};
const CFG = { ...DEFAULTS };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const between = (range) => {
  const pair = Array.isArray(range) ? range : [Number(range) || 0, Number(range) || 0];
  const min = Number(pair[0]) || 0;
  const max = Number(pair[1] ?? min) || 0;
  return min + Math.random() * Math.max(0, max - min);
};

/**
 * Raw `tools.register()` does not validate arguments the way `defineTool` does,
 * so every coordinate has to be checked here — otherwise a missing number turns
 * into a NaN deep inside Buffer.alloc instead of a message the model can act on.
 */
function requireNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number (received ${JSON.stringify(value)})`);
  return n;
}

/** Clamp a pointer target into the virtual screen so a bad coordinate cannot fly off. */
function clampPoint(A, x, y) {
  const screen = virtualScreen(A);
  const px = Math.round(requireNumber(x, 'x'));
  const py = Math.round(requireNumber(y, 'y'));
  return {
    x: Math.min(Math.max(px, screen.x), screen.x + Math.max(0, screen.width - 1)),
    y: Math.min(Math.max(py, screen.y), screen.y + Math.max(0, screen.height - 1)),
  };
}

/**
 * UTF-16 code units one KEYEVENTF_UNICODE scan needs. Astral code points
 * (emoji, CJK extensions) travel as a surrogate pair; sending the raw code
 * point would truncate to 16 bits and type the wrong glyph.
 */
function unicodeUnits(code) {
  if (code <= 0xffff) return [code];
  const rest = code - 0x10000;
  return [0xd800 + ((rest >> 10) & 0x3ff), 0xdc00 + (rest & 0x3ff)];
}

/** Build a mouse INPUT record. */
function mouseInput({ dx = 0, dy = 0, data = 0, flags = 0 }) {
  return {
    type: INPUT_MOUSE,
    u: { mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  };
}

/** Build a keyboard INPUT record. */
function keyInput(vk, flags, scan = 0) {
  return {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  };
}

/** Send INPUT records; koffi converts a plain array of structs in place. */
function sendInputs(A, records) {
  const sent = A.SendInput(records.length, records, A.koffi.sizeof(A.structs.INPUT));
  if (sent !== records.length) throw new Error(`SendInput accepted ${sent}/${records.length} records`);
}

function sendInput(A, record) {
  sendInputs(A, [record]);
}

/** Virtual-screen origin and size in physical pixels. */
function virtualScreen(A) {
  return {
    x: A.GetSystemMetrics(76),
    y: A.GetSystemMetrics(77),
    width: A.GetSystemMetrics(78),
    height: A.GetSystemMetrics(79),
  };
}

/** Screen pixels to the 0..65535 absolute space. */
function toAbsolute(A, x, y) {
  const screen = virtualScreen(A);
  return {
    ax: Math.round(((x - screen.x) * MAX_COORD) / Math.max(1, screen.width - 1)),
    ay: Math.round(((y - screen.y) * MAX_COORD) / Math.max(1, screen.height - 1)),
  };
}

/** Pull BGRA rows out of a selected bitmap. */
function readBits(A, dc, bmp, width, height) {
  if (width * height > MAX_CAPTURE_PIXELS) throw new Error(`capture too large: ${width}x${height}`);
  const bmi = {
    biSize: A.koffi.sizeof(A.structs.BITMAPINFOHEADER),
    biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32,
    biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
    biClrUsed: 0, biClrImportant: 0,
  };
  const buffer = Buffer.alloc(width * height * 4);
  const lines = A.GetDIBits(dc, bmp, 0, height, buffer, bmi, 0);
  if (lines !== height) throw new Error(`GetDIBits returned ${lines}/${height} lines`);
  return { width, height, data: buffer };
}

/** BitBlt a screen rectangle (virtual-screen coordinates) into a fresh memory bitmap. */
function captureRect(A, sx, sy, width, height) {
  const left = Math.round(requireNumber(sx, 'x'));
  const top = Math.round(requireNumber(sy, 'y'));
  const w = Math.max(1, Math.round(requireNumber(width, 'width')));
  const h = Math.max(1, Math.round(requireNumber(height, 'height')));
  const srcDc = A.GetDC(null);
  if (!srcDc) throw new Error('GetDC returned null');
  const memDc = A.CreateCompatibleDC(srcDc);
  const bmp = A.CreateCompatibleBitmap(srcDc, w, h);
  const old = A.SelectObject(memDc, bmp);
  try {
    if (!A.BitBlt(memDc, 0, 0, w, h, srcDc, left, top, SRCCOPY | CAPTUREBLT)) {
      throw new Error('BitBlt failed');
    }
    // GetDIBits requires the bitmap to be selected out of the DC.
    A.SelectObject(memDc, old);
    return readBits(A, memDc, bmp, w, h);
  } finally {
    A.SelectObject(memDc, old);
    A.DeleteObject(bmp);
    A.DeleteDC(memDc);
    A.ReleaseDC(null, srcDc);
  }
}

/** Grab the whole virtual screen as raw BGRA rows. */
function captureScreen(A) {
  const screen = virtualScreen(A);
  return captureRect(A, screen.x, screen.y, screen.width, screen.height);
}

/**
 * Capture one window. PrintWindow asks the window to render itself into our DC
 * (so occluded windows still come out right); when the window refuses, fall back
 * to blitting its on-screen rectangle.
 */
function captureWindow(A, hwnd) {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!A.GetWindowRect(hwnd, rect)) throw new Error(`GetWindowRect failed for handle ${hwnd}`);
  const width = Math.max(1, rect.right - rect.left);
  const height = Math.max(1, rect.bottom - rect.top);
  const bounds = { x: rect.left, y: rect.top, width, height };
  if (width * height > MAX_CAPTURE_PIXELS) throw new Error(`window too large to capture: ${width}x${height}`);
  const winDc = A.GetWindowDC(hwnd);
  if (!winDc) throw new Error(`GetWindowDC returned null for handle ${hwnd}`);
  const memDc = A.CreateCompatibleDC(winDc);
  const bmp = A.CreateCompatibleBitmap(winDc, width, height);
  const old = A.SelectObject(memDc, bmp);
  try {
    const printed = A.PrintWindow(hwnd, memDc, PW_RENDERFULLCONTENT);
    if (!printed) {
      const screenDc = A.GetDC(null);
      if (!screenDc) throw new Error('GetDC returned null');
      try {
        if (!A.BitBlt(memDc, 0, 0, width, height, screenDc, bounds.x, bounds.y, SRCCOPY | CAPTUREBLT)) {
          throw new Error('window capture failed (PrintWindow and BitBlt both refused)');
        }
      } finally {
        A.ReleaseDC(null, screenDc);
      }
    }
    A.SelectObject(memDc, old);
    return { ...readBits(A, memDc, bmp, width, height), bounds, printed: Boolean(printed) };
  } finally {
    A.SelectObject(memDc, old);
    A.DeleteObject(bmp);
    A.DeleteDC(memDc);
    A.ReleaseDC(hwnd, winDc);
  }
}

/** Nearest-neighbour upscale: crisp pixels, which is what reading small UI text needs. */
function scaleBgra({ width, height, data }, factor) {
  const scale = Math.max(1, Math.floor(factor));
  if (scale === 1) return { width, height, data };
  const ow = width * scale;
  const oh = height * scale;
  if (ow * oh > MAX_CAPTURE_PIXELS) throw new Error(`zoomed image too large: ${ow}x${oh}`);
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y += 1) {
    const rowBase = Math.min(height - 1, Math.floor(y / scale)) * width;
    const target = y * ow;
    for (let x = 0; x < ow; x += 1) {
      const s = (rowBase + Math.min(width - 1, Math.floor(x / scale))) * 4;
      const t = (target + x) * 4;
      out[t] = data[s];
      out[t + 1] = data[s + 1];
      out[t + 2] = data[s + 2];
      out[t + 3] = data[s + 3];
    }
  }
  return { width: ow, height: oh, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode BGRA rows as an RGBA PNG without an image library. */
function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    raw[target] = 0;
    const source = y * stride;
    for (let x = 0; x < width; x += 1) {
      const s = source + x * 4;
      const t = target + 1 + x * 4;
      raw[t] = data[s + 2];
      raw[t + 1] = data[s + 1];
      raw[t + 2] = data[s];
      raw[t + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Read a wide window title. */
function windowTitle(A, hwnd) {
  const buffer = Buffer.alloc(512 * 2);
  const length = A.GetWindowTextW(hwnd, buffer, 512);
  return length > 0 ? buffer.toString('utf16le', 0, length * 2) : '';
}

/** Every visible top-level window with a title. */
function listWindows(A) {
  const windows = [];
  const foreground = Number(A.koffi.address(A.GetForegroundWindow()));
  const proc = A.koffi.register((hwnd) => {
    if (!A.IsWindowVisible(hwnd)) return true;
    const title = windowTitle(A, hwnd);
    if (!title) return true;
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    A.GetWindowRect(hwnd, rect);
    const pid = [0];
    A.GetWindowThreadProcessId(hwnd, pid);
    const handle = Number(A.koffi.address(hwnd));
    windows.push({
      handle,
      title,
      pid: pid[0],
      minimized: Boolean(A.IsIconic(hwnd)),
      active: handle === foreground,
      bounds: {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      },
    });
    return true;
  }, A.koffi.pointer('EnumWindowsProc'));
  try {
    A.EnumWindows(proc, 0);
  } finally {
    A.koffi.unregister(proc);
  }
  return windows;
}

/** Virtual-key names a model is likely to use. */
const VIRTUAL_KEYS = {
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, win: 0x5b, meta: 0x5b,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2c, pause: 0x13,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};
for (let i = 0; i < 26; i += 1) VIRTUAL_KEYS[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i <= 9; i += 1) VIRTUAL_KEYS[String(i)] = 0x30 + i;

function resolveKey(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) throw new Error('empty key name');
  const code = VIRTUAL_KEYS[key];
  if (code !== undefined) return code;
  throw new Error(`unknown key: ${name}`);
}

/** Virtual keys that live on the "extended" part of the keyboard. */
const EXTENDED_KEYS = new Set([
  0x2d, // insert
  0x2e, // delete
  0x24, // home
  0x23, // end
  0x21, // page up
  0x22, // page down
  0x25, // left
  0x26, // up
  0x27, // right
  0x28, // down
  0x5b, // win
  0x90, // num lock
  0x2c, // print screen
]);

/** Tap one key, optionally with modifiers held. */
function tapKey(A, key, modifiers = []) {
  const mods = modifiers.map(resolveKey);
  for (const code of mods) sendInput(A, keyInput(code, 0));
  const code = resolveKey(key);
  // Arrows/navigation keys need EXTENDEDKEY or apps that read scan codes see the keypad.
  const extended = EXTENDED_KEYS.has(code) ? KEYEVENTF_EXTENDEDKEY : 0;
  sendInput(A, keyInput(code, extended));
  sendInput(A, keyInput(code, extended | KEYEVENTF_KEYUP));
  for (const mod of mods.reverse()) sendInput(A, keyInput(mod, KEYEVENTF_KEYUP));
}

/** Type literal text through unicode keyboard events at a human cadence. */
async function typeText(A, text, humanize) {
  const chars = [...String(text)];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // "\r\n" must produce one Enter, not two.
    if (code === 13 && chars[i + 1] === '\n') continue;
    if (code === 10 || code === 13) {
      sendInput(A, keyInput(0x0d, 0));
      sendInput(A, keyInput(0x0d, KEYEVENTF_KEYUP));
      if (humanize) await sleep(between(CFG.keyDelayMs));
      continue;
    }
    if (code < 0x20) continue;
    for (const unit of unicodeUnits(code)) {
      sendInput(A, keyInput(0, KEYEVENTF_UNICODE, unit));
      sendInput(A, keyInput(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, unit));
    }
    if (humanize) await sleep(between(CFG.keyDelayMs));
  }
}

/** Move the pointer to a screen pixel. */
function moveMouse(A, x, y) {
  const { ax, ay } = toAbsolute(A, Math.round(x), Math.round(y));
  // VIRTUALDESK is required, otherwise absolute coordinates are mapped onto the
  // primary monitor only and a second display can never be reached.
  sendInput(A, mouseInput({
    dx: ax, dy: ay,
    flags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
  }));
}

/**
 * Move the pointer like a hand does: a smoothstep path in a few steps instead of
 * one teleport, so hover states, tooltips and drag targets behave realistically.
 * @returns the clamped destination actually used.
 */
async function moveMouseHuman(A, x, y, humanize) {
  const target = clampPoint(A, x, y);
  if (!humanize) {
    moveMouse(A, target.x, target.y);
    return target;
  }
  const from = cursorPosition(A);
  const distance = Math.hypot(target.x - from.x, target.y - from.y);
  const steps = Math.max(4, Math.min(CFG.moveSteps, Math.round(distance / 55)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = t * t * (3 - 2 * t);
    moveMouse(A, from.x + (target.x - from.x) * eased, from.y + (target.y - from.y) * eased);
    await sleep(6 + Math.random() * 9);
  }
  moveMouse(A, target.x, target.y);
  return target;
}

/** Press and release a mouse button. */
function clickMouse(A, button = 'left', double = false) {
  const table = {
    left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
    right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
    middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP],
  };
  const pair = table[String(button).toLowerCase()];
  if (!pair) throw new Error(`unknown mouse button: ${button}`);
  for (let i = 0; i < (double ? 2 : 1); i += 1) {
    sendInput(A, mouseInput({ flags: pair[0] }));
    sendInput(A, mouseInput({ flags: pair[1] }));
  }
}

/** Scroll the wheel; positive is up (or right on the horizontal axis). Returns the signed delta. */
function scrollWheel(A, amount, axis = 'vertical') {
  const delta = Math.round(requireNumber(amount, 'amount'));
  if (!delta) return 0;
  const flag = String(axis).toLowerCase() === 'horizontal' ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
  sendInput(A, mouseInput({ data: delta, flags: flag }));
  return delta;
}

/** Encode one frame to PNG on disk, then prune old captures. */
function savePng(frame, directory, prefix = 'screen') {
  const target = directory || SCREEN_DIR;
  mkdirSync(target, { recursive: true });
  const png = encodePng(frame);
  const path = join(target, `${prefix}-${Date.now()}.png`);
  writeFileSync(path, png);
  pruneScreens(target);
  return { path, width: frame.width, height: frame.height, bytes: png.length };
}

/** Screen capture to a PNG on disk, keeping only the newest screenshots. */
function screenshot(A, directory) {
  return savePng(captureScreen(A), directory);
}

/** Retention is best effort: a locked or unreadable file must not fail the capture. */
function pruneScreens(directory) {
  const keep = Number(CFG.keepScreenshots);
  if (!Number.isFinite(keep) || keep <= 0) return;
  try {
    const names = readdirSync(directory)
      .filter((name) => CAPTURE_PREFIXES.some((prefix) => name.startsWith(prefix)) && name.endsWith('.png'))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      try {
        unlinkSync(join(directory, name));
      } catch {
        /* keep going */
      }
    }
  } catch {
    /* retention is best effort */
  }
}

/** Read the pointer position. */
function cursorPosition(A) {
  const point = { x: 0, y: 0 };
  A.GetCursorPos(point);
  return { x: point.x, y: point.y };
}

/** Executable file name behind a process id, or '' when it cannot be read. */
function exeName(A, pid) {
  if (!pid) return '';
  const handle = A.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return '';
  try {
    const size = [512];
    const buffer = Buffer.alloc(512 * 2);
    if (!A.QueryFullProcessImageNameW(handle, 0, buffer, size)) return '';
    const full = buffer.toString('utf16le', 0, Math.max(0, size[0]) * 2);
    return full.split(/[\\/]/).pop() || full;
  } finally {
    A.CloseHandle(handle);
  }
}

/**
 * Press, travel and release like a hand: the button stays down for the whole
 * path so drag targets that watch hover state still see it.
 */
async function dragMouse(A, fromX, fromY, toX, toY, humanize) {
  const start = clampPoint(A, fromX, fromY);
  const end = clampPoint(A, toX, toY);
  await moveMouseHuman(A, start.x, start.y, humanize);
  if (humanize) await sleep(between([40, 90]));
  sendInput(A, mouseInput({ flags: MOUSEEVENTF_LEFTDOWN }));
  try {
    if (humanize) {
      const steps = Math.max(6, Math.min(CFG.moveSteps * 2, Math.round(Math.hypot(end.x - start.x, end.y - start.y) / 35)));
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const eased = t * t * (3 - 2 * t);
        moveMouse(A, start.x + (end.x - start.x) * eased, start.y + (end.y - start.y) * eased);
        await sleep(8 + Math.random() * 10);
      }
    }
    moveMouse(A, end.x, end.y);
    if (humanize) await sleep(between([50, 110]));
  } finally {
    sendInput(A, mouseInput({ flags: MOUSEEVENTF_LEFTUP }));
  }
  return { from: start, to: end };
}

/** Sleep, and optionally poll until a window whose title contains `title` exists. */
async function waitFor(A, { ms, title, timeoutMs }) {
  const budget = Math.max(0, Math.min(timeoutMs === undefined ? CFG.maxWaitMs : requireNumber(timeoutMs, 'timeoutMs'), CFG.maxWaitMs));
  const started = Date.now();
  const sleepBudget = Math.min(ms === undefined ? 0 : Math.max(0, requireNumber(ms, 'ms')), budget);
  if (sleepBudget > 0) await sleep(sleepBudget);
  if (!title) return { waitedMs: Date.now() - started, matched: false, timedOut: false };
  const needle = String(title).toLowerCase();
  while (Date.now() - started < budget) {
    if (listWindows(A).some((w) => w.title.toLowerCase().includes(needle))) {
      return { waitedMs: Date.now() - started, matched: true, timedOut: false };
    }
    await sleep(150);
  }
  return { waitedMs: Date.now() - started, matched: false, timedOut: true };
}

/** True when the path exists and is a regular file (not a directory). */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve an executable name or path without ever going through a shell. */
function resolveExe(name) {
  const raw = String(name || '').trim();
  if (!raw) throw new Error('empty executable name');
  if (/[\\/]/.test(raw)) {
    if (!isFile(raw)) throw new Error(`not an executable file: ${raw}`);
    return raw;
  }
  const exe = raw.toLowerCase().endsWith('.exe') ? raw : `${raw}.exe`;
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, exe);
    if (isFile(candidate)) return candidate;
  }
  throw new Error(`executable not found on PATH: ${raw} (pass an absolute path instead)`);
}

/**
 * Spawn an executable and wait until the OS confirms the process started.
 * `spawn` reports failures asynchronously through an 'error' event; without this
 * listener a bad path or a refused launch would crash the host process.
 */
async function launchApp(args) {
  const exe = resolveExe(args.exe);
  const argv = Array.isArray(args.args) ? args.args.map(String) : [];
  const child = spawn(exe, argv, { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return { ok: true, exe, pid: child.pid ?? 0 };
}

/**
 * JSON-Schema helpers for raw `tools.register()` definitions. The host registry
 * requires every tool to carry `output { schema, render }` and a lossless-JSON
 * object-root `parameters` schema; annotations (`description`, `title`) are the
 * only extra keywords allowed on a node.
 */
const obj = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const text = (value) => [{ type: 'text', text: String(value) }];

/** Reusable output-schema fragments so every object node declares its fields. */
const point = (description) => ({
  type: 'object',
  description,
  properties: { x: num('X in virtual-screen pixels.'), y: num('Y in virtual-screen pixels.') },
});
const rect = (description) => ({
  type: 'object',
  description,
  properties: {
    x: num('Left in virtual-screen pixels.'),
    y: num('Top in virtual-screen pixels.'),
    width: num('Width in pixels.'),
    height: num('Height in pixels.'),
  },
});
const windowItem = (description) => ({
  type: 'object',
  description,
  properties: {
    handle: { type: 'integer', description: 'Window handle; pass it to cua_focus_window.' },
    title: str('Window title.'),
    pid: { type: 'integer', description: 'Owner process id.' },
    active: bool('Is the foreground window.'),
    minimized: bool('Is minimized.'),
    bounds: rect('Window rect on the virtual screen.'),
  },
});

const TOOL_DECLS = [
  {
    name: 'cua_screenshot',
    description:
      'Capture the whole virtual screen to a PNG file and return its path and pixel size. Look before clicking so you act on what is really on screen.',
    parameters: obj({
      directory: str('Optional absolute directory for the PNG; defaults to a temp folder.'),
    }),
    run: (A, args) => screenshot(A, args.directory),
    out: {
      schema: obj({
        path: str('Absolute path of the written PNG.'),
        width: { type: 'integer', description: 'Capture width in pixels.' },
        height: { type: 'integer', description: 'Capture height in pixels.' },
        bytes: { type: 'integer', description: 'PNG size in bytes.' },
      }),
      render: (_args, v) => text(`Screenshot saved: ${v.path} (${v.width}x${v.height}, ${v.bytes} bytes). Read this file to view it.`),
    },
    readOnly: true,
  },
  {
    name: 'cua_mouse_move',
    description: 'Move the real mouse pointer to a screen pixel (virtual-screen coordinates).',
    parameters: obj({
      x: num('Screen X in pixels.'),
      y: num('Screen Y in pixels.'),
    }, ['x', 'y']),
    run: async (A, args) => {
      const point = await moveMouseHuman(A, args.x, args.y, CFG.humanize);
      return { ok: true, ...point };
    },
    out: {
      schema: obj({ ok: bool('Always true.'), x: num('Pointer X.'), y: num('Pointer Y.') }),
      render: (_args, v) => text(`Pointer moved to (${v.x}, ${v.y}).`),
    },
  },
  {
    name: 'cua_mouse_click',
    description:
      'Click a real mouse button, optionally moving to x/y first. Double clicks repeat the press-release pair.',
    parameters: obj({
      x: num('Optional screen X; omit to click where the pointer is.'),
      y: num('Optional screen Y; omit to click where the pointer is.'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
      double: bool('Double click when true.'),
    }),
    run: async (A, args) => {
      if (typeof args.x === 'number' && typeof args.y === 'number') await moveMouseHuman(A, args.x, args.y, CFG.humanize);
      if (CFG.humanize) await sleep(between(CFG.clickSettleMs));
      const double = Boolean(args.double);
      clickMouse(A, args.button, false);
      if (double) {
        // A real double click needs a visible gap; two immediate pairs collapse into one.
        await sleep(between([50, 90]));
        clickMouse(A, args.button, false);
      }
      return { ok: true, ...cursorPosition(A), button: args.button || 'left', double };
    },
    out: {
      schema: obj({
        ok: bool('Always true.'),
        button: str('Button used.'),
        x: num('Pointer X.'),
        y: num('Pointer Y.'),
        double: bool('Whether the click was doubled.'),
      }),
      render: (_args, v) => text(`${v.double ? 'Double-clicked' : 'Clicked'} ${v.button} button at (${v.x}, ${v.y}).`),
    },
  },
  {
    name: 'cua_scroll',
    description: 'Turn the real mouse wheel at the pointer position; positive scrolls up (or right on the horizontal axis).',
    parameters: obj({
      amount: num('Wheel delta (120 per notch).'),
      axis: { type: 'string', enum: ['vertical', 'horizontal'], description: 'Scroll axis; defaults to vertical.' },
    }, ['amount']),
    run: (A, args) => {
      const amount = scrollWheel(A, args.amount, args.axis);
      return { ok: true, amount, axis: String(args.axis || 'vertical').toLowerCase() };
    },
    out: {
      schema: obj({
        ok: bool('Always true.'),
        amount: { type: 'integer', description: 'Signed wheel delta that was sent (0 when amount was 0).' },
        axis: str('Axis that was used.'),
      }),
      render: (_args, v) => text(`Wheel scrolled ${v.amount} (${v.axis}).`),
    },
  },
  {
    name: 'cua_key',
    description:
      'Press a real key with optional modifiers. Key names: enter, esc, tab, space, backspace, delete, arrows, f1-f12, letters, digits. Modifiers: ctrl, shift, alt, win.',
    parameters: obj({
      key: str('Key to press, e.g. "enter", "a", "f5".'),
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers to hold, e.g. ["ctrl"].' },
    }, ['key']),
    run: (A, args) => {
      tapKey(A, args.key, args.modifiers || []);
      return { ok: true };
    },
    out: {
      schema: obj({ ok: bool('Always true.') }),
      render: (_args, v) => text(`Key press sent (${v.ok ? 'ok' : 'failed'}).`),
    },
  },
  {
    name: 'cua_type',
    description: 'Type literal text into the focused window through real unicode key events.',
    parameters: obj({
      text: str('Text to type.'),
    }, ['text']),
    run: async (A, args) => {
      await typeText(A, args.text, CFG.humanize);
      return { ok: true, chars: [...String(args.text)].length };
    },
    out: {
      schema: obj({ ok: bool('Always true.'), chars: { type: 'integer', description: 'Characters typed.' } }),
      render: (_args, v) => text(`Typed ${v.chars} characters.`),
    },
  },
  {
    name: 'cua_windows',
    description: 'List visible top-level windows: handle, title, process id, bounds, active and minimized flags.',
    parameters: obj({}),
    run: (A) => ({ windows: listWindows(A) }),
    out: {
      schema: obj({
        windows: { type: 'array', items: windowItem('One visible window.'), description: 'Visible top-level windows.' },
      }),
      render: (_args, v) => text(
        `Found ${v.windows.length} window(s):\n` + v.windows.map((w) =>
          `#${w.handle}${w.active ? ' [active]' : ''}${w.minimized ? ' [minimized]' : ''} "${w.title}" pid=${w.pid} ${w.bounds.width}x${w.bounds.height} @ (${w.bounds.x},${w.bounds.y})`
        ).join('\n')),
    },
    readOnly: true,
  },
  {
    name: 'cua_focus_window',
    description: 'Restore a minimized window and bring it to the foreground by its handle from cua_windows.',
    parameters: obj({
      handle: num('Window handle from cua_windows.'),
    }, ['handle']),
    run: (A, args) => {
      const handle = requireNumber(args.handle, 'handle');
      const hwnd = A.koffi.address(handle);
      A.ShowWindow(hwnd, SW_RESTORE);
      A.BringWindowToTop(hwnd);
      A.SetForegroundWindow(hwnd);
      // SetForegroundWindow can be refused by the foreground lock; report what happened
      // instead of claiming success and letting the model type into the wrong window.
      const active = Number(A.koffi.address(A.GetForegroundWindow())) === Math.trunc(handle);
      return { ok: active, handle, active };
    },
    out: {
      schema: obj({
        ok: bool('True when the window actually holds the foreground.'),
        handle: num('Focused window handle.'),
        active: bool('Whether it is the foreground window after the call.'),
      }),
      render: (_args, v) => text(
        v.active
          ? `Window ${v.handle} is in the foreground.`
          : `Window ${v.handle} was restored but did NOT take the foreground (Windows foreground lock?).`),
    },
  },
  {
    name: 'cua_cursor',
    description: 'Report the current pointer position and the virtual-screen geometry.',
    parameters: obj({}),
    run: (A) => ({ ...cursorPosition(A), screen: virtualScreen(A) }),
    out: {
      schema: obj({
        x: num('Pointer X.'),
        y: num('Pointer Y.'),
        screen: rect('Virtual-screen geometry.'),
      }),
      render: (_args, v) => text(`Cursor at (${v.x}, ${v.y}); virtual screen: ${JSON.stringify(v.screen)}.`),
    },
    readOnly: true,
  },
  {
    name: 'cua_zoom',
    description:
      'Capture a screen region and upscale it so small text, icons and menu items become readable. Coordinates are virtual-screen pixels.',
    parameters: obj({
      x: num('Region left in virtual-screen pixels.'),
      y: num('Region top in virtual-screen pixels.'),
      width: num('Region width in pixels.'),
      height: num('Region height in pixels.'),
      factor: num('Integer upscale factor (default 2, max 4).'),
      directory: str('Optional output directory for the PNG.'),
    }, ['x', 'y', 'width', 'height']),
    run: (A, args) => {
      const screen = virtualScreen(A);
      const reqX = requireNumber(args.x, 'x');
      const reqY = requireNumber(args.y, 'y');
      const reqW = requireNumber(args.width, 'width');
      const reqH = requireNumber(args.height, 'height');
      const x = Math.max(screen.x, Math.round(reqX));
      const y = Math.max(screen.y, Math.round(reqY));
      const right = Math.min(screen.x + screen.width, Math.round(reqX + reqW));
      const bottom = Math.min(screen.y + screen.height, Math.round(reqY + reqH));
      const w = right - x;
      const h = bottom - y;
      if (w <= 0 || h <= 0) throw new Error('zoom region falls outside the virtual screen');
      let factor = Math.max(1, Math.min(4, Math.floor(Number(args.factor) || CFG.zoomFactor)));
      while (factor > 1 && w * factor * h * factor > CFG.zoomMaxPixels) factor -= 1;
      const scaled = scaleBgra(captureRect(A, x, y, w, h), factor);
      const saved = savePng(scaled, args.directory, 'zoom');
      return { ...saved, factor, source: { x, y, width: w, height: h } };
    },
    out: {
      schema: obj({
        path: str('Absolute path of the written PNG.'),
        width: { type: 'integer', description: 'Saved width in pixels.' },
        height: { type: 'integer', description: 'Saved height in pixels.' },
        bytes: { type: 'integer', description: 'PNG size in bytes.' },
        factor: { type: 'integer', description: 'Upscale factor actually used.' },
        source: rect('Captured region in virtual-screen pixels.'),
      }),
      render: (_args, v) => text(
        `Zoom saved: ${v.path} — ${v.source.width}x${v.source.height} at (${v.source.x},${v.source.y}) scaled x${v.factor} to ${v.width}x${v.height}.`),
    },
    readOnly: true,
  },
  {
    name: 'cua_screenshot_window',
    description:
      'Capture one window by handle. Uses PrintWindow so occluded windows still render correctly, with a screen blit fallback.',
    parameters: obj({
      handle: num('Window handle from cua_windows.'),
      directory: str('Optional output directory for the PNG.'),
    }, ['handle']),
    run: (A, args) => {
      const hwnd = A.koffi.address(requireNumber(args.handle, 'handle'));
      const frame = captureWindow(A, hwnd);
      const saved = savePng(frame, args.directory, 'window');
      return { ...saved, bounds: frame.bounds, printed: frame.printed };
    },
    out: {
      schema: obj({
        path: str('Absolute path of the written PNG.'),
        width: { type: 'integer', description: 'Image width in pixels.' },
        height: { type: 'integer', description: 'Image height in pixels.' },
        bytes: { type: 'integer', description: 'PNG size in bytes.' },
        printed: bool('True when PrintWindow rendered it; false means screen fallback.'),
        bounds: rect('Window rect on the virtual screen.'),
      }),
      render: (_args, v) => text(
        `Window captured (${v.printed ? 'PrintWindow' : 'screen fallback'}): ${v.path} — ${v.width}x${v.height} at (${v.bounds.x},${v.bounds.y}).`),
    },
    readOnly: true,
  },
  {
    name: 'cua_drag',
    description:
      'Drag with the real left button held down: press at fromX/fromY, travel, release at toX/toY. Use it for sliders, selections, window moves and drag-and-drop.',
    parameters: obj({
      fromX: num('Press X in virtual-screen pixels.'),
      fromY: num('Press Y in virtual-screen pixels.'),
      toX: num('Release X in virtual-screen pixels.'),
      toY: num('Release Y in virtual-screen pixels.'),
    }, ['fromX', 'fromY', 'toX', 'toY']),
    run: async (A, args) => {
      const moved = await dragMouse(A, args.fromX, args.fromY, args.toX, args.toY, CFG.humanize);
      return { ok: true, ...moved };
    },
    out: {
      schema: obj({
        ok: bool('Always true.'),
        from: point('Actual press point after clamping.'),
        to: point('Actual release point after clamping.'),
      }),
      render: (_args, v) => text(`Dragged (${v.from.x}, ${v.from.y}) -> (${v.to.x}, ${v.to.y}).`),
    },
  },
  {
    name: 'cua_wait',
    description:
      'Wait for the desktop to settle: sleep for a number of milliseconds and/or poll until a window whose title contains the given text exists.',
    parameters: obj({
      ms: num('Milliseconds to sleep first (default 0).'),
      title: str('Optional window-title substring to wait for, case-insensitive.'),
      timeoutMs: num('Upper bound for the wait; capped by the plugin config.'),
    }),
    run: async (A, args) => waitFor(A, args),
    out: {
      schema: obj({
        waitedMs: { type: 'integer', description: 'Actual time spent waiting.' },
        matched: bool('True when the title appeared.'),
        timedOut: bool('True when the title never appeared in time.'),
      }),
      render: (_args, v) => text(
        v.matched ? `Window appeared after ${v.waitedMs} ms.`
          : v.timedOut ? `Timed out after ${v.waitedMs} ms waiting for the window.`
            : `Waited ${v.waitedMs} ms.`),
    },
    readOnly: true,
    timeoutMs: 60_000,
  },
  {
    name: 'cua_app_list',
    description: 'List visible top-level windows with their process executable name, so you can tell apps apart and pick a launch target.',
    parameters: obj({}),
    run: (A) => ({ apps: listWindows(A).map((w) => ({ ...w, process: exeName(A, w.pid) })) }),
    out: {
      schema: obj({
        apps: {
          type: 'array',
          items: {
            type: 'object',
            description: 'One window with its process executable.',
            properties: {
              handle: { type: 'integer', description: 'Window handle.' },
              title: str('Window title.'),
              pid: { type: 'integer', description: 'Owner process id.' },
              process: str('Process executable name, e.g. notepad.exe.'),
              active: bool('Is the foreground window.'),
              minimized: bool('Is minimized.'),
              bounds: rect('Window rect on the virtual screen.'),
            },
          },
          description: 'Windows with process names.',
        },
      }),
      render: (_args, v) => text(
        `${v.apps.length} app window(s):\n` + v.apps.map((a) =>
          `#${a.handle} ${a.process || '?'} (pid ${a.pid})${a.active ? ' [active]' : ''}${a.minimized ? ' [minimized]' : ''} "${a.title}"`).join('\n')),
    },
    readOnly: true,
  },
  {
    name: 'cua_app_launch',
    description:
      'Launch an application by executable name (resolved on PATH) or absolute path. Spawns directly without a shell, so no quoting games.',
    parameters: obj({
      exe: str('Executable name such as "notepad" / "calc", or an absolute .exe path.'),
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments.' },
    }, ['exe']),
    run: (A, args) => {
      if (CFG.allowLaunch !== true) throw new Error('cua_app_launch is disabled by config (allowLaunch: false)');
      return launchApp(args);
    },
    out: {
      schema: obj({
        ok: bool('Always true.'),
        exe: str('Resolved executable path.'),
        pid: { type: 'integer', description: 'Process id of the launched app.' },
      }),
      render: (_args, v) => text(`Launched ${v.exe} (pid ${v.pid}).`),
    },
  },
];

export const name = 'dsh-win-cua';

export const inject = ['tools'];

/**
 * Register the CUA tools on the host.
 *
 * Config knobs (all optional, from this bundle's cordis.patch.yml):
 * - `humanize` (default true): move the pointer along a smoothstep path and
 *   type/click at a human cadence instead of teleporting instantly.
 * - `keepScreenshots` (default 30): newest captures kept per directory.
 * - `moveSteps` (default 16), `keyDelayMs` ([12, 34]), `clickSettleMs` ([60, 140]):
 *   fine-tuning for the humanized cadence.
 * - `zoomFactor` (default 2), `zoomMaxPixels` (default 24e6): `cua_zoom` limits.
 * - `maxWaitMs` (default 10000): ceiling for `cua_wait`.
 * - `allowLaunch` (default true): set false to disable `cua_app_launch`.
 */
/**
 * Coerce the bundle config into the shapes the code expects. A YAML author will
 * naturally write `keyDelayMs: 20` instead of `[12, 34]`, and a string where a
 * number belongs — normalize once here instead of throwing deep inside a tool.
 */
function normalizeConfig(raw = {}) {
  const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const range = (value, fallback) => {
    if (Array.isArray(value) && value.length >= 2) {
      const low = Number(value[0]);
      const high = Number(value[1]);
      if (Number.isFinite(low) && Number.isFinite(high)) return [low, Math.max(low, high)];
    } else if (Number.isFinite(Number(value))) {
      return [Number(value), Number(value)];
    }
    return fallback;
  };
  return {
    humanize: raw.humanize === undefined ? DEFAULTS.humanize : Boolean(raw.humanize),
    keepScreenshots: finite(raw.keepScreenshots, DEFAULTS.keepScreenshots),
    moveSteps: finite(raw.moveSteps, DEFAULTS.moveSteps),
    keyDelayMs: range(raw.keyDelayMs, DEFAULTS.keyDelayMs),
    clickSettleMs: range(raw.clickSettleMs, DEFAULTS.clickSettleMs),
    zoomFactor: finite(raw.zoomFactor, DEFAULTS.zoomFactor),
    zoomMaxPixels: finite(raw.zoomMaxPixels, DEFAULTS.zoomMaxPixels),
    maxWaitMs: finite(raw.maxWaitMs, DEFAULTS.maxWaitMs),
    allowLaunch: raw.allowLaunch === undefined ? DEFAULTS.allowLaunch : Boolean(raw.allowLaunch),
  };
}

export function apply(ctx, config = {}) {
  Object.assign(CFG, normalizeConfig(config));
  for (const decl of TOOL_DECLS) {
    const tool = {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
      output: decl.out,
      presentCall: (args) => ({ card: 'generic', title: decl.name, kind: 'other', rawInput: args ?? {} }),
      ...decl.readOnly === true ? { isConcurrencySafe: () => true } : {},
      ...decl.timeoutMs !== undefined ? { timeoutMs: decl.timeoutMs } : {},
      async execute(args = {}) {
        return decl.run(loadNative(), args ?? {});
      },
    };
    ctx.effect(() => ctx.tools.register(tool));
  }
}
