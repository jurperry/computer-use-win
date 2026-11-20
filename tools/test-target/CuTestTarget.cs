// Computer Use test target - a deliberately instrumented WinForms app.
//
// Every input event is appended to a log file as one JSON-ish line, which gives e2e tests ground
// truth that does not depend on reading pixels back. The app also publishes its window handle and
// control rectangles so the test can compute exact click coordinates.
//
// Deliberately compiled with the .NET Framework C# 5 compiler (Add-Type), so: no string
// interpolation, no expression-bodied members.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CuTestTarget
{
    static class Utf8
    {
        // No BOM: the harness parses these files as plain JSON.
        public static readonly Encoding NoBom = new UTF8Encoding(false);
    }

    static class Program
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [STAThread]
        static void Main(string[] args)
        {
            string logPath = null, infoPath = null;
            bool topmost = true;
            int autoExitSeconds = 0;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--log" && i + 1 < args.Length) logPath = args[++i];
                else if (args[i] == "--info" && i + 1 < args.Length) infoPath = args[++i];
                else if (args[i] == "--no-topmost") topmost = false;
                else if (args[i] == "--auto-exit" && i + 1 < args.Length) int.TryParse(args[++i], out autoExitSeconds);
            }
            // Per-monitor-V2 so the test target's own pixels are physical pixels. This removes DPI
            // virtualization from the equation and lets tests assert exact coordinates.
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TargetForm(logPath, infoPath, topmost, autoExitSeconds));
        }
    }

    public class TargetForm : Form
    {
        readonly string _logPath;
        readonly string _infoPath;
        readonly object _logLock = new object();
        readonly TextBox _input;
        readonly Button _button;
        readonly Label _clicks;
        readonly Label _status;
        readonly DragPanel _pad;
        System.Threading.Timer _autoExit;
        int _clickCount;
        readonly int _autoExitSeconds;

        public TargetForm(string logPath, string infoPath, bool topmost, int autoExitSeconds)
        {
            _logPath = logPath;
            _infoPath = infoPath;
            _autoExitSeconds = autoExitSeconds;
            Text = "CU Test Target";
            ClientSize = new Size(880, 600);
            StartPosition = FormStartPosition.Manual;
            Location = new Point(160, 160);
            BackColor = Color.FromArgb(30, 34, 42);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 12);
            TopMost = topmost;
            KeyPreview = true;

            var title = new Label();
            title.Text = "CU TEST TARGET";
            title.AutoSize = true;
            title.Location = new Point(24, 16);
            title.Font = new Font("Segoe UI", 20, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(120, 220, 160);
            Controls.Add(title);

            _input = new TextBox();
            _input.Name = "inputBox";
            _input.Location = new Point(24, 60);
            _input.Size = new Size(820, 36);
            _input.Font = new Font("Consolas", 15);
            _input.BackColor = Color.FromArgb(16, 18, 24);
            _input.ForeColor = Color.FromArgb(140, 200, 255);
            Controls.Add(_input);

            _button = new Button();
            _button.Name = "clickMe";
            _button.Text = "CLICK ME";
            _button.Location = new Point(24, 116);
            _button.Size = new Size(240, 64);
            _button.Font = new Font("Segoe UI", 14, FontStyle.Bold);
            _button.Click += delegate { _clickCount++; _clicks.Text = "clicks: " + _clickCount; Log("click", "count=" + _clickCount); };
            Controls.Add(_button);

            _clicks = new Label();
            _clicks.Text = "clicks: 0";
            _clicks.AutoSize = true;
            _clicks.Location = new Point(288, 136);
            _clicks.Font = new Font("Consolas", 16);
            _clicks.ForeColor = Color.FromArgb(255, 210, 90);
            Controls.Add(_clicks);

            _pad = new DragPanel();
            _pad.Location = new Point(24, 200);
            _pad.Size = new Size(420, 240);
            _pad.OnEvent = Log;
            Controls.Add(_pad);

            _status = new Label();
            _status.Text = "status: ready";
            _status.AutoSize = true;
            _status.Location = new Point(470, 220);
            _status.Font = new Font("Consolas", 12);
            _status.ForeColor = Color.FromArgb(200, 200, 210);
            Controls.Add(_status);

            _input.TextChanged += delegate { _status.Text = "text: " + _input.Text; Log("textchanged", "text=" + _input.Text); };
            MouseDown += delegate(object s, MouseEventArgs e) { Log("form-mousedown", "x=" + e.X + " y=" + e.Y + " button=" + e.Button); };
            MouseWheel += delegate(object s, MouseEventArgs e) { Log("form-wheel", "delta=" + e.Delta); };
            KeyDown += delegate(object s, KeyEventArgs e) { Log("form-keydown", "key=" + e.KeyCode + " mods=" + e.Modifiers); };

            if (autoExitSeconds > 0)
            {
                // An elevated target cannot be killed by the unelevated test harness, so it must
                // exit on its own. Use a thread-pool timer (rooted while active) and marshal the
                // close onto the UI thread: a WinForms Timer created in a local was not reliable
                // enough — an elevated instance kept running past its deadline.
                var form = this;
                _autoExit = new System.Threading.Timer(delegate
                {
                    try { form.BeginInvoke(new Action(delegate { try { form.Close(); } catch { } })); } catch { }
                }, null, autoExitSeconds * 1000, System.Threading.Timeout.Infinite);
            }

            Shown += delegate
            {
                WriteInfo();
                _input.Focus();
                Log("ready", "hwnd=" + Handle.ToInt64() + " auto-exit=" + _autoExitSeconds);
            };
        }

        void Log(string kind, string detail)
        {
            if (string.IsNullOrEmpty(_logPath)) return;
            string line = string.Format(CultureInfo.InvariantCulture,
                "{{\"t\":{0},\"kind\":\"{1}\",{2}}}",
                (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds,
                kind,
                string.IsNullOrEmpty(detail) ? "\"detail\":\"\"" : "\"" + "detail" + "\":\"" + detail.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n") + "\"");
            lock (_logLock)
            {
                try { File.AppendAllText(_logPath, line + "\n", Utf8.NoBom); }
                catch { }
            }
        }

        void WriteInfo()
        {
            if (string.IsNullOrEmpty(_infoPath)) return;
            var b = _button.RectangleToScreen(_button.ClientRectangle);
            var input = _input.RectangleToScreen(_input.ClientRectangle);
            var pad = _pad.RectangleToScreen(_pad.ClientRectangle);
            var form = RectangleToScreen(ClientRectangle);
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"hwnd\":{0},", Handle.ToInt64());
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"pid\":{0},", System.Diagnostics.Process.GetCurrentProcess().Id);
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"client\":{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3}}},", form.X, form.Y, form.Width, form.Height);
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"button\":{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3}}},", b.X, b.Y, b.Width, b.Height);
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"input\":{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3}}},", input.X, input.Y, input.Width, input.Height);
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"pad\":{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3}}}", pad.X, pad.Y, pad.Width, pad.Height);
            sb.Append("}");
            try { File.WriteAllText(_infoPath, sb.ToString(), Utf8.NoBom); }
            catch { }
        }
    }

    /// <summary>Drag / scroll playground that logs what the mouse actually did.</summary>
    public class DragPanel : Panel
    {
        public Action<string, string> OnEvent;
        Point _down;
        Point _current;
        bool _dragging;

        public DragPanel()
        {
            DoubleBuffered = true;
            BackColor = Color.FromArgb(22, 26, 32);
            BorderStyle = BorderStyle.FixedSingle;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            _down = e.Location;
            _current = e.Location;
            _dragging = true;
            if (OnEvent != null) OnEvent("pad-mousedown", "x=" + e.X + " y=" + e.Y + " button=" + e.Button);
            Invalidate();
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (_dragging)
            {
                _current = e.Location;
                Invalidate();
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            _dragging = false;
            if (OnEvent != null) OnEvent("pad-mouseup", "x=" + e.X + " y=" + e.Y + " from=" + _down.X + "," + _down.Y);
            Invalidate();
            base.OnMouseUp(e);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            if (OnEvent != null) OnEvent("pad-wheel", "delta=" + e.Delta);
            base.OnMouseWheel(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (var pen = new Pen(Color.FromArgb(90, 90, 110)))
            {
                e.Graphics.DrawString("drag / scroll area", new Font("Consolas", 10), new SolidBrush(Color.FromArgb(120, 130, 150)), 8, 8);
            }
            if (_down != Point.Empty)
            {
                using (var pen = new Pen(Color.FromArgb(120, 220, 160), 2))
                {
                    e.Graphics.DrawLine(pen, _down, _current);
                    e.Graphics.DrawRectangle(pen, _down.X - 3, _down.Y - 3, 6, 6);
                }
            }
        }
    }
}


