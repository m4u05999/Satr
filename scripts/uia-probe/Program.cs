// مسبار UIA — الخطوة صفر في docs/COMPUTER-USE-DESKTOP.md (OBS-154).
// يجيب سؤالاً واحداً: هل تُقرأ شجرة UI Automation لنافذة تطبيق آخر من داخل حزمة MSIX لسطر؟
// البروتوكول أسطر JSON على stdio بنمط codex app-server: {id, method, params} ⇒ {id, result|error, ms}.
// ⚠️ هذا مسبار لا معين إنتاجي: targets/list يعدّد النوافذ للقياس وحده. في الإنتاج لا تعداد
// بلا اختيار المستخدم (الحارس ١ في المستند) ويُفرض في desktopguard.js لا هنا.
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;

namespace UiaProbe;

internal static class Program
{
    private const string Version = "0.1.0-probe";
    private const int AppModelErrorNoPackage = 15700;
    private const int ErrorInsufficientBuffer = 122;

    // الأهداف المعروفة من آخر targets/list — المفتاح w<n>
    private static readonly Dictionary<string, AutomationElement> Targets = new();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetCurrentPackageFullName(ref int packageFullNameLength, StringBuilder? packageFullName);

    private static int Main()
    {
        var utf8 = new UTF8Encoding(false);
        Console.InputEncoding = utf8;
        Console.OutputEncoding = utf8;
        var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true };

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonNode? id = null;
            var sw = Stopwatch.StartNew();
            var response = new JsonObject();
            var stop = false;
            try
            {
                var req = JsonNode.Parse(line) as JsonObject ?? throw new ProbeError("bad_request", "الطلب ليس كائن JSON");
                id = req["id"]?.DeepClone();
                var method = req["method"]?.GetValue<string>() ?? throw new ProbeError("bad_request", "method مفقود");
                var p = req["params"] as JsonObject ?? new JsonObject();
                response["result"] = method switch
                {
                    "initialize" => Initialize(),
                    "targets/list" => ListTargets(),
                    "tree/snapshot" => Snapshot(p),
                    "shutdown" => Shutdown(out stop),
                    _ => throw new ProbeError("unknown_method", "طريقة غير معروفة: " + method),
                };
            }
            catch (ProbeError e)
            {
                response["error"] = new JsonObject { ["code"] = e.Code, ["message"] = e.Message };
            }
            catch (Exception e)
            {
                // اسم الصنف وحده يكفي للتشخيص؛ لا مسارات ولا تتبّع مكدّس في الردّ
                response["error"] = new JsonObject { ["code"] = "internal", ["message"] = e.GetType().Name + ": " + e.Message };
            }
            response["id"] = id;
            response["ms"] = sw.ElapsedMilliseconds;
            stdout.WriteLine(response.ToJsonString());
            if (stop) return 0;
        }
        return 0;
    }

    private static JsonObject Initialize()
    {
        var uiaAvailable = false;
        try { uiaAvailable = AutomationElement.RootElement != null; } catch { uiaAvailable = false; }
        return new JsonObject
        {
            ["version"] = Version,
            ["osBuild"] = Environment.OSVersion.Version.ToString(),
            ["uiaAvailable"] = uiaAvailable,
            // هذا الحقل يمنع النجاح الكاذب: null يعني أن المعين لا يعمل داخل حزمة أصلاً
            ["packageFullName"] = PackageFullName(),
            ["pid"] = Environment.ProcessId,
        };
    }

    private static string? PackageFullName()
    {
        var len = 0;
        var rc = GetCurrentPackageFullName(ref len, null);
        if (rc == AppModelErrorNoPackage) return null;
        if (rc != ErrorInsufficientBuffer) return "error:" + rc;
        var sb = new StringBuilder(len);
        rc = GetCurrentPackageFullName(ref len, sb);
        return rc == 0 ? sb.ToString() : "error:" + rc;
    }

    private static JsonArray ListTargets()
    {
        Targets.Clear();
        var list = new JsonArray();
        var children = AutomationElement.RootElement.FindAll(TreeScope.Children, System.Windows.Automation.Condition.TrueCondition);
        var n = 0;
        foreach (AutomationElement w in children)
        {
            try
            {
                var pid = w.Current.ProcessId;
                string processName;
                try { processName = Process.GetProcessById(pid).ProcessName; } catch { processName = ""; }
                n++;
                var targetId = "w" + n;
                Targets[targetId] = w;
                list.Add(new JsonObject
                {
                    ["targetId"] = targetId,
                    ["pid"] = pid,
                    ["processName"] = processName,
                    ["title"] = w.Current.Name,
                    ["rect"] = RectJson(w.Current.BoundingRectangle),
                });
            }
            catch (ElementNotAvailableException) { /* نافذة أُغلقت أثناء التعداد */ }
        }
        return list;
    }

    private static JsonObject Snapshot(JsonObject p)
    {
        var targetId = p["targetId"]?.GetValue<string>() ?? throw new ProbeError("bad_request", "targetId مفقود");
        if (!Targets.TryGetValue(targetId, out var root)) throw new ProbeError("not_found", "هدف غير معروف: " + targetId);
        var maxDepth = Math.Clamp(p["maxDepth"]?.GetValue<int>() ?? 12, 1, 64);
        var maxNodes = Math.Clamp(p["maxNodes"]?.GetValue<int>() ?? 400, 1, 2000);
        var targetIndex = targetId.Substring(1);

        var nodes = new JsonArray();
        var truncated = false;
        var walker = TreeWalker.ControlViewWalker;
        var stack = new Stack<(AutomationElement el, int depth)>();
        stack.Push((root, 0));
        var e = 0;
        while (stack.Count > 0)
        {
            var (el, depth) = stack.Pop();
            if (nodes.Count >= maxNodes) { truncated = true; break; }
            try
            {
                var c = el.Current;
                e++;
                nodes.Add(new JsonObject
                {
                    ["ref"] = "w" + targetIndex + ":e" + e,
                    ["role"] = RoleOf(c.ControlType),
                    ["name"] = c.Name,
                    ["rect"] = RectJson(c.BoundingRectangle),
                    ["enabled"] = c.IsEnabled,
                    ["focusable"] = c.IsKeyboardFocusable,
                    ["isPassword"] = c.IsPassword,
                    ["depth"] = depth,
                });
                if (depth >= maxDepth) continue;
                // الأبناء بالعكس فوق المكدّس كي يُقرأوا بترتيبهم الطبيعي
                var kids = new List<AutomationElement>();
                for (var k = walker.GetFirstChild(el); k != null; k = walker.GetNextSibling(k)) kids.Add(k);
                for (var i = kids.Count - 1; i >= 0; i--) stack.Push((kids[i], depth + 1));
            }
            catch (ElementNotAvailableException) { /* عنصر زال أثناء المشي */ }
        }
        return new JsonObject { ["nodes"] = nodes, ["truncated"] = truncated };
    }

    private static JsonObject Shutdown(out bool stop)
    {
        stop = true;
        return new JsonObject { ["ok"] = true };
    }

    private static string RoleOf(ControlType t)
    {
        // "ControlType.Button" ⇒ "button"
        var name = t?.ProgrammaticName ?? "";
        var dot = name.LastIndexOf('.');
        return (dot >= 0 ? name[(dot + 1)..] : name).ToLowerInvariant();
    }

    private static JsonNode? RectJson(Rect r)
    {
        if (r.IsEmpty || double.IsInfinity(r.Width) || double.IsInfinity(r.Height)) return null;
        return new JsonObject
        {
            ["x"] = (int)Math.Round(r.X),
            ["y"] = (int)Math.Round(r.Y),
            ["w"] = (int)Math.Round(r.Width),
            ["h"] = (int)Math.Round(r.Height),
        };
    }

    private sealed class ProbeError : Exception
    {
        public string Code { get; }
        public ProbeError(string code, string message) : base(message) { Code = code; }
    }
}
