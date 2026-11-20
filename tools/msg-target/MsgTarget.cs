// Temporary classic-USER32 test target for the posted-message channel.
//
// Deliberately not WinForms: a plain window with plain child windows is exactly the case the
// framework classifier marks as "posted messages reach the app layer".
//
// Two children:
//   * CuMsgPad  — a custom child whose window procedure logs the *client coordinates* of every
//                 posted WM_LBUTTONDOWN/UP. Proves the transport reaches the child under the point
//                 without moving the physical cursor.
//   * Button    — a native button, used to prove the forced real-input channel.
// A classic button verifies the *physical* cursor on button-up, so it is the wrong instrument for
// the message channel; a custom child is not.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Program
{
    const string ClassName = "CuMsgTarget";
    const string PadClass = "CuMsgPad";

    delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSEX
    {
        public uint cbSize; public uint style; public WndProcDelegate lpfnWndProc;
        public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon;
        public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName;
        public string lpszClassName; public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern ushort RegisterClassExW(ref WNDCLASSEX wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll")] static extern bool GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool UpdateWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, string l);
    [DllImport("user32.dll")] static extern bool SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr cb);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    const uint WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_TABSTOP = 0x00010000;
    const uint WS_EX_TOOLWINDOW = 0x00000080;
    const uint WM_DESTROY = 0x0002, WM_COMMAND = 0x0111, WM_TIMER = 0x0113, WM_CLOSE = 0x0010;
    const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    const int BN_CLICKED = 0;

    static readonly WndProcDelegate TopProcDelegate = TopProc;
    static readonly WndProcDelegate PadProcDelegate = PadProc;
    static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

    static string _logPath;
    static string _infoPath;
    static IntPtr _button;
    static IntPtr _pad;
    static IntPtr _window;
    static int _clicks;

    static long LoWord(IntPtr v) { return (short)(v.ToInt64() & 0xFFFF); }
    static long HiWord(IntPtr v) { return (short)((v.ToInt64() >> 16) & 0xFFFF); }

    static IntPtr PadProc(IntPtr h, uint msg, IntPtr w, IntPtr l)
    {
        if (msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP)
        {
            Log((msg == WM_LBUTTONDOWN ? "pad-down" : "pad-up") + " x=" + LoWord(l) + " y=" + HiWord(l) + " w=" + w.ToInt64());
            return IntPtr.Zero;
        }
        return DefWindowProcW(h, msg, w, l);
    }

    static IntPtr TopProc(IntPtr h, uint msg, IntPtr w, IntPtr l)
    {
        if (msg == WM_COMMAND && HiWord(w) == BN_CLICKED)
        {
            _clicks++;
            Log("click " + _clicks + " at " + DateTime.UtcNow.ToString("HH:mm:ss.fff"));
            SendMessageW(_button, 0x000C /* WM_SETTEXT */, IntPtr.Zero, "CLICKED " + _clicks);
            return IntPtr.Zero;
        }
        if (msg == WM_TIMER)
        {
            // 45s watchdog: a failed run must not leave a window behind.
            PostQuitMessage(0);
            return IntPtr.Zero;
        }
        if (msg == WM_CLOSE || msg == WM_DESTROY)
        {
            PostQuitMessage(0);
            return IntPtr.Zero;
        }
        return DefWindowProcW(h, msg, w, l);
    }

    static void Log(string line)
    {
        try { File.AppendAllText(_logPath, line + "\n", Utf8NoBom); } catch { }
    }

    static void RegisterClass(string name, WndProcDelegate proc, IntPtr instance)
    {
        var wc = new WNDCLASSEX();
        wc.cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
        wc.lpfnWndProc = proc;
        wc.hInstance = instance;
        wc.hbrBackground = (IntPtr)16; // COLOR_BTNFACE + 1
        wc.lpszClassName = name;
        RegisterClassExW(ref wc);
    }

    [STAThread]
    static void Main(string[] args)
    {
        _logPath = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "cu-msg-target.log");
        _infoPath = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "cu-msg-target.json");
        try { File.WriteAllText(_logPath, "", Utf8NoBom); } catch { }
        // Physical pixels, like the engine: otherwise the geometry this app reports is virtualized
        // and a test could "prove" the wrong screen point. Pass "unaware" as the third argument to
        // exercise the DPI-unaware path on purpose.
        bool forceUnaware = args.Length > 2 && string.Equals(args[2], "unaware", StringComparison.OrdinalIgnoreCase);
        bool dpiAware = false;
        if (!forceUnaware)
        {
            try { dpiAware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        }

        IntPtr instance = GetModuleHandleW(null);
        RegisterClass(ClassName, TopProcDelegate, instance);
        RegisterClass(PadClass, PadProcDelegate, instance);

        _window = CreateWindowExW(WS_EX_TOOLWINDOW, ClassName, "CU MSG TARGET",
            WS_OVERLAPPEDWINDOW, 140, 140, 520, 380, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (_window == IntPtr.Zero) { Log("create-failed " + Marshal.GetLastWin32Error()); return; }

        _pad = CreateWindowExW(0, PadClass, "", WS_CHILD | WS_VISIBLE,
            40, 40, 240, 80, _window, (IntPtr)1002, instance, IntPtr.Zero);
        _button = CreateWindowExW(0, "Button", "REAL CLICK", WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            40, 150, 240, 70, _window, (IntPtr)1001, instance, IntPtr.Zero);

        ShowWindow(_window, 5 /* SW_SHOW */);
        UpdateWindow(_window);
        SetTimer(_window, (IntPtr)1, 45000, IntPtr.Zero);

        RECT wr; GetWindowRect(_window, out wr);
        RECT pr; GetWindowRect(_pad, out pr);
        RECT br; GetWindowRect(_button, out br);
        var info = "{\"dpiAware\":" + (dpiAware ? "true" : "false") +
                   ",\"window\":{\"x\":" + wr.L + ",\"y\":" + wr.T + ",\"w\":" + (wr.R - wr.L) + ",\"h\":" + (wr.B - wr.T) + "}," +
                   "\"pad\":{\"x\":" + pr.L + ",\"y\":" + pr.T + ",\"w\":" + (pr.R - pr.L) + ",\"h\":" + (pr.B - pr.T) + "}," +
                   "\"button\":{\"x\":" + br.L + ",\"y\":" + br.T + ",\"w\":" + (br.R - br.L) + ",\"h\":" + (br.B - br.T) + "}}";
        File.WriteAllText(_infoPath, info, Utf8NoBom);
        Log("ready hwnd=" + _window.ToInt64() + " pad=" + _pad.ToInt64() + " button=" + _button.ToInt64());

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }
}
