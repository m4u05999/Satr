// satr-uia — المعين الأصلي لسطح ويندوز (الصف ١ في docs/COMPUTER-USE-DESKTOP.md).
//
// البروتوكول مرجعه المسبار scripts/uia-probe/Program.cs حرفياً: أسطر JSON على stdio،
// الطلب {id, method, params} ⇒ الردّ {id, result|error, ms}، والمرجع w<targetIndex>:e<elementIndex>.
//
// ممنوع بالتصميم (المواصفة §٧): لا تقييم كود، لا نقر بالإحداثيات، لا لقطة شاشة يفسّرها نموذج.
// الفعل يقع على عنصر من آخر لقطة بمرجعه وحده؛ وإن لم يظهر العنصر في الشجرة فالجواب «لا أستطيع».
// ⚠️ targets/list هنا يعدّد كل النوافذ العليا: الحارس ١ (لا تعداد بلا اختيار المستخدم) يُفرض في
// desktopguard.js (الخطوة ٣)، والاحتواء بالمستطيل (الحارس ٢) يُضاف هنا مع الخطوة ٤ — لا في هذه الخطوة.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Text;
using System.Text.Json.Nodes;

namespace SatrUia;

internal static class Program
{
    private const string Version = "0.1.0";
    private const int MaxTextLength = 65536;
    // القيمة المقروءة بعد setValue تُقصّ كي لا يعود مستند كامل في ردّ واحد
    private const int ReadBackLimit = 256;

    private static readonly StrategyBasedComWrappers Wrappers = new();
    private static IUIAutomation? uia;

    // الأهداف من آخر targets/list — المفتاح w<n>
    private static readonly Dictionary<string, IUIAutomationElement> Targets = new();
    // عناصر آخر لقطة لكل هدف — المفتاح w<n> ثم المرجع w<n>:e<m>. لقطة جديدة تستبدل السابقة كاملةً،
    // فأي مرجع من لقطة أقدم لا يُحلّ إلا إن أعادت اللقطة الجديدة إنتاجه
    private static readonly Dictionary<string, Dictionary<string, IUIAutomationElement>> Snapshots = new();

    private static int Main()
    {
        // عميل UIA يُنصح له بشقة متعددة الخيوط؛ النتيجة تُهمل لأن RPC_E_CHANGED_MODE لا يمنع العمل
        Native.CoInitializeEx(0, Native.CoinitMultithreaded);

        var utf8 = new UTF8Encoding(false);
        Console.InputEncoding = utf8;
        var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
        var stdin = new StreamReader(Console.OpenStandardInput(), utf8);

        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonNode? id = null;
            var sw = Stopwatch.StartNew();
            var response = new JsonObject();
            var stop = false;
            try
            {
                var req = JsonNode.Parse(line) as JsonObject ?? throw new HelperError("bad_request", "الطلب ليس كائن JSON");
                id = req["id"]?.DeepClone();
                var method = StringParam(req, "method") ?? throw new HelperError("bad_request", "method مفقود");
                var p = req["params"] as JsonObject ?? new JsonObject();
                response["result"] = method switch
                {
                    "initialize" => Initialize(),
                    "targets/list" => ListTargets(),
                    "tree/snapshot" => Snapshot(p),
                    "element/invoke" => Invoke(p),
                    "element/setValue" => SetValue(p),
                    "shutdown" => Shutdown(out stop),
                    _ => throw new HelperError("unknown_method", "طريقة غير معروفة: " + method),
                };
            }
            catch (HelperError e)
            {
                response["error"] = new JsonObject { ["code"] = e.Code, ["message"] = e.Message };
            }
            catch (Exception e)
            {
                // اسم الصنف ورمز HRESULT يكفيان للتشخيص؛ لا مسارات ولا تتبّع مكدّس في الردّ
                response["error"] = new JsonObject
                {
                    ["code"] = "internal",
                    ["message"] = e.GetType().Name + " 0x" + e.HResult.ToString("x8"),
                };
            }
            response["id"] = id;
            response["ms"] = sw.ElapsedMilliseconds;
            stdout.WriteLine(response.ToJsonString());
            if (stop) return 0;
        }
        // إغلاق stdin من الطرف الآخر = إنهاء لطيف بلا طلب shutdown
        return 0;
    }

    private static IUIAutomation Uia()
    {
        if (uia != null) return uia;
        var hr = Native.CoCreateInstance(Native.ClsidCUIAutomation, 0, Native.ClsctxInprocServer, Native.IidIUIAutomation, out var ptr);
        if (hr < 0 || ptr == 0) throw new HelperError("uia_unavailable", "تعذّر إنشاء عميل UI Automation: 0x" + hr.ToString("x8"));
        try { uia = (IUIAutomation)Wrappers.GetOrCreateObjectForComInstance(ptr, CreateObjectFlags.UniqueInstance); }
        finally { Marshal.Release(ptr); }
        return uia;
    }

    private static JsonObject Initialize()
    {
        var uiaAvailable = false;
        try { Uia().GetRootElement(out var root); uiaAvailable = root != null; } catch { uiaAvailable = false; }
        return new JsonObject
        {
            ["version"] = Version,
            ["osBuild"] = Environment.OSVersion.Version.ToString(),
            ["uiaAvailable"] = uiaAvailable,
            // null يعني أن المعين لا يعمل داخل حزمة — يمنع النجاح الكاذب في قياس MSIX (‏OBS-154)
            ["packageFullName"] = PackageFullName(),
            ["pid"] = Environment.ProcessId,
            // لا حقل «aot» عمداً: RuntimeFeature.IsDynamicCodeSupported يعيد false في بناء JIT أيضاً
            // لأن PublishAot يضبط مفتاح الميزة في runtimeconfig — مقيس، فالحقل كان سيكذب.
            // الاختبار يحكم من شكل الناتج على القرص (ملف واحد بلا satr-uia.dll بجواره).
        };
    }

    private static unsafe string? PackageFullName()
    {
        var len = 0;
        var rc = Native.GetCurrentPackageFullName(ref len, null);
        if (rc == Native.AppModelErrorNoPackage) return null;
        if (rc != Native.ErrorInsufficientBuffer || len <= 0) return "error:" + rc;
        var buf = new char[len];
        fixed (char* p = buf)
        {
            rc = Native.GetCurrentPackageFullName(ref len, p);
            return rc == 0 ? new string(p, 0, Math.Max(0, len - 1)) : "error:" + rc;
        }
    }

    private static JsonArray ListTargets()
    {
        Targets.Clear();
        Snapshots.Clear();
        var list = new JsonArray();
        var automation = Uia();
        automation.GetRootElement(out var root);
        automation.CreateTrueCondition(out var trueCondition);
        root.FindAll(Native.TreeScopeChildren, trueCondition, out var children);
        children.get_Length(out var count);
        var n = 0;
        for (var i = 0; i < count; i++)
        {
            try
            {
                children.GetElement(i, out var w);
                w.get_CurrentProcessId(out var pid);
                w.get_CurrentName(out var title);
                w.get_CurrentBoundingRectangle(out var rect);
                string processName;
                try { processName = Process.GetProcessById(pid).ProcessName; } catch { processName = ""; }
                n++;
                var targetId = "w" + n;
                Targets[targetId] = w;
                // التحويل إلى JsonNode يختار Add غير العامّة — العامّة تحتاج توليد كود وقت التشغيل (IL3050)
                list.Add((JsonNode)new JsonObject
                {
                    ["targetId"] = targetId,
                    ["pid"] = pid,
                    ["processName"] = processName,
                    ["title"] = title ?? "",
                    ["rect"] = RectJson(rect),
                });
            }
            catch (Exception e) when (IsGone(e)) { /* نافذة أُغلقت أثناء التعداد */ }
        }
        return list;
    }

    private static JsonObject Snapshot(JsonObject p)
    {
        var targetId = StringParam(p, "targetId") ?? throw new HelperError("bad_request", "targetId مفقود");
        if (!Targets.TryGetValue(targetId, out var root)) throw new HelperError("not_found", "هدف غير معروف: " + targetId);
        var maxDepth = Math.Clamp(IntParam(p, "maxDepth") ?? 12, 1, 64);
        var maxNodes = Math.Clamp(IntParam(p, "maxNodes") ?? 400, 1, 2000);
        var targetIndex = targetId.Substring(1);

        Uia().get_ControlViewWalker(out var walker);
        var elements = new Dictionary<string, IUIAutomationElement>();
        var nodes = new JsonArray();
        var truncated = false;
        var stack = new Stack<(IUIAutomationElement el, int depth)>();
        stack.Push((root, 0));
        var e = 0;
        while (stack.Count > 0)
        {
            var (el, depth) = stack.Pop();
            if (nodes.Count >= maxNodes) { truncated = true; break; }
            try
            {
                el.get_CurrentIsPassword(out var isPassword);
                // الحارس ٣: حقل السرّ لا يدخل اللقطة أصلاً — لا مرجع ولا اسم ولا أبناء
                if (isPassword != 0) continue;
                el.get_CurrentControlType(out var controlType);
                el.get_CurrentName(out var name);
                el.get_CurrentBoundingRectangle(out var rect);
                el.get_CurrentIsEnabled(out var enabled);
                el.get_CurrentIsKeyboardFocusable(out var focusable);
                e++;
                var reference = "w" + targetIndex + ":e" + e;
                elements[reference] = el;
                nodes.Add((JsonNode)new JsonObject
                {
                    ["ref"] = reference,
                    ["role"] = RoleOf(controlType),
                    ["name"] = name ?? "",
                    ["rect"] = RectJson(rect),
                    ["enabled"] = enabled != 0,
                    ["focusable"] = focusable != 0,
                    ["isPassword"] = false,
                    ["depth"] = depth,
                });
                if (depth >= maxDepth) continue;
                // الأبناء بالعكس فوق المكدّس كي يُقرأوا بترتيبهم الطبيعي
                var kids = new List<IUIAutomationElement>();
                walker.GetFirstChildElement(el, out var k);
                while (k != null)
                {
                    kids.Add(k);
                    walker.GetNextSiblingElement(k, out var next);
                    k = next;
                }
                for (var i = kids.Count - 1; i >= 0; i--) stack.Push((kids[i], depth + 1));
            }
            catch (Exception ex) when (IsGone(ex))
            {
                // الجذر نفسه زال = النافذة أُغلقت؛ غيره = عنصر زال أثناء المشي
                if (depth == 0) throw new HelperError("closed", "النافذة أُغلقت: " + targetId);
            }
        }
        Snapshots[targetId] = elements;
        return new JsonObject { ["nodes"] = nodes, ["truncated"] = truncated };
    }

    private static JsonObject Invoke(JsonObject p)
    {
        var el = ResolveRef(p);
        var pattern = PatternOf<IUIAutomationInvokePattern>(el, Native.InvokePatternId, "InvokePattern");
        Act(() => pattern.Invoke());
        return new JsonObject { ["ok"] = true };
    }

    private static JsonObject SetValue(JsonObject p)
    {
        var el = ResolveRef(p);
        var text = StringParam(p, "text") ?? throw new HelperError("bad_request", "text مفقود أو ليس نصاً");
        if (text.Length > MaxTextLength) throw new HelperError("bad_request", "النص أطول من " + MaxTextLength + " محرفاً");
        var pattern = PatternOf<IUIAutomationValuePattern>(el, Native.ValuePatternId, "ValuePattern");
        string? previous = null;
        Act(() =>
        {
            pattern.get_CurrentIsReadOnly(out var readOnly);
            if (readOnly != 0) throw new HelperError("read_only", "العنصر للقراءة فقط");
            pattern.get_CurrentValue(out previous);
            pattern.SetValue(text);
        });
        // قراءة ثانية من العنصر نفسه لا صدى للمُرسَل: إن لم يقع الفعل ظهر الفرق
        string? after = null;
        Act(() => pattern.get_CurrentValue(out after));
        return new JsonObject { ["ok"] = true, ["previous"] = Clip(previous), ["value"] = Clip(after) };
    }

    private static JsonObject Shutdown(out bool stop)
    {
        stop = true;
        return new JsonObject { ["ok"] = true };
    }

    // أي مرجع لا يطابق ^w[1-9][0-9]*:e[1-9][0-9]*$ أو لا يوجد في آخر لقطة لهدفه ⇒ stale_ref بلا فعل
    private static IUIAutomationElement ResolveRef(JsonObject p)
    {
        var reference = StringParam(p, "ref");
        if (reference == null || !IsWellFormedRef(reference, out var targetId))
            throw new HelperError("stale_ref", "مرجع غير صالح: خذ لقطة جديدة");
        if (!Snapshots.TryGetValue(targetId, out var elements) || !elements.TryGetValue(reference, out var el))
            throw new HelperError("stale_ref", "المرجع " + reference + " ليس من آخر لقطة: خذ لقطة جديدة");
        return el;
    }

    // مطابقة يدوية للنمط بدل Regex — مكتبة التعابير النمطية تضخّم ثنائي AOT
    internal static bool IsWellFormedRef(string s, out string targetId)
    {
        targetId = "";
        var colon = s.IndexOf(':');
        if (colon < 0 || s.Length > 32) return false;
        if (!IsIndex(s, 'w', 0, colon) || !IsIndex(s, 'e', colon + 1, s.Length)) return false;
        targetId = s.Substring(0, colon);
        return true;
    }

    private static bool IsIndex(string s, char prefix, int start, int end)
    {
        if (end - start < 2 || s[start] != prefix || s[start + 1] < '1' || s[start + 1] > '9') return false;
        for (var i = start + 2; i < end; i++) if (s[i] < '0' || s[i] > '9') return false;
        return true;
    }

    private static T PatternOf<T>(IUIAutomationElement el, int patternId, string patternName) where T : class
    {
        nint ptr = 0;
        Act(() => el.GetCurrentPattern(patternId, out ptr));
        if (ptr == 0) throw new HelperError("unsupported_pattern", "العنصر لا يدعم " + patternName);
        try { return (T)Wrappers.GetOrCreateObjectForComInstance(ptr, CreateObjectFlags.UniqueInstance); }
        finally { Marshal.Release(ptr); }
    }

    // يترجم أعطال الفعل إلى رموز البروتوكول: عنصر زال ⇒ stale_ref، معطَّل ⇒ disabled
    private static void Act(Action action)
    {
        try { action(); }
        catch (HelperError) { throw; }
        catch (Exception e) when (IsGone(e)) { throw new HelperError("stale_ref", "العنصر لم يعد موجوداً: خذ لقطة جديدة"); }
        catch (Exception e) when (e.HResult == Native.UiaElementNotEnabled) { throw new HelperError("disabled", "العنصر معطَّل"); }
    }

    private static bool IsGone(Exception e) =>
        e.HResult == Native.UiaElementNotAvailable || e.HResult == Native.RpcDisconnected || e.HResult == Native.RpcServerUnavailable;

    private static string? StringParam(JsonObject o, string key) =>
        o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static int? IntParam(JsonObject o, string key)
    {
        var node = o[key];
        if (node == null) return null;
        if (node is JsonValue v && v.TryGetValue<int>(out var i)) return i;
        throw new HelperError("bad_request", key + " ليس عدداً صحيحاً");
    }

    private static string? Clip(string? s) =>
        s == null || s.Length <= ReadBackLimit ? s : s.Substring(0, ReadBackLimit) + "…";

    // أرقام UIA_*ControlTypeId من UIAutomationClient.h ⇒ الاسم البرمجي بأحرف صغيرة كما في المسبار
    private static readonly string[] Roles =
    {
        "button", "calendar", "checkbox", "combobox", "edit", "hyperlink", "image", "listitem", "list", "menu",
        "menubar", "menuitem", "progressbar", "radiobutton", "scrollbar", "slider", "spinner", "statusbar", "tab", "tabitem",
        "text", "toolbar", "tooltip", "tree", "treeitem", "custom", "group", "thumb", "datagrid", "dataitem",
        "document", "splitbutton", "window", "pane", "header", "headeritem", "table", "titlebar", "separator", "semanticzoom",
        "appbar",
    };

    private static string RoleOf(int controlType)
    {
        var i = controlType - 50000;
        return i >= 0 && i < Roles.Length ? Roles[i] : "unknown";
    }

    private static JsonNode? RectJson(UiaRect r)
    {
        var w = r.Right - r.Left;
        var h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return null;
        return new JsonObject { ["x"] = r.Left, ["y"] = r.Top, ["w"] = w, ["h"] = h };
    }

    private sealed class HelperError : Exception
    {
        public string Code { get; }
        public HelperError(string code, string message) : base(message) { Code = code; }
    }
}
