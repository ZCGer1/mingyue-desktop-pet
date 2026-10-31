# CUA input helper (resident, JSON Lines over stdin/stdout).
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less scripts using the
# system code page. All non-ASCII strings below use C# \u escapes.
#
# This is the ONLY place in the repository allowed to call SendInput.
# It never focuses or reorders windows and never reads screen pixels.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
} catch {
  # Redirected handles may reject encoding changes; JSON remains ASCII-escaped.
}

$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CuaInput
{
    const int INPUT_MOUSE = 0;
    const int INPUT_KEYBOARD = 1;

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    public static int LastInjectTick = 0;

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public int type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public short wVk;
        public short wScan;
        public uint dwFlags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr hWnd);

    static void VirtualScreen(out int x, out int y, out int w, out int h)
    {
        x = GetSystemMetrics(76);
        y = GetSystemMetrics(77);
        w = GetSystemMetrics(78);
        h = GetSystemMetrics(79);
        if (w <= 0) w = GetSystemMetrics(0);
        if (h <= 0) h = GetSystemMetrics(1);
        if (w <= 0) w = 1;
        if (h <= 0) h = 1;
    }

    static void Send(INPUT[] inputs)
    {
        if (inputs == null || inputs.Length == 0) return;
        LastInjectTick = Environment.TickCount;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != (uint)inputs.Length)
        {
            throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
        }
    }

    static INPUT MouseInput(uint flags, int dx, int dy, int data)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.U.mi = new MOUSEINPUT();
        input.U.mi.dx = dx;
        input.U.mi.dy = dy;
        input.U.mi.mouseData = data;
        input.U.mi.dwFlags = flags;
        return input;
    }

    static INPUT KeyInput(short vk, short scan, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki = new KEYBDINPUT();
        input.U.ki.wVk = vk;
        input.U.ki.wScan = scan;
        input.U.ki.dwFlags = flags;
        return input;
    }

    static void SendMouse(uint flags)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0] = MouseInput(flags, 0, 0, 0);
        Send(inputs);
    }

    public static void MoveTo(int x, int y)
    {
        int vx, vy, vw, vh;
        VirtualScreen(out vx, out vy, out vw, out vh);
        if (x < vx || y < vy || x >= vx + vw || y >= vy + vh)
        {
            throw new Exception("point outside virtual screen");
        }
        int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        INPUT[] inputs = new INPUT[1];
        inputs[0] = MouseInput(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            nx,
            ny,
            0);
        Send(inputs);
    }

    public static void Click(int x, int y, int button, int count)
    {
        MoveTo(x, y);
        if (count < 1) count = 1;
        if (count > 2) count = 2;
        for (int index = 0; index < count; index++)
        {
            if (button == 1)
            {
                SendMouse(MOUSEEVENTF_RIGHTDOWN);
                SendMouse(MOUSEEVENTF_RIGHTUP);
            }
            else if (button == 2)
            {
                SendMouse(MOUSEEVENTF_MIDDLEDOWN);
                SendMouse(MOUSEEVENTF_MIDDLEUP);
            }
            else
            {
                SendMouse(MOUSEEVENTF_LEFTDOWN);
                SendMouse(MOUSEEVENTF_LEFTUP);
            }
            if (index + 1 < count) Thread.Sleep(60);
        }
    }

    public static void Scroll(int x, int y, int deltaY, int deltaX)
    {
        MoveTo(x, y);
        if (deltaY != 0)
        {
            INPUT[] vertical = new INPUT[1];
            vertical[0] = MouseInput(MOUSEEVENTF_WHEEL, 0, 0, deltaY * 120);
            Send(vertical);
        }
        if (deltaX != 0)
        {
            INPUT[] horizontal = new INPUT[1];
            horizontal[0] = MouseInput(MOUSEEVENTF_HWHEEL, 0, 0, deltaX * 120);
            Send(horizontal);
        }
        Thread.Sleep(30);
    }

    public static void Drag(int fromX, int fromY, int toX, int toY)
    {
        MoveTo(fromX, fromY);
        Thread.Sleep(60);
        SendMouse(MOUSEEVENTF_LEFTDOWN);
        Thread.Sleep(80);
        for (int step = 1; step <= 12; step++)
        {
            int x = fromX + (toX - fromX) * step / 12;
            int y = fromY + (toY - fromY) * step / 12;
            MoveTo(x, y);
            Thread.Sleep(15);
        }
        Thread.Sleep(60);
        SendMouse(MOUSEEVENTF_LEFTUP);
    }

    public static void TypeText(string text)
    {
        if (text == null) throw new Exception("missing text");
        List<INPUT> batch = new List<INPUT>();
        foreach (char c in text)
        {
            if (c == '\r' || c == '\n') throw new Exception("newline not allowed");
            if (c < 32 && c != '\t') throw new Exception("control character not allowed");
            batch.Add(KeyInput(0, (short)c, KEYEVENTF_UNICODE));
            batch.Add(KeyInput(0, (short)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            if (batch.Count >= 512)
            {
                Send(batch.ToArray());
                batch.Clear();
            }
        }
        if (batch.Count > 0) Send(batch.ToArray());
    }

    static void ResolveKey(string key, out int vk, out bool extended, out bool autoShift)
    {
        vk = 0;
        extended = false;
        autoShift = false;

        if (key.Length == 1)
        {
            char ch = key[0];
            if (ch >= 'a' && ch <= 'z')
            {
                vk = (int)Char.ToUpperInvariant(ch);
                return;
            }
            if (ch >= '0' && ch <= '9')
            {
                vk = (int)ch;
                return;
            }
        }

        if (key == "enter" || key == "return") { vk = 0x0D; return; }
        if (key == "tab") { vk = 0x09; return; }
        if (key == "esc" || key == "escape") { vk = 0x1B; return; }
        if (key == "space") { vk = 0x20; return; }
        if (key == "backspace") { vk = 0x08; return; }
        if (key == "delete" || key == "del") { vk = 0x2E; extended = true; return; }
        if (key == "insert") { vk = 0x2D; extended = true; return; }
        if (key == "home") { vk = 0x24; extended = true; return; }
        if (key == "end") { vk = 0x23; extended = true; return; }
        if (key == "pageup") { vk = 0x21; extended = true; return; }
        if (key == "pagedown") { vk = 0x22; extended = true; return; }
        if (key == "up") { vk = 0x26; extended = true; return; }
        if (key == "down") { vk = 0x28; extended = true; return; }
        if (key == "left") { vk = 0x25; extended = true; return; }
        if (key == "right") { vk = 0x27; extended = true; return; }

        if (key.Length >= 2 && key[0] == 'f')
        {
            int number;
            if (Int32.TryParse(key.Substring(1), out number) && number >= 1 && number <= 12)
            {
                vk = 0x6F + number;
                return;
            }
        }

        if (key == "minus") { vk = 0xBD; return; }
        if (key == "equal") { vk = 0xBB; return; }
        if (key == "plus") { vk = 0xBB; autoShift = true; return; }
        if (key == "comma") { vk = 0xBC; return; }
        if (key == "period") { vk = 0xBE; return; }
        if (key == "slash") { vk = 0xBF; return; }
        if (key == "semicolon") { vk = 0xBA; return; }
        if (key == "quote") { vk = 0xDE; return; }
        if (key == "backtick") { vk = 0xC0; return; }
        if (key == "bracketleft") { vk = 0xDB; return; }
        if (key == "bracketright") { vk = 0xDD; return; }
        if (key == "backslash") { vk = 0xDC; return; }

        throw new Exception("unsupported key");
    }

    public static void Key(string combo)
    {
        if (combo == null || combo.Trim().Length == 0) throw new Exception("missing combo");
        string[] parts = combo.ToLowerInvariant().Split('+');
        bool ctrl = false;
        bool alt = false;
        bool shift = false;
        int vk = 0;
        bool extended = false;
        bool autoShift = false;

        foreach (string rawPart in parts)
        {
            string part = rawPart.Trim();
            if (part.Length == 0) continue;
            if (part == "ctrl" || part == "control") { ctrl = true; continue; }
            if (part == "alt") { alt = true; continue; }
            if (part == "shift") { shift = true; continue; }
            if (part == "win" || part == "meta" || part == "super" || part == "cmd" || part == "windows")
            {
                throw new Exception("win key is forbidden");
            }
            if (vk != 0) throw new Exception("multiple keys are not allowed");
            ResolveKey(part, out vk, out extended, out autoShift);
        }

        if (vk == 0) throw new Exception("missing key");
        if (autoShift) shift = true;

        List<INPUT> sequence = new List<INPUT>();
        uint normal = extended ? KEYEVENTF_EXTENDEDKEY : 0;
        uint released = normal | KEYEVENTF_KEYUP;

        if (ctrl) sequence.Add(KeyInput(0x11, 0, 0));
        if (alt) sequence.Add(KeyInput(0x12, 0, 0));
        if (shift && !autoShift) sequence.Add(KeyInput(0x10, 0, 0));
        if (shift && autoShift) sequence.Add(KeyInput(0x10, 0, 0));
        sequence.Add(KeyInput((short)vk, 0, normal));
        sequence.Add(KeyInput((short)vk, 0, released));
        if (shift) sequence.Add(KeyInput(0x10, 0, KEYEVENTF_KEYUP));
        if (alt) sequence.Add(KeyInput(0x12, 0, KEYEVENTF_KEYUP));
        if (ctrl) sequence.Add(KeyInput(0x11, 0, KEYEVENTF_KEYUP));

        Send(sequence.ToArray());
    }

    public static void ReleaseAll()
    {
        List<INPUT> keys = new List<INPUT>();
        keys.Add(KeyInput(0x11, 0, KEYEVENTF_KEYUP));
        keys.Add(KeyInput(0x12, 0, KEYEVENTF_KEYUP));
        keys.Add(KeyInput(0x10, 0, KEYEVENTF_KEYUP));
        Send(keys.ToArray());
        SendMouse(MOUSEEVENTF_LEFTUP);
        SendMouse(MOUSEEVENTF_RIGHTUP);
        SendMouse(MOUSEEVENTF_MIDDLEUP);
    }

    public static string ForegroundProcessName()
    {
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return "";
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            Process process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch
        {
            return "";
        }
    }

    public static int ForegroundPid()
    {
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return 0;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            return (int)pid;
        }
        catch
        {
            return 0;
        }
    }

    public static bool ForegroundTitleSensitive()
    {
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return false;
            int length = GetWindowTextLength(hwnd);
            if (length <= 0) return false;
            StringBuilder builder = new StringBuilder(length + 1);
            if (GetWindowText(hwnd, builder, builder.Capacity) <= 0) return false;
            string title = builder.ToString().ToLowerInvariant();
            // ASCII-only source: build CJK terms from code points so the helper
            // works even when Windows PowerShell reads this BOM-less file as ANSI.
            string[] terms = new string[]
            {
                Char.ConvertFromUtf32(0x94F6) + Char.ConvertFromUtf32(0x884C),
                Char.ConvertFromUtf32(0x652F) + Char.ConvertFromUtf32(0x4ED8),
                Char.ConvertFromUtf32(0x4ED8) + Char.ConvertFromUtf32(0x6B3E),
                Char.ConvertFromUtf32(0x8F6C) + Char.ConvertFromUtf32(0x8D26),
                Char.ConvertFromUtf32(0x5BC6) + Char.ConvertFromUtf32(0x7801),
                Char.ConvertFromUtf32(0x9A8C) + Char.ConvertFromUtf32(0x8BC1) + Char.ConvertFromUtf32(0x7801),
                Char.ConvertFromUtf32(0x53CC) + Char.ConvertFromUtf32(0x91CD) + Char.ConvertFromUtf32(0x9A8C) + Char.ConvertFromUtf32(0x8BC1),
                "bank",
                "payment",
                "password",
                "passcode",
                "2fa",
                "authenticator",
                "verification code"
            };
            for (int index = 0; index < terms.Length; index++)
            {
                if (title.Contains(terms[index])) return true;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    public static int CursorX()
    {
        POINT point;
        if (!GetCursorPos(out point)) return 0;
        return point.X;
    }

    public static int CursorY()
    {
        POINT point;
        if (!GetCursorPos(out point)) return 0;
        return point.Y;
    }

    public static int VirtualX() { int x, y, w, h; VirtualScreen(out x, out y, out w, out h); return x; }
    public static int VirtualY() { int x, y, w, h; VirtualScreen(out x, out y, out w, out h); return y; }
    public static int VirtualWidth() { int x, y, w, h; VirtualScreen(out x, out y, out w, out h); return w; }
    public static int VirtualHeight() { int x, y, w, h; VirtualScreen(out x, out y, out w, out h); return h; }
}

public static class CuaTakeover
{
    public static readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
    public static volatile bool HooksActive = false;
    public static volatile bool KeyboardHookActive = false;
    public static volatile bool MouseHookActive = false;

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT
    {
        public CuaInput.POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public CuaInput.POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    const uint LLKHF_INJECTED = 0x10;
    const uint LLMHF_INJECTED = 0x1;

    static HookProc keyboardProc;
    static HookProc mouseProc;
    static IntPtr keyboardHook = IntPtr.Zero;
    static IntPtr mouseHook = IntPtr.Zero;
    static int lastMouseMoveTick = 0;
    static int lastFallbackTick = 0;

    public static void Start()
    {
        Thread thread = new Thread(new ThreadStart(Run));
        thread.IsBackground = true;
        thread.Start();
    }

    public static string TakeEvent()
    {
        string value;
        if (Events.TryDequeue(out value)) return value;
        return null;
    }

    static void Run()
    {
        try
        {
            keyboardProc = new HookProc(KeyboardCallback);
            mouseProc = new HookProc(MouseCallback);
            IntPtr module = GetModuleHandle(null);
            keyboardHook = SetWindowsHookEx(13, keyboardProc, module, 0);
            mouseHook = SetWindowsHookEx(14, mouseProc, module, 0);
        }
        catch
        {
            keyboardHook = IntPtr.Zero;
            mouseHook = IntPtr.Zero;
        }

        KeyboardHookActive = keyboardHook != IntPtr.Zero;
        MouseHookActive = mouseHook != IntPtr.Zero;
        HooksActive = KeyboardHookActive || MouseHookActive;

        if (HooksActive)
        {
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
            return;
        }

        FallbackLoop();
    }

    static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0)
            {
                int message = wParam.ToInt32();
                if (message == 0x100 || message == 0x104)
                {
                    KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(
                        lParam,
                        typeof(KBDLLHOOKSTRUCT));
                    if ((data.flags & LLKHF_INJECTED) == 0)
                    {
                        Events.Enqueue("keyboard");
                    }
                }
            }
        }
        catch
        {
            // Never let diagnostics break input processing.
        }
        return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
    }

    static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0)
            {
                int message = wParam.ToInt32();
                MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(
                    lParam,
                    typeof(MSLLHOOKSTRUCT));
                if ((data.flags & LLMHF_INJECTED) == 0)
                {
                    if (message == 0x200)
                    {
                        int now = Environment.TickCount;
                        if (unchecked(now - lastMouseMoveTick) >= 1000)
                        {
                            lastMouseMoveTick = now;
                            Events.Enqueue("mouse");
                        }
                    }
                    else if (message == 0x201 || message == 0x204 || message == 0x207 ||
                             message == 0x20A || message == 0x20E)
                    {
                        Events.Enqueue("mouse");
                    }
                }
            }
        }
        catch
        {
            // Never let diagnostics break input processing.
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    static void FallbackLoop()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return;
        uint last = info.dwTime;

        while (true)
        {
            Thread.Sleep(120);
            LASTINPUTINFO current = new LASTINPUTINFO();
            current.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref current)) continue;
            if (current.dwTime == last) continue;
            last = current.dwTime;

            int sinceInject = unchecked(Environment.TickCount - CuaInput.LastInjectTick);
            if (sinceInject >= 0 && sinceInject < 400) continue;

            int now = Environment.TickCount;
            if (unchecked(now - lastFallbackTick) < 1500) continue;
            lastFallbackTick = now;
            Events.Enqueue("input");
        }
    }
}

/**
 * Reads JSON Lines from stdin on a dedicated blocking thread.
 * Console.In.ReadLineAsync() in Windows PowerShell 5.1 never completes while the
 * pipe is still open, so the main loop must not depend on it.
 */
public static class CuaStdin
{
    static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    static volatile bool ended = false;

    public static void Start()
    {
        Thread thread = new Thread(new ThreadStart(Run));
        thread.IsBackground = true;
        thread.Start();
    }

    static void Run()
    {
        try
        {
            using (Stream stream = Console.OpenStandardInput())
            using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false), false, 4096))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    Lines.Enqueue(line);
                }
            }
        }
        catch
        {
            // Treat read errors like EOF; the host will restart the helper.
        }
        ended = true;
    }

    public static string TakeLine()
    {
        string line;
        return Lines.TryDequeue(out line) ? line : null;
    }

    public static bool Ended
    {
        get { return ended && Lines.IsEmpty; }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
} catch {
  [Console]::Error.WriteLine('CUA helper init failed: ' + $_.Exception.Message)
  exit 1
}

try {
  [CuaTakeover]::Start()
} catch {
  # Hooks unavailable: the fallback sampler inside Start() handles it.
}

function Send-Json([hashtable]$payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

function Read-Int($value, [string]$name) {
  $parsed = 0
  if ($null -eq $value) { throw "missing $name" }
  if (-not [int]::TryParse([string]$value, [ref]$parsed)) { throw "bad $name" }
  return $parsed
}

# Windows PowerShell 5.1: Console.In.ReadLineAsync() does not complete while
# stdin is a still-open pipe. Read lines on a background thread instead and
# poll the queue here, so takeover events stay responsive as well.
[CuaStdin]::Start()
$shutdown = $false

while (-not $shutdown) {
  $kind = [CuaTakeover]::TakeEvent()
  while ($null -ne $kind) {
    Send-Json @{ event = 'takeover'; kind = $kind }
    $kind = [CuaTakeover]::TakeEvent()
  }

  $line = [CuaStdin]::TakeLine()
  if ($null -eq $line) {
    if ([CuaStdin]::Ended) { break }
    Start-Sleep -Milliseconds 5
    continue
  }

  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
    $id = $request.id
    $op = [string]$request.op

    switch ($op) {
      'ping' {
        Send-Json @{
          id = $id
          ok = $true
          hooks = [CuaTakeover]::HooksActive
          keyboardHook = [CuaTakeover]::KeyboardHookActive
          mouseHook = [CuaTakeover]::MouseHookActive
        }
      }
      'inspect' {
        Send-Json @{
          id = $id
          ok = $true
          processName = [CuaInput]::ForegroundProcessName()
          titleSensitive = [CuaInput]::ForegroundTitleSensitive()
          pid = [CuaInput]::ForegroundPid()
          cursor = @{ x = [CuaInput]::CursorX(); y = [CuaInput]::CursorY() }
          virtualScreen = @{
            x = [CuaInput]::VirtualX()
            y = [CuaInput]::VirtualY()
            width = [CuaInput]::VirtualWidth()
            height = [CuaInput]::VirtualHeight()
          }
        }
      }
      'click' {
        $x = Read-Int $request.x 'x'
        $y = Read-Int $request.y 'y'
        $button = 0
        if ([string]$request.button -eq 'right') { $button = 1 }
        if ([string]$request.button -eq 'middle') { $button = 2 }
        $count = 1
        if ($null -ne $request.count) { $count = [int]$request.count }
        [CuaInput]::Click($x, $y, $button, $count)
        Send-Json @{ id = $id; ok = $true }
      }
      'doubleclick' {
        $x = Read-Int $request.x 'x'
        $y = Read-Int $request.y 'y'
        $button = 0
        if ([string]$request.button -eq 'right') { $button = 1 }
        if ([string]$request.button -eq 'middle') { $button = 2 }
        [CuaInput]::Click($x, $y, $button, 2)
        Send-Json @{ id = $id; ok = $true }
      }
      'scroll' {
        $x = Read-Int $request.x 'x'
        $y = Read-Int $request.y 'y'
        $deltaY = Read-Int $request.deltaY 'deltaY'
        $deltaX = 0
        if ($null -ne $request.deltaX) { $deltaX = Read-Int $request.deltaX 'deltaX' }
        [CuaInput]::Scroll($x, $y, $deltaY, $deltaX)
        Send-Json @{ id = $id; ok = $true }
      }
      'drag' {
        $fromX = Read-Int $request.fromX 'fromX'
        $fromY = Read-Int $request.fromY 'fromY'
        $toX = Read-Int $request.toX 'toX'
        $toY = Read-Int $request.toY 'toY'
        [CuaInput]::Drag($fromX, $fromY, $toX, $toY)
        Send-Json @{ id = $id; ok = $true }
      }
      'type' {
        [CuaInput]::TypeText([string]$request.text)
        Send-Json @{ id = $id; ok = $true }
      }
      'key' {
        [CuaInput]::Key([string]$request.combo)
        Send-Json @{ id = $id; ok = $true }
      }
      'release_all' {
        [CuaInput]::ReleaseAll()
        Send-Json @{ id = $id; ok = $true }
      }
      'shutdown' {
        [CuaInput]::ReleaseAll()
        Send-Json @{ id = $id; ok = $true }
        $shutdown = $true
      }
      default {
        Send-Json @{ id = $id; ok = $false; error = 'unknown op' }
      }
    }
  } catch {
    Send-Json @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}

try {
  [CuaInput]::ReleaseAll()
} catch {
}
