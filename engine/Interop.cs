// Computer Use for Windows - native interop engine.
// Compiled once per engine process via Add-Type -Path. All hot paths live here so the
// PowerShell dispatcher only does JSON <-> object mapping.
//
// Design rules baked into this file (see docs/research/03-windows-native-layer.md):
//  * Physical pixels are the only truth. The process must be Per-Monitor-V2 aware; every
//    capture/input path assumes physical coordinates. There is no logical-coordinate fallback.
//  * PrintWindow is the default window capture (robust to occlusion), but DPI-unaware targets
//    render only their logical size into the top-left of the physical canvas - normalize those.
//  * Real input (SendInput) is the reference channel. Posted window messages are only used for
//    bound windows that the framework classifier marks as classic USER32 windows: posting to a
//    Chromium/WPF/WinUI/WinForms surface is accepted and then does nothing.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CuWin
{
    #region Native declarations

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate bool EnumMonitorsProc(IntPtr hMonitor, IntPtr hdc, IntPtr rectPtr, IntPtr data);

    static class Native
    {
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const uint GA_ROOT = 2;
        public const uint GA_ROOTOWNER = 3;
        public const int SW_RESTORE = 9;
        public const int SW_SHOW = 5;
        public const uint MONITOR_DEFAULTTONEAREST = 2;
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        public const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
        public const uint WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
        public const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
        public const uint WM_MOUSEMOVE = 0x0200;
        public const uint WM_MOUSEWHEEL = 0x020A, WM_MOUSEHWHEEL = 0x020C;
        public const uint MK_LBUTTON = 0x0001, MK_RBUTTON = 0x0002, MK_MBUTTON = 0x0010;

        // ChildWindowFromPointEx flags: the message channel must resolve the control a human
        // would see under the point, not a hidden/disabled/click-through helper window.
        public const uint CWP_SKIPINVISIBLE = 0x0001, CWP_SKIPDISABLED = 0x0002, CWP_SKIPTRANSPARENT = 0x0004;

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
        public const uint MOUSEEVENTF_XDOWN = 0x0080, MOUSEEVENTF_XUP = 0x0100;

        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumMonitorsProc cb, IntPtr data);
        [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW", CharSet = CharSet.Unicode)]
        public static extern bool GetMonitorInfo(IntPtr hmon, ref MONITORINFOEX info);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr data);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref uint val, int size);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);

        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern short VkKeyScanW(char ch);

        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageNameW(IntPtr proc, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetProcessTimes(IntPtr proc, out long creation, out long exit, out long kernel, out long user);        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out uint sessionId);

        [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, int len, out int needed);
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();

        [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint flags, IntPtr extra);

        // Low-level keyboard hook (Escape watchdog).
        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookExW(int idHook, LowLevelKeyboardProc proc, IntPtr module, uint threadId);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG msg);

        [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

        // Window class and message pump primitives.
        public delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct WNDCLASS
        {
            public uint style;
            public IntPtr lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            public string lpszMenuName;
            public string lpszClassName;
        }
        [StructLayout(LayoutKind.Sequential)] public struct PAINTSTRUCT { public IntPtr hdc; public bool fErase; public RECT rcPaint; public bool fRestore; public bool fIncUpdate; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] rgbReserved; }
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern ushort RegisterClassW(ref WNDCLASS wc);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(int exStyle, string className, string windowName, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint elapse, IntPtr proc);
        [DllImport("user32.dll")] public static extern bool KillTimer(IntPtr hwnd, IntPtr id);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateSolidBrush(int color);
        [DllImport("user32.dll")] public static extern int FillRect(IntPtr hdc, ref RECT rc, IntPtr brush);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")] public static extern int CombineRgn(IntPtr dest, IntPtr one, IntPtr two, int mode);
        [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
        [DllImport("user32.dll")] public static extern IntPtr BeginPaint(IntPtr hwnd, out PAINTSTRUCT ps);
        [DllImport("user32.dll")] public static extern bool EndPaint(IntPtr hwnd, ref PAINTSTRUCT ps);
        [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr hwnd, IntPtr rect, bool erase);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
        [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr mem);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int len, out int needed);
        [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    }

    #endregion

    #region Public result types

    public class MonitorInfo
    {
        public int id;
        public string deviceName;
        public int x, y, width, height;
        public int workX, workY, workWidth, workHeight;
        public uint dpi;
        public bool primary;
    }

    public class WindowInfo
    {
        public long hwnd;
        public string title;
        public string className;
        public uint pid;
        public string processName;
        public string exePath;
        public bool visible;
        public bool enabled;
        public bool minimized;
        public bool maximized;
        public int x, y, width, height;          // GetWindowRect (capture surface)
        public int frameX, frameY, frameWidth, frameHeight; // DWM visible frame
        public int clientX, clientY, clientWidth, clientHeight;
        public string dpiAwareness;              // unaware | system | per-monitor
        public uint dpi;
        public int monitorId;
        public bool isForeground;
        public long processStartTime;
        public int integrityValue;               // SECURITY_MANDATORY_* RID, -1 when unreadable
        public string integrity;                 // low | medium | high | system | protected | unknown
        public string rootTitle;
        public long rootHwnd;
        public uint rootPid;
        public string rootExePath;
        public int rootIntegrityValue;
        public string rootIntegrity;
    }

    public class CaptureResult
    {
        public bool ok;
        public string errorCode;
        public string errorMessage;
        public string base64;
        public string mimeType;
        public int imageWidth, imageHeight;
        public int sourceWidth, sourceHeight;    // full (pre-downscale) capture surface
        public int originX, originY;             // virtual-desktop origin of source surface
        public bool normalized;                  // DPI-unaware content stretched to full canvas
        public string captureMethod;             // printwindow | screen
        public string captureMode;               // bound_window | full_display
        public double scale;                     // source -> image
        public long revision;
        public List<string> notes = new List<string>();
    }

    public class InputResult
    {
        public bool ok;
        public string errorCode;
        public string errorMessage;
        public int dispatchedEvents;
        public bool foregroundVerified;
        public long foregroundHwnd;
        public long targetHwnd;
        public string targetExePath;
        public List<string> notes = new List<string>();
    }

    #endregion

    /// <summary>
    /// Per-snapshot memo for window enumeration. Filled only while listing windows, never for the
    /// single-window path that permission checks use (a stale pid identity must not gate input).
    /// </summary>
    public class Lookup
    {
        public Dictionary<uint, string> Exe = new Dictionary<uint, string>();
        public Dictionary<uint, long> Start = new Dictionary<uint, long>();
        public Dictionary<uint, string> Name = new Dictionary<uint, string>();
        public List<MonitorInfo> Monitors;
    }

    /// <summary>
    /// Watches for a physical Escape press with a low-level keyboard hook so a human can stop an
    /// action in flight. Injected keystrokes (LLKHF_INJECTED) are ignored on purpose: the agent's
    /// own input.key("escape") must not look like a user abort. Set CU_ESC_TEST_INJECTED=1 to
    /// include injected keys (used by the automated test).
    /// </summary>
    public static class EscWatch
    {
        public const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_SYSKEYDOWN = 0x0104;
        const int LLKHF_INJECTED = 0x10;
        const int VK_ESCAPE = 0x1B;

        public static volatile int Count;
        static volatile IntPtr _hook = IntPtr.Zero;
        static volatile string _error;
        static Thread _thread;
        static Native.LowLevelKeyboardProc _proc; // kept alive for the lifetime of the hook
        static readonly bool _allowInjected = string.Equals(Environment.GetEnvironmentVariable("CU_ESC_TEST_INJECTED"), "1", StringComparison.Ordinal);

        public static bool Watching { get { return _hook != IntPtr.Zero; } }
        public static string Error { get { return _error; } }

        /// <summary>Starts the watcher once. Returns null on success, otherwise the reason it failed.</summary>
        public static string Start()
        {
            if (Watching) return null;
            if (_thread != null) return _error ?? "The Escape watcher thread is still starting.";
            _thread = new Thread(Loop);
            _thread.IsBackground = true;
            _thread.Name = "cu-esc-watch";
            try { _thread.SetApartmentState(ApartmentState.STA); } catch { }
            _thread.Start();
            for (int i = 0; i < 100; i++)
            {
                if (Watching) return null;
                if (_error != null) return _error;
                Thread.Sleep(10);
            }
            return _error ?? "The Escape watcher did not report ready.";
        }

        static void Loop()
        {
            try
            {
                _proc = Hook;
                IntPtr module = Native.GetModuleHandleW(null);
                _hook = Native.SetWindowsHookExW(WH_KEYBOARD_LL, _proc, module, 0);
                if (_hook == IntPtr.Zero)
                {
                    _hook = Native.SetWindowsHookExW(WH_KEYBOARD_LL, _proc, IntPtr.Zero, 0);
                }
                if (_hook == IntPtr.Zero)
                {
                    _error = "SetWindowsHookEx(WH_KEYBOARD_LL) failed with error " + Marshal.GetLastWin32Error() + ".";
                    return;
                }
                Native.MSG msg;
                while (Native.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    Native.TranslateMessage(ref msg);
                    Native.DispatchMessageW(ref msg);
                }
            }
            catch (Exception error)
            {
                _error = error.Message;
            }
        }

        static IntPtr Hook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0 && lParam != IntPtr.Zero)
                {
                    int message = wParam.ToInt32();
                    if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
                    {
                        int vk = Marshal.ReadInt32(lParam);
                        int flags = Marshal.ReadInt32(lParam, 8);
                        bool injected = (flags & LLKHF_INJECTED) != 0;
                        if (vk == VK_ESCAPE && (injected == false || _allowInjected)) Count = Count + 1;
                    }
                }
            }
            catch { }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }
    }

    /// <summary>
    /// Marks the window the agent is bound to with the DWM border colour, so a human can see which
    /// window is being driven. The compositor draws it: it follows moves, resizes and repaints with
    /// no timer of ours, creates no window of our own and takes no space outside the target.
    /// Windows 11 (build 22000+) only; older systems simply go without the cue.
    /// </summary>
    public static class WindowBorder
    {
        const int DWMWA_BORDER_COLOR = 34;
        const uint COLOR_DEFAULT = 0xFFFFFFFF; // DWMWA_COLOR_DEFAULT: the system default border
        const uint COLOR_MARK = 0x0046C02E;    // COLORREF 0x00BBGGRR: R=0x2E G=0xC0 B=0x46 (green)
        static readonly bool Supported = Environment.OSVersion.Version.Build >= 22000;

        static readonly object _lock = new object();
        static long _target;
        static string _error;

        /// <summary>
        /// Where the pending mark is recorded. A crash kills the engine without running its cleanup,
        /// so the next engine replays this record through <see cref="Sweep"/>.
        /// </summary>
        static readonly string StateFile = Path.Combine(
            Environment.GetEnvironmentVariable("CU_STATE_DIR")
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".computer-use-win"),
            "border.txt");

        public static bool Visible
        {
            get { lock (_lock) return _target != 0 && Native.IsWindow(new IntPtr(_target)); }
        }

        public static string Error { get { lock (_lock) return _error; } }

        /// <summary>The marked window rectangle in physical pixels, or null when nothing is marked.</summary>
        public static int[] Rect
        {
            get
            {
                lock (_lock)
                {
                    if (_target == 0) return null;
                    RECT rect;
                    if (!Native.GetWindowRect(new IntPtr(_target), out rect)) return null;
                    if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) return null;
                    return new[] { rect.Left, rect.Top, rect.Right, rect.Bottom };
                }
            }
        }

        /// <summary>Marks a window. Returns null on success, or why the window could not be marked.</summary>
        public static string Show(long hwnd)
        {
            lock (_lock)
            {
                var window = new IntPtr(hwnd);
                if (hwnd == 0 || !Native.IsWindow(window)) return "the target window does not exist";
                if (!Supported)
                {
                    _target = 0;
                    _error = "the DWM border colour needs Windows 11 (build 22000+).";
                    ClearState();
                    return null; // the cue is decoration, not a capability: older systems go without it
                }
                long previous = _target;
                _target = hwnd;
                _error = null;
                if (previous != 0 && previous != hwnd) Paint(new IntPtr(previous), COLOR_DEFAULT);
                int hr = Paint(window, COLOR_MARK);
                if (hr == 0)
                {
                    WriteState(hwnd);
                    return null;
                }
                _error = "DwmSetWindowAttribute(DWMWA_BORDER_COLOR) failed with 0x" + hr.ToString("X8") + ".";
                _target = 0;
                ClearState();
                return _error;
            }
        }

        /// <summary>Clears the mark this process owns.</summary>
        public static void Hide() { Hide(0); }

        /// <summary>
        /// Clears the mark. A non-zero handle is restored even when this process never marked it, so a
        /// restarted engine can still undo a border its predecessor left behind.
        /// </summary>
        public static void Hide(long hwnd)
        {
            lock (_lock)
            {
                long target = _target;
                _target = 0;
                _error = null;
                if (target != 0) Paint(new IntPtr(target), COLOR_DEFAULT);
                if (hwnd != 0 && hwnd != target) Paint(new IntPtr(hwnd), COLOR_DEFAULT);
                ClearState();
            }
        }

        /// <summary>
        /// Restores a border recorded by a previous engine that died before clearing it. Runs at
        /// engine boot, after the process that owned the mark is gone.
        /// </summary>
        public static void Sweep()
        {
            lock (_lock)
            {
                long hwnd = 0;
                uint pid = 0;
                try
                {
                    if (!File.Exists(StateFile)) return;
                    foreach (string line in File.ReadAllLines(StateFile))
                    {
                        int split = line.IndexOf('=');
                        if (split <= 0) continue;
                        string key = line.Substring(0, split);
                        string value = line.Substring(split + 1);
                        if (key == "hwnd") long.TryParse(value, out hwnd);
                        else if (key == "pid") uint.TryParse(value, out pid);
                    }
                }
                catch { return; }
                finally
                {
                    ClearState();
                }
                if (hwnd == 0 || !Native.IsWindow(new IntPtr(hwnd))) return;
                uint owner;
                Native.GetWindowThreadProcessId(new IntPtr(hwnd), out owner);
                if (pid != 0 && owner != pid) return; // the handle belongs to another process now
                Paint(new IntPtr(hwnd), COLOR_DEFAULT);
            }
        }

        static void WriteState(long hwnd)
        {
            try
            {
                uint pid;
                Native.GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
                File.WriteAllLines(StateFile, new[] { "hwnd=" + hwnd, "pid=" + pid });
            }
            catch { } // the mark already worked; a lost record only costs the post-crash cleanup
        }

        static void ClearState()
        {
            try { if (File.Exists(StateFile)) File.Delete(StateFile); } catch { }
        }

        static int Paint(IntPtr window, uint color)
        {
            // A window that is already gone needs no restoring, and DWM would only refuse it.
            if (!Native.IsWindow(window)) return 0;
            uint value = color;
            return Native.DwmSetWindowAttribute(window, DWMWA_BORDER_COLOR, ref value, 4);
        }
    }

    public static class Engine
    {
        static readonly object Sync = new object();
        static long _revision;
        static readonly HashSet<ushort> HeldVks = new HashSet<ushort>();
        static bool _leftDown, _rightDown, _middleDown;
        static ImageCodecInfo _jpegCodec;

        public static long NextRevision() { lock (Sync) { return ++_revision; } }
        public static long CurrentRevision { get { lock (Sync) { return _revision; } } }
        public static bool LeftButtonDown { get { return _leftDown; } }

        #region Startup / environment

        public static bool EnablePerMonitorV2() { return Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }

        public static int CurrentAwareness() { return Native.GetAwarenessFromDpiAwarenessContext(Native.GetThreadDpiAwarenessContext()); }

        public static string SessionReport()
        {
            uint session = 0;
            Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out session);
            var sb = new StringBuilder(256);
            int needed;
            Native.GetUserObjectInformationW(Native.GetProcessWindowStation(), 2 /*UOI_NAME*/, sb, 256, out needed);
            var desk = new StringBuilder(256);
            Native.GetUserObjectInformationW(Native.GetThreadDesktop(Native.GetCurrentThreadId()), 2, desk, 256, out needed);
            return session + "|" + sb + "|" + desk + "|" + Native.WTSGetActiveConsoleSessionId();
        }

        public static bool IsInteractiveDesktop()
        {
            uint session = 0;
            Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out session);
            var ws = new StringBuilder(256);
            int needed;
            Native.GetUserObjectInformationW(Native.GetProcessWindowStation(), 2, ws, 256, out needed);
            // Interactive window stations are "WinSta0"; service stations are named after the service.
            return session != 0 && string.Equals(ws.ToString(), "WinSta0", StringComparison.OrdinalIgnoreCase);
        }

        #endregion

        #region Integrity levels

        const uint TOKEN_QUERY = 0x0008;
        const int TokenIntegrityLevel = 25;

        /// <summary>
        /// Integrity RID of a process. Returns:
        ///   0x1000 low / 0x2000 medium / 0x3000 high / 0x4000 system / 0x5000 protected
        ///   -1  unknown (process gone or not openable)
        ///   -2  restricted: the process exists but its token cannot be queried from here. For a
        ///       same-user target this means it runs at a higher integrity level (UIPI), which is
        ///       the signal that an elevated helper is required.
        /// </summary>
        public static int IntegrityLevelOf(uint pid)
        {
            IntPtr proc = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (proc == IntPtr.Zero) return -1;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(proc, TOKEN_QUERY, out token)) return -2;
                int needed = 0;
                Native.GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out needed);
                if (needed <= 0) return -2;
                IntPtr buf = Marshal.AllocHGlobal(needed);
                try
                {
                    if (!Native.GetTokenInformation(token, TokenIntegrityLevel, buf, needed, out needed)) return -2;
                    // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label; }
                    IntPtr sid = Marshal.ReadIntPtr(buf);
                    if (sid == IntPtr.Zero) return -1;
                    IntPtr countPtr = Native.GetSidSubAuthorityCount(sid);
                    if (countPtr == IntPtr.Zero) return -1;
                    byte count = Marshal.ReadByte(countPtr);
                    if (count == 0) return -1;
                    IntPtr subPtr = Native.GetSidSubAuthority(sid, (uint)(count - 1));
                    if (subPtr == IntPtr.Zero) return -1;
                    return Marshal.ReadInt32(subPtr);
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            catch { return -1; }
            finally
            {
                if (token != IntPtr.Zero) Native.CloseHandle(token);
                Native.CloseHandle(proc);
            }
        }

        public static string IntegrityName(int level)
        {
            if (level == -2) return "restricted";
            if (level < 0) return "unknown";
            if (level >= 0x5000) return "protected";
            if (level >= 0x4000) return "system";
            if (level >= 0x3000) return "high";
            if (level >= 0x2000) return "medium";
            if (level >= 0x1000) return "low";
            return "untrusted";
        }

        public static int SelfIntegrity()
        {
            return IntegrityLevelOf((uint)Process.GetCurrentProcess().Id);
        }

        public static long ProcessStartTimeOf(uint pid)
        {
            return ProcessStartTime(pid);
        }

        /// <summary>
        /// String SID of the user owning a process. The elevated helper uses it to grant the pipe
        /// to exactly the process that asked for elevation (the elevated token may belong to a
        /// different account when UAC uses alternate credentials).
        /// </summary>
        public static string UserSidOf(uint pid)
        {
            IntPtr proc = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (proc == IntPtr.Zero) return null;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(proc, TOKEN_QUERY, out token)) return null;
                int needed = 0;
                Native.GetTokenInformation(token, 1 /*TokenUser*/, IntPtr.Zero, 0, out needed);
                if (needed <= 0) return null;
                IntPtr buf = Marshal.AllocHGlobal(needed);
                try
                {
                    if (!Native.GetTokenInformation(token, 1, buf, needed, out needed)) return null;
                    IntPtr sid = Marshal.ReadIntPtr(buf); // TOKEN_USER { SID_AND_ATTRIBUTES User; }
                    if (sid == IntPtr.Zero) return null;
                    IntPtr str;
                    if (!Native.ConvertSidToStringSidW(sid, out str)) return null;
                    try { return Marshal.PtrToStringUni(str); }
                    finally { Native.LocalFree(str); }
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            catch { return null; }
            finally
            {
                if (token != IntPtr.Zero) Native.CloseHandle(token);
                Native.CloseHandle(proc);
            }
        }

        #endregion

        #region Monitors

        // Monitor topology changes rarely; a short cache keeps per-window lookups cheap without
        // serving visibly stale geometry (docking/resolution changes settle well inside a second).
        static List<MonitorInfo> _monitorCache;
        static long _monitorCacheAt;
        // Monotonic clock: Environment.TickCount64 does not exist on .NET Framework.
        static readonly System.Diagnostics.Stopwatch Clock = System.Diagnostics.Stopwatch.StartNew();

        public static List<MonitorInfo> Monitors()
        {
            long now = Clock.ElapsedMilliseconds;
            if (_monitorCache != null && now - _monitorCacheAt < 1000) return _monitorCache;
            var list = new List<MonitorInfo>();
            var primary = Native.MonitorFromPoint(new POINT { X = 0, Y = 0 }, Native.MONITOR_DEFAULTTONEAREST);
            int index = 0;
            EnumMonitorsProc cb = delegate(IntPtr hmon, IntPtr hdc, IntPtr rectPtr, IntPtr data)
            {
                var info = new MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (!Native.GetMonitorInfo(hmon, ref info)) return true;
                uint dx = 96, dy = 96;
                try { Native.GetDpiForMonitor(hmon, 0, out dx, out dy); } catch { }
                var m = new MonitorInfo
                {
                    id = index++,
                    deviceName = info.szDevice,
                    x = info.rcMonitor.Left,
                    y = info.rcMonitor.Top,
                    width = info.rcMonitor.Right - info.rcMonitor.Left,
                    height = info.rcMonitor.Bottom - info.rcMonitor.Top,
                    workX = info.rcWork.Left,
                    workY = info.rcWork.Top,
                    workWidth = info.rcWork.Right - info.rcWork.Left,
                    workHeight = info.rcWork.Bottom - info.rcWork.Top,
                    dpi = dx,
                    primary = (info.dwFlags & 1) != 0 || hmon == primary
                };
                list.Add(m);
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            _monitorCache = list;
            _monitorCacheAt = Clock.ElapsedMilliseconds;
            return list;
        }

        public static MonitorInfo MonitorForWindow(long hwnd)
        {
            var hmon = Native.MonitorFromWindow(new IntPtr(hwnd), Native.MONITOR_DEFAULTTONEAREST);
            var info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (!Native.GetMonitorInfo(hmon, ref info)) return null;
            uint dx = 96, dy = 96;
            try { Native.GetDpiForMonitor(hmon, 0, out dx, out dy); } catch { }
            return new MonitorInfo
            {
                deviceName = info.szDevice,
                x = info.rcMonitor.Left, y = info.rcMonitor.Top,
                width = info.rcMonitor.Right - info.rcMonitor.Left,
                height = info.rcMonitor.Bottom - info.rcMonitor.Top,
                dpi = dx,
                primary = (info.dwFlags & 1) != 0
            };
        }

        #endregion

        #region Window identity

        static string ExePathForPid(uint pid)
        {
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                uint size = 1024;
                if (Native.QueryFullProcessImageNameW(h, 0, sb, ref size)) return sb.ToString();
                return null;
            }
            finally { Native.CloseHandle(h); }
        }

        static long ProcessStartTime(uint pid)
        {
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return 0;
            try
            {
                long c, e, k, u;
                if (Native.GetProcessTimes(h, out c, out e, out k, out u)) return c;
                return 0;
            }
            finally { Native.CloseHandle(h); }
        }

        static string AwarenessName(int awareness)
        {
            switch (awareness)
            {
                case 0: return "unaware";
                case 1: return "system";
                case 2: return "per-monitor";
                default: return "unknown";
            }
        }

        public static WindowInfo Window(long hwnd)
        {
            return Window(hwnd, null);
        }

        public static WindowInfo Window(long hwnd, Lookup lookup)
        {
            var h = new IntPtr(hwnd);
            if (!Native.IsWindow(h)) return null;
            var info = new WindowInfo { hwnd = hwnd };
            var sb = new StringBuilder(1024);
            Native.GetWindowTextW(h, sb, 1024);
            info.title = sb.ToString();
            var cls = new StringBuilder(256);
            Native.GetClassNameW(h, cls, 256);
            info.className = cls.ToString();
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            info.pid = pid;
            info.processName = ProcessNameFor(pid, lookup);
            info.exePath = ExePathFor(pid, lookup);
            info.processStartTime = StartTimeFor(pid, lookup);
            info.integrityValue = IntegrityLevelOf(pid);
            info.integrity = IntegrityName(info.integrityValue);
            info.visible = Native.IsWindowVisible(h);
            info.enabled = Native.IsWindowEnabled(h);
            info.minimized = Native.IsIconic(h);
            info.maximized = Native.IsZoomed(h);

            RECT r;
            Native.GetWindowRect(h, out r);
            info.x = r.Left; info.y = r.Top;
            info.width = r.Right - r.Left; info.height = r.Bottom - r.Top;

            RECT dwm;
            if (Native.DwmGetWindowAttribute(h, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out dwm, Marshal.SizeOf(typeof(RECT))) == 0)
            {
                info.frameX = dwm.Left; info.frameY = dwm.Top;
                info.frameWidth = dwm.Right - dwm.Left; info.frameHeight = dwm.Bottom - dwm.Top;
            }
            else
            {
                info.frameX = info.x; info.frameY = info.y;
                info.frameWidth = info.width; info.frameHeight = info.height;
            }

            RECT cr;
            Native.GetClientRect(h, out cr);
            var origin = new POINT();
            Native.ClientToScreen(h, ref origin);
            info.clientX = origin.X; info.clientY = origin.Y;
            info.clientWidth = cr.Right - cr.Left; info.clientHeight = cr.Bottom - cr.Top;

            int awareness = 0;
            try { awareness = Native.GetAwarenessFromDpiAwarenessContext(Native.GetWindowDpiAwarenessContext(h)); } catch { }
            info.dpiAwareness = AwarenessName(awareness);
            try { info.dpi = Native.GetDpiForWindow(h); } catch { info.dpi = 96; }

            var mon = MonitorForWindow(hwnd);
            if (mon != null)
            {
                var all = lookup != null && lookup.Monitors != null ? lookup.Monitors : Monitors();
                for (int i = 0; i < all.Count; i++)
                    if (all[i].deviceName == mon.deviceName) { info.monitorId = all[i].id; break; }
            }

            info.isForeground = Native.GetForegroundWindow() == h;

            var root = Native.GetAncestor(h, Native.GA_ROOT);
            if (root != IntPtr.Zero && root != h)
            {
                info.rootHwnd = root.ToInt64();
                var rsb = new StringBuilder(512);
                Native.GetWindowTextW(root, rsb, 512);
                info.rootTitle = rsb.ToString();
                uint rpid;
                Native.GetWindowThreadProcessId(root, out rpid);
                info.rootPid = rpid;
                info.rootExePath = ExePathFor(rpid, lookup);
                info.rootIntegrityValue = rpid == pid ? info.integrityValue : IntegrityLevelOf(rpid);
                info.rootIntegrity = IntegrityName(info.rootIntegrityValue);
            }
            else
            {
                info.rootHwnd = hwnd;
                info.rootTitle = info.title;
                info.rootPid = pid;
                info.rootExePath = info.exePath;
                info.rootIntegrityValue = info.integrityValue;
                info.rootIntegrity = info.integrity;
            }
            return info;
        }

        /// <summary>
        /// Top-level + child class names of a window, as "hwnd|class" strings.
        /// Binding uses this once to classify the window framework (which decides the input
        /// channel). EnumChildWindows is cross-process and read-only, so it works for elevated
        /// targets too; `maxChildren` caps the child list, and `ClassTreeTruncated` reports that
        /// the cap was hit (a truncated tree must not be trusted as "no framework marker").
        /// </summary>
        public static bool ClassTreeTruncated;

        public static string[] ClassTree(long hwnd, int maxChildren)
        {
            ClassTreeTruncated = false;
            var list = new List<string>();
            var h = new IntPtr(hwnd);
            if (!Native.IsWindow(h)) return list.ToArray();
            var top = new StringBuilder(256);
            Native.GetClassNameW(h, top, 256);
            list.Add(h.ToInt64() + "|" + top.ToString());
            int children = 0;
            Native.EnumChildWindows(h, delegate(IntPtr child, IntPtr data)
            {
                if (children >= maxChildren) { ClassTreeTruncated = true; return false; }
                children++;
                var cls = new StringBuilder(256);
                Native.GetClassNameW(child, cls, 256);
                list.Add(child.ToInt64() + "|" + cls.ToString());
                return true;
            }, IntPtr.Zero);
            return list.ToArray();
        }

        static string ExePathFor(uint pid, Lookup lookup)
        {
            if (lookup == null) return ExePathForPid(pid);
            string cached;
            if (lookup.Exe.TryGetValue(pid, out cached)) return cached;
            var value = ExePathForPid(pid);
            lookup.Exe[pid] = value;
            return value;
        }

        static long StartTimeFor(uint pid, Lookup lookup)
        {
            if (lookup == null) return ProcessStartTime(pid);
            long cached;
            if (lookup.Start.TryGetValue(pid, out cached)) return cached;
            var value = ProcessStartTime(pid);
            lookup.Start[pid] = value;
            return value;
        }

        static string ProcessNameFor(uint pid, Lookup lookup)
        {
            if (lookup == null)
            {
                try { return Process.GetProcessById((int)pid).ProcessName; } catch { return null; }
            }
            string cached;
            if (lookup.Name.TryGetValue(pid, out cached)) return cached;
            string value;
            try { value = Process.GetProcessById((int)pid).ProcessName; } catch { value = null; }
            lookup.Name[pid] = value;
            return value;
        }

        public static List<WindowInfo> Windows(bool visibleOnly, int max, uint excludePid)
        {
            var list = new List<WindowInfo>();
            var lookup = new Lookup();
            lookup.Monitors = Monitors();
            Native.EnumWindows(delegate(IntPtr h, IntPtr data)
            {
                if (list.Count >= max) return false;
                if (visibleOnly && !Native.IsWindowVisible(h)) return true;
                var sb = new StringBuilder(512);
                Native.GetWindowTextW(h, sb, 512);
                if (sb.Length == 0 && visibleOnly) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                if (excludePid != 0 && pid == excludePid) return true;
                var wi = Window(h.ToInt64(), lookup);
                if (wi != null) list.Add(wi);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static WindowInfo ForegroundWindow()
        {
            var fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return null;
            return Window(fg.ToInt64());
        }

        public static WindowInfo HitTest(int x, int y)
        {
            var h = Native.WindowFromPoint(new POINT { X = x, Y = y });
            if (h == IntPtr.Zero) return null;
            return Window(h.ToInt64());
        }

        public static WindowInfo FindWindow(string title, string className, string exePath, string processName)
        {
            WindowInfo best = null;
            Native.EnumWindows(delegate(IntPtr h, IntPtr data)
            {
                if (!Native.IsWindowVisible(h)) return true;
                var sb = new StringBuilder(512);
                Native.GetWindowTextW(h, sb, 512);
                var t = sb.ToString();
                var cls = new StringBuilder(256);
                Native.GetClassNameW(h, cls, 256);
                var c = cls.ToString();
                if (!string.IsNullOrEmpty(title) && t.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
                if (!string.IsNullOrEmpty(className) && c.IndexOf(className, StringComparison.OrdinalIgnoreCase) < 0) return true;
                uint pid;
                Native.GetWindowThreadProcessId(h, out pid);
                string exe = null, pname = null;
                if (!string.IsNullOrEmpty(exePath) || !string.IsNullOrEmpty(processName))
                {
                    exe = ExePathForPid(pid);
                    try { pname = Process.GetProcessById((int)pid).ProcessName; } catch { }
                    if (!string.IsNullOrEmpty(exePath) && (exe == null || exe.IndexOf(exePath, StringComparison.OrdinalIgnoreCase) < 0)) return true;
                    if (!string.IsNullOrEmpty(processName) && (pname == null || pname.IndexOf(processName, StringComparison.OrdinalIgnoreCase) < 0)) return true;
                }
                best = Window(h.ToInt64());
                return false;
            }, IntPtr.Zero);
            return best;
        }

        public static int[] CursorPosition()
        {
            POINT p;
            Native.GetCursorPos(out p);
            return new int[] { p.X, p.Y };
        }

        public static bool IsUnoccluded(long hwnd)
        {
            var info = Window(hwnd);
            if (info == null || !info.visible || info.minimized) return false;
            // Sample the window frame at a few points; the window is considered unoccluded only if
            // every sampled point resolves to a window owned by the same root.
            var root = new IntPtr(info.rootHwnd);
            int x0 = info.frameX, y0 = info.frameY;
            int w = info.frameWidth, h = info.frameHeight;
            var pts = new POINT[] {
                new POINT { X = x0 + w / 2, Y = y0 + h / 2 },
                new POINT { X = x0 + w / 4, Y = y0 + h / 4 },
                new POINT { X = x0 + 3 * w / 4, Y = y0 + h / 4 },
                new POINT { X = x0 + w / 4, Y = y0 + 3 * h / 4 },
                new POINT { X = x0 + 3 * w / 4, Y = y0 + 3 * h / 4 }
            };
            foreach (var p in pts)
            {
                var hit = Native.WindowFromPoint(p);
                if (hit == IntPtr.Zero) return false;
                if (Native.GetAncestor(hit, Native.GA_ROOT) != root) return false;
            }
            return true;
        }

        #endregion

        #region Capture

        static ImageCodecInfo JpegCodec()
        {
            if (_jpegCodec != null) return _jpegCodec;
            foreach (var codec in ImageCodecInfo.GetImageEncoders())
                if (codec.MimeType == "image/jpeg") { _jpegCodec = codec; break; }
            return _jpegCodec;
        }

        static Bitmap CapturePrintWindow(IntPtr hwnd, int width, int height, List<string> notes)
        {
            if (width <= 0 || height <= 0) return null;
            var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                bool ok;
                try { ok = Native.PrintWindow(hwnd, hdc, 2 /*PW_RENDERFULLCONTENT*/); }
                finally { g.ReleaseHdc(hdc); }
                if (!ok)
                {
                    // Retry without the flag: some legacy windows only support the old path.
                    hdc = g.GetHdc();
                    try { ok = Native.PrintWindow(hwnd, hdc, 0); }
                    finally { g.ReleaseHdc(hdc); }
                    notes.Add(ok ? "printwindow_flag0_retry" : "printwindow_failed");
                }
            }
            return bmp;
        }

        static Bitmap CaptureScreenRegion(Rectangle rect)
        {
            var bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.Width, rect.Height), CopyPixelOperation.SourceCopy);
            }
            return bmp;
        }

        /// Returns true when the bitmap has essentially no content (PrintWindow failure signature).
        static bool LooksBlank(Bitmap bmp)
        {
            int w = bmp.Width, h = bmp.Height;
            if (w < 2 || h < 2) return true;
            var first = bmp.GetPixel(w / 2, h / 2);
            int same = 0, total = 0, nearBlack = 0;
            int stepX = Math.Max(1, w / 32), stepY = Math.Max(1, h / 32);
            for (int x = 0; x < w; x += stepX)
            {
                for (int y = 0; y < h; y += stepY)
                {
                    var p = bmp.GetPixel(x, y);
                    total++;
                    if (p.R == first.R && p.G == first.G && p.B == first.B) same++;
                    if (p.R < 8 && p.G < 8 && p.B < 8) nearBlack++;
                }
            }
            if (total == 0) return true;
            if (same == total) return true;              // completely uniform
            if (nearBlack == total) return true;         // pure black
            return false;
        }

        static Bitmap Downscale(Bitmap src, int maxWidth, int maxHeight)
        {
            if (maxWidth <= 0 && maxHeight <= 0) return src;
            int w = src.Width, h = src.Height;
            double s = 1.0;
            if (maxWidth > 0) s = Math.Min(s, (double)maxWidth / w);
            if (maxHeight > 0) s = Math.Min(s, (double)maxHeight / h);
            if (s >= 1.0) return src;
            int nw = Math.Max(1, (int)Math.Round(w * s));
            int nh = Math.Max(1, (int)Math.Round(h * s));
            var dst = new Bitmap(nw, nh, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.CompositingMode = CompositingMode.SourceCopy;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.DrawImage(src, new Rectangle(0, 0, nw, nh));
            }
            return dst;
        }

        static string EncodeJpegBase64(Bitmap bmp, int quality)
        {
            using (var ms = new System.IO.MemoryStream())
            {
                var ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                bmp.Save(ms, JpegCodec(), ps);
                return Convert.ToBase64String(ms.ToArray());
            }
        }

        /// Capture a monitor (physical pixels) or a window (PrintWindow, with screen fallback).
        /// `rect` (when given, screen target only) crops the monitor in physical screen coordinates.
        public static CaptureResult Capture(int monitorId, long hwnd, int maxWidth, int maxHeight, int quality, bool usePrintWindow, int cropX, int cropY, int cropW, int cropH)
        {
            var result = new CaptureResult { mimeType = "image/jpeg", revision = NextRevision() };
            Bitmap bmp = null;
            try
            {
                if (hwnd != 0)
                {
                    result.captureMode = "bound_window";
                    var info = Window(hwnd);
                    if (info == null) { result.errorCode = "window_not_found"; result.errorMessage = "Window handle is no longer valid."; return result; }
                    if (info.minimized) { result.errorCode = "window_minimized"; result.errorMessage = "Window is minimized; restore it with window_activate before capturing."; return result; }

                    int w = info.width, h = info.height;
                    if (usePrintWindow)
                    {
                        bmp = CapturePrintWindow(new IntPtr(hwnd), w, h, result.notes);
                        result.captureMethod = "printwindow";
                    }
                    if (bmp == null || LooksBlank(bmp))
                    {
                        bool blank = bmp != null;
                        bool unoccluded = IsUnoccluded(hwnd);
                        if (!unoccluded)
                        {
                            if (blank)
                            {
                                bmp.Dispose();
                                result.errorCode = "capture_failed";
                                result.errorMessage = "PrintWindow produced a blank image and the window is occluded, so a screen capture would capture the wrong pixels. Bring the window to the front (window_activate) and retry.";
                                return result;
                            }
                            result.errorCode = "capture_failed";
                            result.errorMessage = "Window capture failed.";
                            return result;
                        }
                        result.notes.Add(bmp == null ? "fell_back_to_screen" : "blank_printwindow_fell_back_to_screen");
                        if (bmp != null) bmp.Dispose();
                        bmp = CaptureScreenRegion(new Rectangle(info.x, info.y, Math.Max(1, w), Math.Max(1, h)));
                        result.captureMethod = "screen";
                    }

                    // DPI-unaware targets render their logical size into the top-left of the physical
                    // canvas; stretch it so image pixels match what the user actually sees on screen.
                    int awareness = 0;
                    try { awareness = Native.GetAwarenessFromDpiAwarenessContext(Native.GetWindowDpiAwarenessContext(new IntPtr(hwnd))); } catch { }
                    var mon = MonitorForWindow(hwnd);
                    uint monDpi = mon != null ? mon.dpi : 96;
                    if (awareness == 0 && monDpi > 96 && (info.className == "MainWindow" || info.className.StartsWith("WindowsForms10.", StringComparison.OrdinalIgnoreCase)))
                    {
                        double scale = monDpi / 96.0;
                        int contentW = (int)Math.Round(info.width / scale);
                        int contentH = (int)Math.Round(info.height / scale);
                        if (contentW > 0 && contentH > 0 && contentW <= info.width && contentH <= info.height)
                        {
                            var fixedBmp = new Bitmap(info.width, info.height, PixelFormat.Format24bppRgb);
                            using (var g = Graphics.FromImage(fixedBmp))
                            {
                                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                g.DrawImage(bmp, new Rectangle(0, 0, info.width, info.height),
                                    new Rectangle(0, 0, contentW, contentH), GraphicsUnit.Pixel);
                            }
                            bmp.Dispose();
                            bmp = fixedBmp;
                            result.normalized = true;
                            result.notes.Add("normalized_dpi_unaware_content");
                        }
                    }
                    else if (awareness == 0 && monDpi > 96)
                    {
                        // Another DPI-unaware window type. Guessing a crop would be worse than
                        // saying so, but the caller must know the coordinates may be scaled.
                        result.notes.Add("dpi_unaware_not_normalized");
                    }

                    result.originX = info.x;
                    result.originY = info.y;
                    result.sourceWidth = info.width;
                    result.sourceHeight = info.height;

                    // Region capture inside the window (zoom): crop after normalization so the
                    // crop rectangle is in the same pixel space the model saw.
                    if (cropW > 0 && cropH > 0)
                    {
                        var rect = new Rectangle(cropX, cropY, cropW, cropH);
                        rect.Intersect(new Rectangle(0, 0, bmp.Width, bmp.Height));
                        if (rect.Width <= 0 || rect.Height <= 0)
                        {
                            result.ok = false;
                            result.errorCode = "bad_crop";
                            result.errorMessage = "The zoom region does not intersect the window surface.";
                            return result;
                        }
                        var cropped = bmp.Clone(rect, PixelFormat.Format24bppRgb);
                        bmp.Dispose();
                        bmp = cropped;
                        result.originX = info.x + rect.X;
                        result.originY = info.y + rect.Y;
                        result.sourceWidth = rect.Width;
                        result.sourceHeight = rect.Height;
                    }
                }
                else
                {
                    result.captureMode = "full_display";
                    var monitors = Monitors();
                    if (monitors.Count == 0) { result.errorCode = "no_monitors"; result.errorMessage = "No displays reported by EnumDisplayMonitors."; return result; }
                    MonitorInfo mon = null;
                    if (monitorId >= 0 && monitorId < monitors.Count) mon = monitors[monitorId];
                    if (mon == null) mon = monitors.Find(m => m.primary) ?? monitors[0];
                    int x = mon.x, y = mon.y, w = mon.width, h = mon.height;
                    if (cropW > 0 && cropH > 0) { x = cropX; y = cropY; w = cropW; h = cropH; }
                    bmp = CaptureScreenRegion(new Rectangle(x, y, Math.Max(1, w), Math.Max(1, h)));
                    result.captureMethod = "screen";
                    result.originX = x;
                    result.originY = y;
                    result.sourceWidth = w;
                    result.sourceHeight = h;
                }

                if (LooksBlank(bmp))
                {
                    result.notes.Add("suspiciously_blank_capture");
                }

                result.scale = Math.Min(1.0, Math.Min(maxWidth > 0 ? (double)maxWidth / bmp.Width : 1.0, maxHeight > 0 ? (double)maxHeight / bmp.Height : 1.0));
                var shrunk = Downscale(bmp, maxWidth, maxHeight);
                try
                {
                    result.imageWidth = shrunk.Width;
                    result.imageHeight = shrunk.Height;
                    result.base64 = EncodeJpegBase64(shrunk, quality);
                }
                finally
                {
                    if (!ReferenceEquals(shrunk, bmp)) shrunk.Dispose();
                }
                result.ok = true;
                return result;
            }
            catch (Exception ex)
            {
                result.ok = false;
                result.errorCode = "capture_exception";
                result.errorMessage = ex.GetType().Name + ": " + ex.Message;
                return result;
            }
            finally
            {
                if (bmp != null) bmp.Dispose();
            }
        }

        #endregion

        #region Virtual key mapping

        static readonly Dictionary<string, ushort> VkMap = BuildVkMap();

        static Dictionary<string, ushort> BuildVkMap()
        {
            var m = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            for (char c = 'a'; c <= 'z'; c++) m[c.ToString()] = (ushort)(0x41 + (c - 'a'));
            for (char c = '0'; c <= '9'; c++) m[c.ToString()] = (ushort)(0x30 + (c - '0'));
            for (int i = 1; i <= 24; i++) m["f" + i] = (ushort)(0x70 + i - 1);
            m["return"] = 0x0D; m["enter"] = 0x0D; m["tab"] = 0x09; m["escape"] = 0x1B; m["esc"] = 0x1B;
            m["space"] = 0x20; m["backspace"] = 0x08; m["delete"] = 0x2E; m["del"] = 0x2E; m["insert"] = 0x2D;
            m["home"] = 0x24; m["end"] = 0x23; m["pageup"] = 0x21; m["pagedown"] = 0x22; m["prior"] = 0x21; m["next"] = 0x22;
            m["up"] = 0x26; m["down"] = 0x28; m["left"] = 0x25; m["right"] = 0x27;
            m["shift"] = 0x10; m["ctrl"] = 0x11; m["control"] = 0x11; m["alt"] = 0x12; m["option"] = 0x12;
            m["win"] = 0x5B; m["meta"] = 0x5B; m["cmd"] = 0x5B; m["command"] = 0x5B; m["super"] = 0x5B; m["lwin"] = 0x5B; m["rwin"] = 0x5C;
            m["capslock"] = 0x14; m["numlock"] = 0x90; m["scrolllock"] = 0x91; m["printscreen"] = 0x2C; m["pause"] = 0x13;
            m["minus"] = 0xBD; m["equal"] = 0xBB; m["comma"] = 0xBC; m["period"] = 0xBE; m["slash"] = 0xBF; m["backslash"] = 0xDC;
            m["semicolon"] = 0xBA; m["quote"] = 0xDE; m["bracketleft"] = 0xDB; m["bracketright"] = 0xDD; m["grave"] = 0xC0; m["accent"] = 0xC0;
            m["numpad0"] = 0x60; m["numpad1"] = 0x61; m["numpad2"] = 0x62; m["numpad3"] = 0x63; m["numpad4"] = 0x64;
            m["numpad5"] = 0x65; m["numpad6"] = 0x66; m["numpad7"] = 0x67; m["numpad8"] = 0x68; m["numpad9"] = 0x69;
            m["add"] = 0x6B; m["subtract"] = 0x6D; m["multiply"] = 0x6A; m["divide"] = 0x6F; m["decimal"] = 0x6E; m["plus"] = 0x6B;
            m["apps"] = 0x5D; m["menu"] = 0x5D;
            return m;
        }

        static readonly uint[] ExtendedKeys = {
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0x2C
        };

        static bool IsExtended(ushort vk) { return Array.IndexOf(ExtendedKeys, (uint)vk) >= 0; }

        public static ushort ResolveKey(string name)
        {
            if (string.IsNullOrEmpty(name)) return 0;
            var key = name.Trim();
            ushort vk;
            if (VkMap.TryGetValue(key, out vk)) return vk;
            if (key.Length == 1) return (ushort)(Native.VkKeyScanW(key[0]) & 0xFF);
            return 0;
        }

        static INPUT KeyInput(ushort vk, bool up)
        {
            var i = new INPUT();
            i.type = 1; // INPUT_KEYBOARD
            i.u.ki.wVk = vk;
            i.u.ki.wScan = (ushort)Native.MapVirtualKeyW(vk, 0);
            uint flags = up ? Native.KEYEVENTF_KEYUP : 0;
            if (IsExtended(vk)) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            i.u.ki.dwFlags = flags;
            return i;
        }

        #endregion

        #region Input

        static int SendInputs(INPUT[] inputs)
        {
            if (inputs.Length == 0) return 0;
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            return (int)sent;
        }

        static void CheckForeground(InputResult result, long expectedHwnd)
        {
            var fg = Native.GetForegroundWindow();
            result.foregroundHwnd = fg.ToInt64();
            if (expectedHwnd != 0) result.foregroundVerified = fg.ToInt64() == expectedHwnd;
            else result.foregroundVerified = fg != IntPtr.Zero;
        }

        public static bool Activate(long hwnd, InputResult result)
        {
            var h = new IntPtr(hwnd);
            if (!Native.IsWindow(h)) return false;
            var info = Window(hwnd);
            if (info == null) return false;
            if (info.minimized) Native.ShowWindow(h, Native.SW_RESTORE);
            if (Native.GetForegroundWindow() == h) { if (result != null) CheckForeground(result, hwnd); return true; }

            Native.SetForegroundWindow(h);
            if (Native.GetForegroundWindow() == h) { if (result != null) CheckForeground(result, hwnd); return true; }

            // Alt-nudge: a bare ALT tap releases Windows' foreground lock in many cases where a
            // plain SetForegroundWindow is ignored (same trick the upstream implementation uses).
            try
            {
                Native.keybd_event(0x12, 0, 0, IntPtr.Zero);
                Native.keybd_event(0x12, 0, 2 /*KEYUP*/, IntPtr.Zero);
            }
            catch { }
            Thread.Sleep(60);
            Native.SetForegroundWindow(h);
            if (Native.GetForegroundWindow() == h) { if (result != null) CheckForeground(result, hwnd); return true; }

            // Attach to the current foreground thread so Windows lets us change it.
            var fg = Native.GetForegroundWindow();
            uint fgPid;
            uint fgThread = Native.GetWindowThreadProcessId(fg, out fgPid);
            uint myThread = Native.GetCurrentThreadId();
            bool attached = false;
            try
            {
                attached = Native.AttachThreadInput(myThread, fgThread, true);
                Native.BringWindowToTop(h);
                Native.SetForegroundWindow(h);
                Native.SetActiveWindow(h);
            }
            finally
            {
                if (attached) Native.AttachThreadInput(myThread, fgThread, false);
            }
            if (Native.GetForegroundWindow() == h) { if (result != null) CheckForeground(result, hwnd); return true; }

            Native.SwitchToThisWindow(h, true);
            if (Native.GetForegroundWindow() == h) { if (result != null) CheckForeground(result, hwnd); return true; }

            if (result != null) { CheckForeground(result, hwnd); result.notes.Add("activate_failed"); }
            return false;
        }

        /// Moves the cursor and issues a click with real input. `count` clicks are emitted inside a
        /// single call so the OS double-click counter sees consistent timing.
        /// With `message` the click is posted to the deepest child under the point instead: no
        /// cursor movement, no focus change, works while the window is covered.
        /// `expectedPid` / `expectedStartTime` close the check-to-dispatch gap: a recycled HWND is
        /// refused here even if the caller's own check raced with the reuse.
        public static InputResult Click(int x, int y, string button, int count, string[] modifiers, long expectedHwnd, bool message, uint expectedPid, long expectedStartTime)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            lock (Sync)
            {
                try
                {
                    if (expectedHwnd != 0)
                    {
                        var expected = new IntPtr(expectedHwnd);
                        if (!Native.IsWindow(expected))
                        {
                            result.errorCode = "window_not_found";
                            result.errorMessage = "The target window no longer exists; nothing was sent.";
                            return result;
                        }
                        uint livePid;
                        Native.GetWindowThreadProcessId(expected, out livePid);
                        if ((expectedPid != 0 && livePid != expectedPid) ||
                            (expectedStartTime != 0 && ProcessStartTime(livePid) / 10000000L != expectedStartTime))
                        {
                            result.errorCode = "target_identity_changed";
                            result.errorMessage = "The target window now belongs to a different process instance (PID " +
                                livePid + "); the binding is void and nothing was sent.";
                            return result;
                        }
                    }
                    if (message)
                    {
                        if (expectedHwnd == 0)
                        {
                            result.errorCode = "bad_args";
                            result.errorMessage = "Message-mode input needs a bound window handle.";
                            return result;
                        }
                        return ClickPosted(x, y, button, count, expectedHwnd, expectedPid);
                    }

                    if (!Native.SetCursorPos(x, y))
                    {
                        result.errorCode = "cursor_move_failed";
                        result.errorMessage = "SetCursorPos rejected the coordinates (" + x + "," + y + ").";
                        return result;
                    }
                    Thread.Sleep(12);

                    var inputs = new List<INPUT>();
                    foreach (var m in modifiers ?? new string[0])
                    {
                        ushort vk = ResolveKey(m);
                        if (vk == 0) { result.errorCode = "unknown_modifier"; result.errorMessage = "Unknown modifier: " + m; return result; }
                        inputs.Add(KeyInput(vk, false));
                    }
                    uint downFlag, upFlag; uint data = 0;
                    switch (button)
                    {
                        case "right": downFlag = Native.MOUSEEVENTF_RIGHTDOWN; upFlag = Native.MOUSEEVENTF_RIGHTUP; break;
                        case "middle": downFlag = Native.MOUSEEVENTF_MIDDLEDOWN; upFlag = Native.MOUSEEVENTF_MIDDLEUP; break;
                        default: downFlag = Native.MOUSEEVENTF_LEFTDOWN; upFlag = Native.MOUSEEVENTF_LEFTUP; break;
                    }
                    for (int i = 0; i < count; i++)
                    {
                        var d = new INPUT(); d.type = 0; d.u.mi.dwFlags = downFlag; d.u.mi.mouseData = data; inputs.Add(d);
                        var u = new INPUT(); u.type = 0; u.u.mi.dwFlags = upFlag; u.u.mi.mouseData = data; inputs.Add(u);
                        if (i + 1 < count) { var m2 = new INPUT(); m2.type = 0; m2.u.mi.dwFlags = 0; inputs.Add(m2); }
                    }
                    for (int i = (modifiers ?? new string[0]).Length - 1; i >= 0; i--)
                    {
                        ushort vk = ResolveKey(modifiers[i]);
                        inputs.Add(KeyInput(vk, true));
                    }
                    // Mark the button as held before dispatch: if SendInput only partially succeeds,
                    // release_all still knows what to let go of.
                    if (button == "left") _leftDown = true;
                    else if (button == "right") _rightDown = true;
                    else _middleDown = true;
                    int sent = SendInputs(inputs.ToArray());
                    if (sent != inputs.Count)
                    {
                        result.errorCode = "input_rejected";
                        result.errorMessage = "SendInput accepted " + sent + " of " + inputs.Count + " events (UIPI or input blocked).";
                        ReleaseAllQuiet();
                        return result;
                    }
                    _leftDown = false; _rightDown = false; _middleDown = false;
                    result.ok = true;
                    result.dispatchedEvents = sent;
                    CheckForeground(result, expectedHwnd);
                    return result;
                }
                catch (Exception ex)
                {
                    result.errorCode = "input_exception";
                    result.errorMessage = ex.GetType().Name + ": " + ex.Message;
                    return result;
                }
            }
        }

        /// <summary>
        /// Posted-message click for bound windows whose framework accepts classic USER32 messages.
        /// Caller holds Sync. Posts to the deepest child under the point (an Edit control, not its
        /// top-level frame), verifies the owning process before posting anything, and never moves
        /// the cursor or changes the foreground. A rejected PostMessage (UIPI / dead window) is
        /// reported instead of being counted as a delivered click.
        /// </summary>
        static InputResult ClickPosted(int x, int y, string button, int count, long expectedHwnd, uint callerPid)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            var top = new IntPtr(expectedHwnd);
            if (!Native.IsWindow(top))
            {
                result.errorCode = "window_not_found";
                result.errorMessage = "The bound window no longer exists; nothing was posted.";
                return result;
            }

            uint topPid;
            Native.GetWindowThreadProcessId(top, out topPid);
            if (callerPid != 0 && topPid != callerPid)
            {
                result.errorCode = "target_identity_changed";
                result.errorMessage = "The bound window now belongs to PID " + topPid + " instead of " + callerPid +
                    "; the binding is void and nothing was posted.";
                return result;
            }

            var target = DeepChildAt(top, x, y);
            uint targetPid;
            Native.GetWindowThreadProcessId(target, out targetPid);
            if (targetPid != topPid)
            {
                result.errorCode = "target_identity_changed";
                result.errorMessage = "The control under the point belongs to PID " + targetPid +
                    " but the bound window belongs to PID " + topPid + "; nothing was posted.";
                return result;
            }

            var client = new POINT { X = x, Y = y };
            if (!Native.ScreenToClient(target, ref client))
            {
                result.errorCode = "message_target_failed";
                result.errorMessage = "ScreenToClient failed for hwnd " + target.ToInt64() + ".";
                return result;
            }

            // lParam carries client-relative coordinates. ScreenToClient already gives that client
            // space for the target, and posted mouse messages are delivered in the target's own
            // client space (Windows applies the DPI virtualization during delivery), so no manual
            // DPI fold is applied — verified on a 150% display with a DPI-unaware target.
            int cx = client.X, cy = client.Y;
            IntPtr lp = (IntPtr)((cy << 16) | (cx & 0xFFFF));

            uint down, up, mk;
            switch (button)
            {
                case "right": down = Native.WM_RBUTTONDOWN; up = Native.WM_RBUTTONUP; mk = Native.MK_RBUTTON; break;
                case "middle": down = Native.WM_MBUTTONDOWN; up = Native.WM_MBUTTONUP; mk = Native.MK_MBUTTON; break;
                default: down = Native.WM_LBUTTONDOWN; up = Native.WM_LBUTTONUP; mk = Native.MK_LBUTTON; break;
            }

            // UIPI blocks posting to a higher-integrity window; PostMessage then returns false.
            // Report that as a refusal: a "dispatched" reply the app never received is the one
            // failure mode a screenshot loop cannot distinguish from a slow application.
            int dispatched = 0;
            if (!Native.PostMessage(target, Native.WM_MOUSEMOVE, IntPtr.Zero, lp))
            {
                result.errorCode = "message_post_rejected";
                result.errorMessage = "PostMessage to hwnd " + target.ToInt64() + " was rejected (Windows error " +
                    Marshal.GetLastWin32Error() + "). This usually means UIPI: the target runs at a higher integrity level. Nothing was clicked.";
                return result;
            }
            dispatched++;
            for (int i = 0; i < count; i++)
            {
                if (!Native.PostMessage(target, down, (IntPtr)mk, lp))
                {
                    result.errorCode = "message_post_rejected";
                    result.errorMessage = "PostMessage(button down) to hwnd " + target.ToInt64() + " was rejected (Windows error " +
                        Marshal.GetLastWin32Error() + "). Nothing was clicked.";
                    result.dispatchedEvents = dispatched;
                    return result;
                }
                dispatched++;
                Thread.Sleep(20);
                if (!Native.PostMessage(target, up, IntPtr.Zero, lp))
                {
                    // A posted button-down with no matching up leaves the target thinking the mouse
                    // is held. Retry the up once; if it still fails, report a distinct state error so
                    // the caller can stop using the message channel until the window is rebound.
                    Thread.Sleep(20);
                    if (!Native.PostMessage(target, up, IntPtr.Zero, lp))
                    {
                        result.errorCode = "message_button_stuck";
                        result.errorMessage = "PostMessage(button up) to hwnd " + target.ToInt64() + " was rejected twice (Windows error " +
                            Marshal.GetLastWin32Error() + "). The target may still consider the mouse button held.";
                        result.dispatchedEvents = dispatched;
                        result.notes.Add("posted_button_down_stuck");
                        return result;
                    }
                }
                dispatched++;
                if (i + 1 < count) Thread.Sleep(40);
            }

            result.ok = true;
            result.targetHwnd = target.ToInt64();
            result.dispatchedEvents = dispatched;
            result.notes.Add("posted_to_hwnd_" + target.ToInt64() + "_no_focus_change");
            result.notes.Add("verify_with_screenshot");
            CheckForeground(result, expectedHwnd);
            return result;
        }

        /// <summary>
        /// Deepest visible, enabled, non-transparent child of `top` that contains the screen point.
        /// ChildWindowFromPointEx works in client coordinates and ignores covering windows, which is
        /// exactly what a background click needs: the bound window's own control, wherever it is.
        /// </summary>
        static IntPtr DeepChildAt(IntPtr top, int screenX, int screenY)
        {
            var current = top;
            for (int depth = 0; depth < 16; depth++)
            {
                var p = new POINT { X = screenX, Y = screenY };
                if (!Native.ScreenToClient(current, ref p)) break;
                var child = Native.ChildWindowFromPointEx(current, p,
                    Native.CWP_SKIPINVISIBLE | Native.CWP_SKIPDISABLED | Native.CWP_SKIPTRANSPARENT);
                if (child == IntPtr.Zero || child == current) break;
                current = child;
            }
            return current;
        }

        public static InputResult Move(int x, int y, long expectedHwnd)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            if (!Native.SetCursorPos(x, y))
            {
                result.errorCode = "cursor_move_failed";
                result.errorMessage = "SetCursorPos rejected the coordinates.";
                return result;
            }
            result.ok = true;
            CheckForeground(result, expectedHwnd);
            return result;
        }

        public static InputResult Scroll(int x, int y, string direction, int amount, long expectedHwnd)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            try
            {
                Native.SetCursorPos(x, y);
                Thread.Sleep(10);
                int ticks = Math.Max(0, amount);
                if (ticks == 0)
                {
                    // A zero amount means "scroll nothing"; do not quietly send one notch.
                    result.ok = true;
                    result.dispatchedEvents = 0;
                    CheckForeground(result, expectedHwnd);
                    return result;
                }
                var inputs = new List<INPUT>();
                for (int i = 0; i < ticks; i++)
                {
                    var inp = new INPUT(); inp.type = 0;
                    switch (direction)
                    {
                        case "up": inp.u.mi.dwFlags = Native.MOUSEEVENTF_WHEEL; inp.u.mi.mouseData = 120; break;
                        case "down": inp.u.mi.dwFlags = Native.MOUSEEVENTF_WHEEL; inp.u.mi.mouseData = unchecked((uint)-120); break;
                        case "left": inp.u.mi.dwFlags = Native.MOUSEEVENTF_HWHEEL; inp.u.mi.mouseData = unchecked((uint)-120); break;
                        case "right": inp.u.mi.dwFlags = Native.MOUSEEVENTF_HWHEEL; inp.u.mi.mouseData = 120; break;
                        default: result.errorCode = "bad_direction"; result.errorMessage = "Unknown scroll direction: " + direction; return result;
                    }
                    inputs.Add(inp);
                }
                int sent = SendInputs(inputs.ToArray());
                result.ok = sent == inputs.Count;
                result.dispatchedEvents = sent;
                if (!result.ok) { result.errorCode = "input_rejected"; result.errorMessage = "Scroll events were not fully delivered."; }
                CheckForeground(result, expectedHwnd);
                return result;
            }
            catch (Exception ex)
            {
                result.errorCode = "input_exception";
                result.errorMessage = ex.Message;
                return result;
            }
        }

        public static InputResult Drag(int fromX, int fromY, int toX, int toY, string button, int steps, long expectedHwnd)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            lock (Sync)
            {
                try
                {
                    Native.SetCursorPos(fromX, fromY);
                    Thread.Sleep(15);
                    uint downFlag = button == "right" ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_LEFTDOWN;
                    uint upFlag = button == "right" ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP;
                    var down = new INPUT(); down.type = 0; down.u.mi.dwFlags = downFlag;
                    if (SendInputs(new[] { down }) != 1) { result.errorCode = "input_rejected"; result.errorMessage = "Could not press the button."; return result; }
                    _leftDown = button == "left";
                    try
                    {
                        int n = Math.Max(2, steps);
                        for (int i = 1; i <= n; i++)
                        {
                            int x = fromX + (toX - fromX) * i / n;
                            int y = fromY + (toY - fromY) * i / n;
                            Native.SetCursorPos(x, y);
                            Thread.Sleep(8);
                        }
                    }
                    finally
                    {
                        var up = new INPUT(); up.type = 0; up.u.mi.dwFlags = upFlag;
                        SendInputs(new[] { up });
                        _leftDown = false;
                    }
                    result.ok = true;
                    result.dispatchedEvents = 2 + steps;
                    CheckForeground(result, expectedHwnd);
                    return result;
                }
                catch (Exception ex)
                {
                    result.errorCode = "input_exception";
                    result.errorMessage = ex.Message;
                    return result;
                }
            }
        }

        public static InputResult MouseButton(string button, bool down, long expectedHwnd)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            uint flag;
            if (button == "right") flag = down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP;
            else if (button == "middle") flag = down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP;
            else flag = down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP;
            var inp = new INPUT(); inp.type = 0; inp.u.mi.dwFlags = flag;
            int sent = SendInputs(new[] { inp });
            result.ok = sent == 1;
            result.dispatchedEvents = sent;
            if (button == "left") _leftDown = down;
            if (button == "right") _rightDown = down;
            if (button == "middle") _middleDown = down;
            if (!result.ok) { result.errorCode = "input_rejected"; result.errorMessage = "Mouse event was not delivered."; }
            CheckForeground(result, expectedHwnd);
            return result;
        }

        /// Types text as Unicode key events. Returns the number of INPUT events sent.
        public static InputResult TypeText(string text, long expectedHwnd)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            if (string.IsNullOrEmpty(text)) { result.ok = true; return result; }
            lock (Sync)
            {
                try
                {
                    var buffer = new List<INPUT>(Math.Min(text.Length * 2, 4096));
                    int total = 0;
                    int charsSent = 0;
                    int escBaseline = EscWatch.Count;
                    foreach (char ch in text)
                    {
                        // Win32 edit controls insert a line break on CR, not LF. Models write "\n",
                        // so normalise; sending LF alone produces no visible newline in most apps.
                        char outCh = ch == '\n' ? '\r' : ch;
                        var d = new INPUT(); d.type = 1; d.u.ki.wScan = outCh; d.u.ki.dwFlags = Native.KEYEVENTF_UNICODE;
                        var u = new INPUT(); u.type = 1; u.u.ki.wScan = outCh; u.u.ki.dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP;
                        buffer.Add(d); buffer.Add(u);
                        charsSent++;
                        if (buffer.Count >= 512)
                        {
                            int s = SendInputs(buffer.ToArray());
                            total += s;
                            if (s != buffer.Count)
                            {
                                result.errorCode = "input_rejected";
                                result.errorMessage = "Text input was partially rejected after " + charsSent + " of " + text.Length + " characters (" + total + " events accepted). Some text may already be in the field.";
                                return result;
                            }
                            buffer.Clear();
                            Thread.Sleep(2);
                            // A human pressing Escape stops long typing at the next chunk boundary;
                            // characters already delivered stay in the field, so the message says where.
                            if (EscWatch.Count != escBaseline)
                            {
                                result.ok = false;
                                result.errorCode = "user_aborted";
                                result.errorMessage = "Escape was pressed; typing stopped after " + charsSent + " of " + text.Length + " characters (" + total + " events delivered).";
                                return result;
                            }
                        }
                    }
                    if (buffer.Count > 0)
                    {
                        int s = SendInputs(buffer.ToArray());
                        total += s;
                        if (s != buffer.Count)
                        {
                            result.errorCode = "input_rejected";
                            result.errorMessage = "Text input was partially rejected after " + charsSent + " of " + text.Length + " characters (" + total + " events accepted). Some text may already be in the field.";
                            return result;
                        }
                    }
                    result.ok = true;
                    result.dispatchedEvents = total;
                    CheckForeground(result, expectedHwnd);
                    return result;
                }
                catch (Exception ex)
                {
                    result.errorCode = "input_exception";
                    result.errorMessage = ex.Message;
                    return result;
                }
            }
        }

        public static InputResult Key(string chord, int repeat, long expectedHwnd, bool hold, int holdMs)
        {
            var result = new InputResult { targetHwnd = expectedHwnd };
            var parts = chord.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) { result.errorCode = "bad_chord"; result.errorMessage = "Empty key chord."; return result; }
            var vks = new List<ushort>();
            foreach (var p in parts)
            {
                var name = p.Trim();
                if (name.Length == 0) continue;
                ushort vk = ResolveKey(name);
                if (vk == 0) { result.errorCode = "unknown_key"; result.errorMessage = "Unknown key name: " + name; return result; }
                vks.Add(vk);
            }
            if (vks.Count == 0) { result.errorCode = "bad_chord"; result.errorMessage = "Empty key chord."; return result; }

            lock (Sync)
            {
                try
                {
                    if (hold)
                    {
                        var downs = new List<INPUT>();
                        for (int i = 0; i < vks.Count; i++) downs.Add(KeyInput(vks[i], false));
                        int s1 = SendInputs(downs.ToArray());
                        if (s1 != downs.Count) { result.errorCode = "input_rejected"; result.errorMessage = "Key down was rejected."; return result; }
                        for (int i = 0; i < vks.Count; i++) HeldVks.Add(vks[i]);
                        int escBaseline = EscWatch.Count;
                        bool aborted = false;
                        int remaining = Math.Max(0, holdMs);
                        while (remaining > 0)
                        {
                            int slice = Math.Min(100, remaining);
                            Thread.Sleep(slice);
                            remaining -= slice;
                            if (EscWatch.Count != escBaseline) { aborted = true; break; }
                        }
                        var ups = new List<INPUT>();
                        for (int i = vks.Count - 1; i >= 0; i--) ups.Add(KeyInput(vks[i], true));
                        int s2 = SendInputs(ups.ToArray());
                        for (int i = 0; i < vks.Count; i++) HeldVks.Remove(vks[i]);
                        result.dispatchedEvents = s1 + s2;
                        if (aborted)
                        {
                            // Release first: a human aborting must never leave a key held down.
                            result.ok = false;
                            result.errorCode = "user_aborted";
                            result.errorMessage = "Escape was pressed; the key hold was released early.";
                            return result;
                        }
                        if (s2 != ups.Count) { result.errorCode = "input_rejected"; result.errorMessage = "Key up was not delivered; keys may still be held."; return result; }
                        result.ok = true;
                        CheckForeground(result, expectedHwnd);
                        return result;
                    }

                    // Repeats are sent one chord at a time: a single 200-event burst makes many apps
                    // drop or coalesce keystrokes.
                    int times = Math.Max(1, repeat);
                    int total = 0;
                    for (int t = 0; t < times; t++)
                    {
                        var one = new List<INPUT>();
                        for (int i = 0; i < vks.Count; i++) one.Add(KeyInput(vks[i], false));
                        for (int i = vks.Count - 1; i >= 0; i--) one.Add(KeyInput(vks[i], true));
                        for (int i = 0; i < vks.Count; i++) HeldVks.Add(vks[i]);
                        int sentOne = SendInputs(one.ToArray());
                        for (int i = 0; i < vks.Count; i++) HeldVks.Remove(vks[i]);
                        total += sentOne;
                        if (sentOne != one.Count)
                        {
                            result.dispatchedEvents = total;
                            result.errorCode = "input_rejected";
                            result.errorMessage = "Key events were partially rejected after " + t + " of " + times + " repeats.";
                            return result;
                        }
                        if (t + 1 < times) Thread.Sleep(20);
                    }
                    result.dispatchedEvents = total;
                    result.ok = true;
                    CheckForeground(result, expectedHwnd);
                    return result;
                }
                catch (Exception ex)
                {
                    result.errorCode = "input_exception";
                    result.errorMessage = ex.Message;
                    return result;
                }
            }
        }

        /// Releases anything this engine still believes is held. Safe to call repeatedly.
        /// <summary>
        /// Unconditionally release every mouse button and modifier key this process could possibly
        /// have left down. Safe to call from a *different* process (which is the point: it is used
        /// as a crash-recovery sweep, where the owning process may already be gone).
        /// </summary>
        public static int ForceIdle()
        {
            lock (Sync)
            {
                var ups = new List<INPUT>();
                var l = new INPUT(); l.type = 0; l.u.mi.dwFlags = Native.MOUSEEVENTF_LEFTUP; ups.Add(l);
                var r = new INPUT(); r.type = 0; r.u.mi.dwFlags = Native.MOUSEEVENTF_RIGHTUP; ups.Add(r);
                var m = new INPUT(); m.type = 0; m.u.mi.dwFlags = Native.MOUSEEVENTF_MIDDLEUP; ups.Add(m);
                ushort[] modifiers = { 0x10, 0x11, 0x12, 0x5B, 0x5C }; // shift, ctrl, alt, lwin, rwin
                foreach (var vk in modifiers) ups.Add(KeyInput(vk, true));
                SendInputs(ups.ToArray());
                _leftDown = _rightDown = _middleDown = false;
                HeldVks.Clear();
                return ups.Count;
            }
        }

        public static int ReleaseAll()
        {
            int released = 0;
            lock (Sync)
            {
                var ups = new List<INPUT>();
                if (_leftDown) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = Native.MOUSEEVENTF_LEFTUP; ups.Add(i); released++; }
                if (_rightDown) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = Native.MOUSEEVENTF_RIGHTUP; ups.Add(i); released++; }
                if (_middleDown) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = Native.MOUSEEVENTF_MIDDLEUP; ups.Add(i); released++; }
                foreach (var vk in HeldVks)
                {
                    var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)Native.MapVirtualKeyW(vk, 0);
                    i.u.ki.dwFlags = Native.KEYEVENTF_KEYUP; ups.Add(i); released++;
                }
                if (ups.Count > 0) SendInputs(ups.ToArray());
                _leftDown = _rightDown = _middleDown = false;
                HeldVks.Clear();
            }
            return released;
        }

        static void ReleaseAllQuiet() { try { ReleaseAll(); } catch { } }

        #endregion

        #region Clipboard

        [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
        [DllImport("user32.dll", SetLastError = true)] static extern bool CloseClipboard();
        [DllImport("user32.dll", SetLastError = true)] static extern bool EmptyClipboard();
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetClipboardData(uint format);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetClipboardData(uint format, IntPtr data);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr mem);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr mem);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr mem);

        const uint CF_UNICODETEXT = 13;
        const uint GMEM_MOVEABLE = 0x0002;

        public static string ReadClipboard()
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                if (!OpenClipboard(IntPtr.Zero)) { Thread.Sleep(30); continue; }
                try
                {
                    var h = GetClipboardData(CF_UNICODETEXT);
                    if (h == IntPtr.Zero) return "";
                    var p = GlobalLock(h);
                    if (p == IntPtr.Zero) return "";
                    try { return Marshal.PtrToStringUni(p) ?? ""; }
                    finally { GlobalUnlock(h); }
                }
                finally { CloseClipboard(); }
            }
            throw new InvalidOperationException("Clipboard is busy (OpenClipboard failed 10 times).");
        }

        public static bool WriteClipboard(string text)
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                if (!OpenClipboard(IntPtr.Zero)) { Thread.Sleep(30); continue; }
                try
                {
                    EmptyClipboard();
                    int bytes = (text.Length + 1) * 2;
                    var hMem = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes);
                    if (hMem == IntPtr.Zero) return false;
                    var target = GlobalLock(hMem);
                    if (target == IntPtr.Zero) { GlobalFree(hMem); return false; }
                    try { Marshal.Copy(text.ToCharArray(), 0, target, text.Length); Marshal.WriteInt16(target, text.Length * 2, 0); }
                    finally { GlobalUnlock(hMem); }
                    if (SetClipboardData(CF_UNICODETEXT, hMem) == IntPtr.Zero) { GlobalFree(hMem); return false; }
                    return true;
                }
                finally { CloseClipboard(); }
            }
            return false;
        }

        #endregion
    }
}

