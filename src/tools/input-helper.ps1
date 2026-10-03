# Persistent input + UI Automation helper: reads one JSON command per line on stdin and replies with one line:
# "ok", "ok <json>" or "err: ...". Output is pure ASCII (non-ASCII is \u-escaped), input JSON is \u-escaped by the caller.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms
$refs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location,
  [System.Windows.Rect].Assembly.Location
)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;

public static class In {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i;
  }
  // Unicode typing in one SendInput batch per chunk; newlines become Enter.
  public static void TypeText(string s) {
    List<INPUT> a = new List<INPUT>();
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { a.Add(Key(0x0D, 0, 0)); a.Add(Key(0x0D, 0, 2)); }
      else { a.Add(Key(0, c, 4)); a.Add(Key(0, c, 4 | 2)); }
      if (a.Count >= 64) { SendInput((uint)a.Count, a.ToArray(), Marshal.SizeOf(typeof(INPUT))); a.Clear(); System.Threading.Thread.Sleep(8); }
    }
    if (a.Count > 0) SendInput((uint)a.Count, a.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
}

public static class Ui {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int L, T, R, B; }

  public static string J(string s) {
    if (s == null) return "\"\"";
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c == '\n') b.Append("\\n");
      else if (c == '\t') b.Append("\\t");
      else if (c < 0x20) b.Append(' ');
      else if (c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static string Clip(string s, int n) { if (s == null) return ""; s = s.Trim(); return s.Length > n ? s.Substring(0, n) + "..." : s; }
  static string Title(IntPtr h) { int n = GetWindowTextLength(h); if (n <= 0) return ""; StringBuilder s = new StringBuilder(n + 1); GetWindowText(h, s, n + 1); return s.ToString(); }
  static Dictionary<uint, string> procs = new Dictionary<uint, string>();
  static string Proc(uint pid) {
    string n; if (procs.TryGetValue(pid, out n)) return n;
    try { n = Process.GetProcessById((int)pid).ProcessName.ToLower(); } catch { n = ""; }
    procs[pid] = n; return n;
  }
  static string Win(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid); RECT r; GetWindowRect(h, out r);
    return "{\"hwnd\":" + h.ToInt64() + ",\"title\":" + J(Title(h)) + ",\"proc\":" + J(Proc(pid)) + ",\"pid\":" + pid +
      ",\"min\":" + (IsIconic(h) ? "true" : "false") + ",\"max\":" + (IsZoomed(h) ? "true" : "false") +
      ",\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}";
  }

  public static string Foreground() { return Win(GetForegroundWindow()); }

  // Real, user-facing top-level windows in z-order (topmost first).
  public static string Windows(long skipPid) {
    StringBuilder sb = new StringBuilder("[");
    bool first = true;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // tool window
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      if (GetWindowTextLength(h) == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == skipPid) return true;
      if (!first) sb.Append(','); first = false;
      sb.Append(Win(h));
      return true;
    }, IntPtr.Zero);
    return sb.Append(']').ToString();
  }

  public static string Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow(); uint pid;
    uint ft = GetWindowThreadProcessId(fg, out pid); uint me = GetCurrentThreadId();
    if (ft != me) AttachThreadInput(me, ft, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (ft != me) AttachThreadInput(me, ft, false);
    System.Threading.Thread.Sleep(60);
    return GetForegroundWindow() == h ? "true" : "false";
  }

  // ---- UI Automation: interactive elements of a window, with ids for element actions ----
  static List<AutomationElement> last = new List<AutomationElement>();
  static readonly Dictionary<int, string> Kinds = new Dictionary<int, string>();
  static Ui() {
    Kinds[ControlType.Button.Id] = "button"; Kinds[ControlType.Edit.Id] = "edit"; Kinds[ControlType.Hyperlink.Id] = "link";
    Kinds[ControlType.MenuItem.Id] = "menuitem"; Kinds[ControlType.ListItem.Id] = "listitem"; Kinds[ControlType.TabItem.Id] = "tab";
    Kinds[ControlType.CheckBox.Id] = "checkbox"; Kinds[ControlType.RadioButton.Id] = "radio"; Kinds[ControlType.ComboBox.Id] = "combobox";
    Kinds[ControlType.TreeItem.Id] = "treeitem"; Kinds[ControlType.DataItem.Id] = "item"; Kinds[ControlType.SplitButton.Id] = "splitbutton";
    Kinds[ControlType.Slider.Id] = "slider"; Kinds[ControlType.Spinner.Id] = "spinner"; Kinds[ControlType.Document.Id] = "document";
    Kinds[ControlType.Menu.Id] = "menu"; Kinds[ControlType.HeaderItem.Id] = "header";
  }
  static CacheRequest Req() {
    CacheRequest cr = new CacheRequest();
    cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.BoundingRectangleProperty); cr.Add(AutomationElement.IsOffscreenProperty);
    cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.HasKeyboardFocusProperty);
    cr.Add(ValuePattern.ValueProperty); cr.Add(TogglePattern.ToggleStateProperty);
    cr.TreeScope = TreeScope.Element;
    return cr;
  }
  static object P(AutomationElement e, AutomationProperty p) { try { return e.GetCachedPropertyValue(p, true); } catch { return null; } }

  public static string Elements(long hwnd, int max, int ms, int sx, int sy, int sw, int sh) {
    IntPtr h = hwnd == 0 ? GetForegroundWindow() : new IntPtr(hwnd);
    last.Clear();
    AutomationElement root;
    try { root = AutomationElement.FromHandle(h); }
    catch { throw new Exception("this window does not expose its controls (it may run as administrator); use screenshot and coordinates"); }
    CacheRequest cr = Req();
    TreeWalker walker = TreeWalker.ControlViewWalker;
    StringBuilder sb = new StringBuilder();
    Stopwatch clock = Stopwatch.StartNew();
    int visited = 0; bool cut = false;
    Stack<AutomationElement> stack = new Stack<AutomationElement>();
    Stack<int> depth = new Stack<int>();
    stack.Push(root); depth.Push(0);
    bool firstEl = true;
    while (stack.Count > 0) {
      AutomationElement el = stack.Pop(); int d = depth.Pop();
      if (clock.ElapsedMilliseconds > ms || last.Count >= max || visited > 12000) { cut = true; break; }
      // children in document order
      List<AutomationElement> kids = new List<AutomationElement>();
      try {
        AutomationElement c = walker.GetFirstChild(el, cr);
        while (c != null && kids.Count < 400) { kids.Add(c); c = walker.GetNextSibling(c, cr); }
      } catch { }
      for (int i = kids.Count - 1; i >= 0; i--) {
        AutomationElement c = kids[i];
        visited++;
        object ro = P(c, AutomationElement.BoundingRectangleProperty);
        Rect r = ro is Rect ? (Rect)ro : Rect.Empty;
        bool empty = r.IsEmpty || r.Width < 2 || r.Height < 2;
        object off = P(c, AutomationElement.IsOffscreenProperty);
        bool offscreen = off is bool && (bool)off;
        if (offscreen && empty) continue; // collapsed subtree
        object kct = P(c, AutomationElement.ControlTypeProperty);
        if (kct is ControlType && ((ControlType)kct).Id == ControlType.ScrollBar.Id) continue; // scrollbar parts are noise
        if (d < 60) { stack.Push(c); depth.Push(d + 1); }
      }
      if (el == root) continue;
      object ro2 = P(el, AutomationElement.BoundingRectangleProperty);
      Rect rr = ro2 is Rect ? (Rect)ro2 : Rect.Empty;
      if (rr.IsEmpty || rr.Width < 2 || rr.Height < 2) continue;
      object off2 = P(el, AutomationElement.IsOffscreenProperty);
      if (off2 is bool && (bool)off2) continue;
      double cx = rr.X + rr.Width / 2, cy = rr.Y + rr.Height / 2;
      if (cx < sx || cy < sy || cx > sx + sw || cy > sy + sh) continue; // not on the captured screen
      object cto = P(el, AutomationElement.ControlTypeProperty);
      if (!(cto is ControlType)) continue;
      string kind; if (!Kinds.TryGetValue(((ControlType)cto).Id, out kind)) continue;
      string name = P(el, AutomationElement.NameProperty) as string;
      string val = P(el, ValuePattern.ValueProperty) as string;
      if (kind == "document" && string.IsNullOrEmpty(name)) continue;
      if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(val) && kind != "edit" && kind != "combobox") continue;
      object en = P(el, AutomationElement.IsEnabledProperty);
      object fo = P(el, AutomationElement.HasKeyboardFocusProperty);
      object tg = P(el, TogglePattern.ToggleStateProperty);
      int id = last.Count; last.Add(el);
      if (!firstEl) sb.Append(','); firstEl = false;
      sb.Append("{\"id\":").Append(id).Append(",\"t\":").Append(J(kind)).Append(",\"n\":").Append(J(Clip(name, 90)));
      if (!string.IsNullOrEmpty(val) && val != name) sb.Append(",\"v\":").Append(J(Clip(val, 90)));
      if (en is bool && !(bool)en) sb.Append(",\"off\":true");
      if (fo is bool && (bool)fo) sb.Append(",\"focus\":true");
      if (tg is ToggleState) sb.Append(",\"on\":").Append((ToggleState)tg == ToggleState.On ? "true" : "false");
      sb.Append(",\"x\":").Append((int)cx).Append(",\"y\":").Append((int)cy).Append(",\"w\":").Append((int)rr.Width).Append(",\"h\":").Append((int)rr.Height).Append('}');
    }
    return "{\"window\":" + Win(h) + ",\"cut\":" + (cut ? "true" : "false") + ",\"ms\":" + clock.ElapsedMilliseconds + ",\"items\":[" + sb.ToString() + "]}";
  }

  static AutomationElement Get(int id) {
    if (id < 0 || id >= last.Count) throw new Exception("no element " + id + "; call elements again");
    return last[id];
  }
  // Live position of a listed element (it may have moved or scrolled since it was listed).
  public static string ElRect(int id) {
    Rect r;
    try { r = Get(id).Current.BoundingRectangle; } catch (ElementNotAvailableException) { throw new Exception("element " + id + " is gone; call elements again"); }
    if (r.IsEmpty) throw new Exception("element " + id + " is not on screen; scroll or call elements again");
    return "{\"x\":" + (int)(r.X + r.Width / 2) + ",\"y\":" + (int)(r.Y + r.Height / 2) + ",\"w\":" + (int)r.Width + ",\"h\":" + (int)r.Height + "}";
  }
  public static string SetValue(int id, string text) {
    AutomationElement e = Get(id);
    object p;
    if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return "nopattern";
    ValuePattern vp = (ValuePattern)p;
    if (vp.Current.IsReadOnly) return "readonly";
    try { e.SetFocus(); } catch { }
    vp.SetValue(text);
    return "set";
  }

  // Text of an element (id >= 0) or a whole window: document text via TextPattern, else value, else name.
  public static string Text(long hwnd, int id, int max) {
    AutomationElement e;
    if (id >= 0) e = Get(id);
    else {
      try { e = AutomationElement.FromHandle(hwnd == 0 ? GetForegroundWindow() : new IntPtr(hwnd)); }
      catch { throw new Exception("this window does not expose its text; use screenshot/zoom"); }
    }
    object p;
    AutomationElement d = e;
    if (!e.TryGetCurrentPattern(TextPattern.Pattern, out p)) {
      d = e.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsTextPatternAvailableProperty, true));
      p = null;
      if (d != null) d.TryGetCurrentPattern(TextPattern.Pattern, out p);
    }
    if (p != null) return J(((TextPattern)p).DocumentRange.GetText(max));
    if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return J(((ValuePattern)p).Current.Value);
    return J(e.Current.Name);
  }

  // Address bar of a browser window: the URL of the active tab.
  public static string BrowserUrl(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    AutomationElement root;
    try { root = AutomationElement.FromHandle(h); } catch { return "{\"url\":\"\",\"title\":" + J(Title(h)) + "}"; }
    Condition edit = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
    string[] names = { "Address and search bar", "Search or enter address", "Search with Google or enter address", "Search or enter web address", "Address field", "Address bar" };
    AutomationElement bar = null;
    bar = root.FindFirst(TreeScope.Descendants, new AndCondition(edit, new PropertyCondition(AutomationElement.AutomationIdProperty, "urlbar-input")));
    foreach (string n in names) {
      if (bar != null) break;
      bar = root.FindFirst(TreeScope.Descendants, new AndCondition(edit, new PropertyCondition(AutomationElement.NameProperty, n)));
    }
    if (bar == null) bar = root.FindFirst(TreeScope.Descendants, edit);
    string url = "";
    if (bar != null) {
      object p;
      if (bar.TryGetCurrentPattern(ValuePattern.Pattern, out p)) url = ((ValuePattern)p).Current.Value;
    }
    return "{\"url\":" + J(url) + ",\"title\":" + J(Title(h)) + "}";
  }
}
'@
[void][In]::SetProcessDPIAware()

$vk = @{ ctrl=0x11; control=0x11; shift=0x10; alt=0x12; win=0x5B; meta=0x5B; super=0x5B; cmd=0x5B; enter=0x0D; return=0x0D; tab=0x09;
  escape=0x1B; esc=0x1B; backspace=0x08; delete=0x2E; del=0x2E; space=0x20; up=0x26; down=0x28; left=0x25; right=0x27;
  arrowup=0x26; arrowdown=0x28; arrowleft=0x25; arrowright=0x27; home=0x24; end=0x23; pageup=0x21; pagedown=0x22; pgup=0x21; pgdn=0x22;
  insert=0x2D; printscreen=0x2C; capslock=0x14; menu=0x5D; apps=0x5D; plus=0xBB; minus=0xBD }
1..12 | ForEach-Object { $vk["f$_"] = 0x6F + $_ }
$ext = @(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x5B,0x5D) # extended keys

function Get-Vk([string]$k) {
  $l = $k.Trim().ToLower()
  if ($vk.ContainsKey($l)) { return [byte]$vk[$l] }
  if ($k.Length -eq 1) { return [byte]([In]::VkKeyScan($k[0]) -band 0xFF) }
  throw "unknown key '$k'"
}

function Click([int]$x, [int]$y, [string]$button, [int]$count) {
  [void][In]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 30
  $down = 0x0002; $up = 0x0004
  if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 } elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
  for ($i = 0; $i -lt $count; $i++) {
    [In]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [In]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 45
  }
}

# Fencing (plan ch. 06): input only runs under the current screen-lease epoch. 'arm' sets it, 'disarm' revokes it,
# and any input op carrying an older (or no) epoch is rejected before it touches the mouse or keyboard.
$script:epoch = -1
$inputOps = @('move','click','drag','scroll','type','key','focus','setvalue','launch')

while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $c = $line | ConvertFrom-Json
    $out = $null
    if ($inputOps -contains $c.op) {
      if ($script:epoch -lt 0) { throw "no screen lease (input revoked)" }
      if ($c.epoch -eq $null -or [long]$c.epoch -ne $script:epoch) { throw "stale screen lease epoch $($c.epoch) (current $script:epoch)" }
    }
    switch ($c.op) {
      'arm'    { $script:epoch = [long]$c.epoch }
      'disarm' { $script:epoch = -1 }
      'move'   { [void][In]::SetCursorPos([int]$c.x, [int]$c.y) }
      'click'  { $n = 1; if ($c.count) { $n = [int]$c.count }; $b = 'left'; if ($c.button) { $b = $c.button }; Click ([int]$c.x) ([int]$c.y) $b $n }
      'drag'   {
        [void][In]::SetCursorPos([int]$c.x, [int]$c.y); Start-Sleep -Milliseconds 50
        [In]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
        $steps = 8
        for ($i = 1; $i -le $steps; $i++) {
          [void][In]::SetCursorPos([int]($c.x + ($c.x2 - $c.x) * $i / $steps), [int]($c.y + ($c.y2 - $c.y) * $i / $steps)); Start-Sleep -Milliseconds 15
        }
        Start-Sleep -Milliseconds 60
        [In]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
      'scroll' {
        [void][In]::SetCursorPos([int]$c.x, [int]$c.y)
        if ($c.dx) { [In]::mouse_event(0x01000, 0, 0, [int]$c.dx, [UIntPtr]::Zero) }
        if ($c.dy) { [In]::mouse_event(0x0800, 0, 0, -[int]$c.dy, [UIntPtr]::Zero) }
      }
      'type'   { [In]::TypeText([string]$c.text) }
      'key'    {
        $codes = @($c.combo -split '\+' | Where-Object { $_ -ne '' } | ForEach-Object { Get-Vk $_ })
        foreach ($k in $codes) { $f = 0; if ($ext -contains $k) { $f = 1 }; [In]::keybd_event($k, 0, $f, [UIntPtr]::Zero) }
        [array]::Reverse($codes)
        foreach ($k in $codes) { $f = 2; if ($ext -contains $k) { $f = 3 }; [In]::keybd_event($k, 0, $f, [UIntPtr]::Zero) }
      }
      'foreground' { $out = [Ui]::Foreground() }
      'windows'    { $out = [Ui]::Windows([long]$c.skipPid) }
      'focus'      { $out = [Ui]::Focus([long]$c.hwnd) }
      'elements'   { $out = [Ui]::Elements([long]$c.hwnd, [int]$c.max, [int]$c.ms, [int]$c.sx, [int]$c.sy, [int]$c.sw, [int]$c.sh) }
      'elrect'     { $out = [Ui]::ElRect([int]$c.id) }
      'setvalue'   { $out = [Ui]::J([Ui]::SetValue([int]$c.id, [string]$c.text)) }
      'url'        { $out = [Ui]::BrowserUrl([long]$c.hwnd) }
      'text'       { $id = -1; if ($c.id -ne $null) { $id = [int]$c.id }; $out = [Ui]::Text([long]$c.hwnd, $id, [int]$c.max) }
      'launch'     { Start-Process -FilePath ([string]$c.target) }
      'ping'       { }
      default      { throw "unknown op $($c.op)" }
    }
    if ($out) { [Console]::Out.WriteLine("ok $out") } else { [Console]::Out.WriteLine('ok') }
  } catch { [Console]::Out.WriteLine('err: ' + ($_.Exception.Message -replace "[\r\n]+", ' ')) }
}
