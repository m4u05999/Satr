// satr-uia — المعين الأصلي لسطح ويندوز (الصفّان ١ و٤ في docs/COMPUTER-USE-DESKTOP.md).
//
// البروتوكول مرجعه المسبار scripts/uia-probe/Program.cs حرفياً: أسطر JSON على stdio،
// الطلب {id, method, params} ⇒ الردّ {id, result|error, ms}، والمرجع w<targetIndex>:e<elementIndex>.
//
// ممنوع بالتصميم (المواصفة §٧): لا تقييم كود، لا نقر بالإحداثيات، لا لقطة شاشة يفسّرها نموذج.
// الفعل يقع على عنصر من آخر لقطة بمرجعه وحده؛ وإن لم يظهر العنصر في الشجرة فالجواب «لا أستطيع».
// targets/list وحده يعدّد كل النوافذ العليا — لمنتقي المستخدم؛ والحارس ١ (لا تعداد بلا اختيار) يُفرض في
// desktopguard.js. وبعد session/select يصير كل تابع آخر محصوراً بالنافذة المختارة ومستطيلها: هذا
// الشق الثاني من الفحص المزدوج للحارس ٢ (الأول في desktopguard.checkAction قبل الإرسال).
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Text;
using System.Text.Json.Nodes;

namespace SatrUia;

internal static class Program
{
    private const string Version = "0.2.0";
    private const int MaxTextLength = 65536;
    // القيمة المقروءة بعد setValue تُقصّ كي لا يعود مستند كامل في ردّ واحد
    private const int ReadBackLimit = 256;
    // وصف «كان/صار» في target_changed — للرسالة لا للبيانات
    private const int DescribeLimit = 80;
    private const int MaxScrollSteps = 50;
    private const int MaxScrollAncestors = 8;
    // الضلع الأطول للصورة المعادة؛ ما زاد يُصغَّر بمعامل صحيح
    private const int MaxCaptureSide = 1568;
    private const int FocusWaitMs = 400;
    private const uint GaRoot = 2;

    private static readonly StrategyBasedComWrappers Wrappers = new();
    private static IUIAutomation? uia;

    // رقم ثابت لكل نافذة طوال عمر المعين، مفتاحه (المقبض، العملية)، ولا يُعاد استعماله أبداً —
    // فمرجع نافذة أُغلقت لا يُحلّ على نافذة فُتحت بعدها، وسرد جديد لا يُعيد ترقيم نافذة قائمة
    private static readonly Dictionary<(nint Hwnd, int Pid), string> IdsByWindow = new();
    private static int lastTargetNumber;
    // الأهداف كما في آخر targets/list — المفتاح w<n>
    private static readonly Dictionary<string, TargetEntry> Targets = new();
    // عناصر آخر لقطة للهدف مع بصمتها لحظة اللقطة — المفتاح w<n> ثم المرجع w<n>:e<m>. لقطة جديدة
    // تستبدل السابقة كاملةً، فمرجع من لقطة أقدم لا يُحلّ إلا إن أعادت الجديدة إنتاجه
    private static readonly Dictionary<string, Dictionary<string, SnapEntry>> Snapshots = new();
    // النافذة المختارة لهذه الجلسة ومستطيلها المأذون (session/select)؛ null = لا فعل ولا لقطة
    private static Session? session;

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
                    "session/select" => SessionSelect(p),
                    "tree/snapshot" => Snapshot(p),
                    "element/state" => ElementState(p),
                    "element/invoke" => Invoke(p),
                    "element/setValue" => SetValue(p),
                    "input/key" => Key(p),
                    "input/scroll" => Scroll(p),
                    "capture/window" => Capture(p),
                    "shutdown" => Shutdown(out stop),
                    _ => throw new HelperError("unknown_method", "طريقة غير معروفة: " + method),
                };
            }
            catch (HelperError e)
            {
                var error = new JsonObject { ["code"] = e.Code, ["message"] = e.Message };
                if (e.Was != null) error["was"] = e.Was;
                if (e.Now != null) error["now"] = e.Now;
                response["error"] = error;
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
        var list = new JsonArray();
        var current = new Dictionary<string, TargetEntry>();
        var automation = Uia();
        automation.GetRootElement(out var root);
        automation.CreateTrueCondition(out var trueCondition);
        root.FindAll(Native.TreeScopeChildren, trueCondition, out var children);
        children.get_Length(out var count);
        for (var i = 0; i < count; i++)
        {
            try
            {
                children.GetElement(i, out var w);
                w.get_CurrentNativeWindowHandle(out var hwnd);
                // نافذة بلا مقبض لا تُختار: لا هوية ثابتة لها ولا تركيز ولا التقاط
                if (hwnd == 0) continue;
                w.get_CurrentProcessId(out var pid);
                w.get_CurrentName(out var title);
                w.get_CurrentClassName(out var className);
                w.get_CurrentBoundingRectangle(out var rect);
                string processName;
                try { processName = Process.GetProcessById(pid).ProcessName; } catch { processName = ""; }
                if (!IdsByWindow.TryGetValue((hwnd, pid), out var targetId))
                {
                    targetId = "w" + (++lastTargetNumber);
                    IdsByWindow[(hwnd, pid)] = targetId;
                }
                current[targetId] = new TargetEntry(w, hwnd, pid);
                // التحويل إلى JsonNode يختار Add غير العامّة — العامّة تحتاج توليد كود وقت التشغيل (IL3050)
                list.Add((JsonNode)new JsonObject
                {
                    ["targetId"] = targetId,
                    ["pid"] = pid,
                    ["processName"] = processName,
                    ["title"] = title ?? "",
                    // اسم الصنف لحجب الأصناف بالاسم (الحارس ٤): Credential Dialog Xaml Host صنف لا عنوان
                    ["className"] = className ?? "",
                    ["rect"] = RectJson(rect),
                });
            }
            catch (Exception e) when (IsGone(e)) { /* نافذة أُغلقت أثناء التعداد */ }
        }
        // نافذة غابت عن السرد تفقد رقمها ولقطتها؛ إن عادت أخذت رقماً جديداً لم يُستعمل قبلاً
        foreach (var key in IdsByWindow.Where((kv) => !current.ContainsKey(kv.Value)).Select((kv) => kv.Key).ToList()) IdsByWindow.Remove(key);
        foreach (var gone in Snapshots.Keys.Where((t) => !current.ContainsKey(t)).ToList()) Snapshots.Remove(gone);
        Targets.Clear();
        foreach (var kv in current) Targets[kv.Key] = kv.Value;
        return list;
    }

    // الحارس ١ + ٢ في المعين: الاختيار يثبّت الهدف ومستطيله، والمستطيل يُقرأ حياً ويجب أن يطابق ما رآه
    // المستخدم في المنتقي حرفياً — فلا يُمرَّر مستطيل أوسع من النافذة ولا تُختار نافذة تحرّكت بعد عرضها
    private static JsonObject SessionSelect(JsonObject p)
    {
        var targetId = StringParam(p, "targetId") ?? throw new HelperError("bad_request", "targetId مفقود");
        var pid = IntParam(p, "pid") ?? throw new HelperError("bad_request", "pid مفقود");
        var rect = RectParam(p, "rect") ?? throw new HelperError("bad_request", "rect مفقود أو غير صالح");
        if (!Targets.TryGetValue(targetId, out var target))
            throw new HelperError("not_found", "هدف غير معروف: " + targetId + " — اسرد النوافذ من جديد");
        if (target.Pid != pid) throw new HelperError("not_allowed", "رقم العملية لا يطابق النافذة المختارة");
        UiaRect live = default;
        try { target.Element.get_CurrentBoundingRectangle(out live); }
        catch (Exception e) when (IsGone(e)) { throw new HelperError("closed", "النافذة أُغلقت: " + targetId); }
        if (!SameRect(live, rect)) throw new HelperError("not_allowed", "مستطيل النافذة تغيّر منذ عرضها: اسرد النوافذ واختر من جديد");
        session = new Session(targetId, target.Hwnd, target.Pid, rect, target.Element);
        // جلسة جديدة تبدأ بلا لقطة: مراجع ما قبل الاختيار لا تُحلّ بعده
        Snapshots.Clear();
        return new JsonObject { ["ok"] = true, ["targetId"] = targetId };
    }

    // الجلسة حيّة = اختيرت نافذة، ومقبضها ما زال نافذة، والعملية نفسها ما زالت مالكته
    private static Session RequireSession()
    {
        var s = session ?? throw new HelperError("not_allowed", "لا نافذة مختارة لهذه الجلسة: session/select أولاً");
        Native.GetWindowThreadProcessId(s.Hwnd, out var pid);
        if (!Native.IsWindow(s.Hwnd) || pid != (uint)s.Pid) throw new HelperError("closed", "النافذة المختارة أُغلقت: " + s.TargetId);
        return s;
    }

    private static JsonObject Snapshot(JsonObject p)
    {
        var targetId = StringParam(p, "targetId") ?? throw new HelperError("bad_request", "targetId مفقود");
        var s = RequireSession();
        if (targetId != s.TargetId) throw new HelperError("not_allowed", "النافذة ليست النافذة المختارة لهذه الجلسة");
        var maxDepth = Math.Clamp(IntParam(p, "maxDepth") ?? 12, 1, 64);
        var maxNodes = Math.Clamp(IntParam(p, "maxNodes") ?? 400, 1, 2000);
        var targetIndex = targetId.Substring(1);

        Uia().get_ControlViewWalker(out var walker);
        var elements = new Dictionary<string, SnapEntry>();
        var nodes = new JsonArray();
        var truncated = false;
        var stack = new Stack<(IUIAutomationElement el, int depth)>();
        stack.Push((s.Root, 0));
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
                var role = RoleOf(controlType);
                // البصمة لحظة اللقطة: الفعل اللاحق يقارنها بالعنصر حياً (target_changed)
                elements[reference] = new SnapEntry(el, role, name ?? "", rect);
                nodes.Add((JsonNode)new JsonObject
                {
                    ["ref"] = reference,
                    ["role"] = role,
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

    // حالة عنصر واحد من آخر لقطة بلا مشي الشجرة — ينتظر بها desktop_wait_for ولا يُبطل المراجع
    private static JsonObject ElementState(JsonObject p)
    {
        var entry = ResolveRef(p);
        var s = session!;
        int controlType = 0, enabled = 0;
        string? name = null;
        UiaRect rect = default;
        Act(() =>
        {
            entry.Element.get_CurrentControlType(out controlType);
            entry.Element.get_CurrentName(out name);
            entry.Element.get_CurrentBoundingRectangle(out rect);
            entry.Element.get_CurrentIsEnabled(out enabled);
        });
        return new JsonObject
        {
            ["role"] = RoleOf(controlType),
            ["name"] = name ?? "",
            ["rect"] = RectJson(rect),
            ["enabled"] = enabled != 0,
            ["inside"] = !IsEmpty(rect) && Contains(s.Rect, rect),
        };
    }

    private static JsonObject Invoke(JsonObject p)
    {
        var entry = ResolveRef(p);
        Verify(entry, needsRect: false);
        var pattern = PatternOf<IUIAutomationInvokePattern>(entry.Element, Native.InvokePatternId, "InvokePattern");
        Act(() => pattern.Invoke());
        return new JsonObject { ["ok"] = true };
    }

    private static JsonObject SetValue(JsonObject p)
    {
        var entry = ResolveRef(p);
        Verify(entry, needsRect: false);
        var text = StringParam(p, "text") ?? throw new HelperError("bad_request", "text مفقود أو ليس نصاً");
        if (text.Length > MaxTextLength) throw new HelperError("bad_request", "النص أطول من " + MaxTextLength + " محرفاً");
        var pattern = PatternOf<IUIAutomationValuePattern>(entry.Element, Native.ValuePatternId, "ValuePattern");
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

    // input/key: مفاتيح بقائمة بيضاء ثابتة إلى النافذة المختارة بعد جلبها إلى الأمام والتحقق منه —
    // لا ref ولا إحداثيات؛ المفاتيح تصل العنصر المركّز داخل تلك النافذة
    private static JsonObject Key(JsonObject p)
    {
        var s = RequireSession();
        var keys = StringParam(p, "keys") ?? throw new HelperError("bad_key", "keys مفقود");
        var chord = ParseKeys(keys);
        Focus(s);
        SendChord(chord, s.Hwnd);
        return new JsonObject { ["ok"] = true, ["keys"] = chord.Canonical };
    }

    // input/scroll: ScrollPattern أولاً على العنصر أو أقرب سلف قابل للتمرير داخل النافذة المأذونة،
    // وإلا WM_MOUSEWHEEL على مركز مستطيل العنصر نفسه — الموضع من العنصر لا من الوكيل
    private static JsonObject Scroll(JsonObject p)
    {
        var entry = ResolveRef(p);
        var dy = IntParam(p, "dy") ?? throw new HelperError("bad_request", "dy مفقود");
        if (dy == 0 || Math.Abs(dy) > MaxScrollSteps) throw new HelperError("bad_request", "dy عدد خطوات بين -" + MaxScrollSteps + " و" + MaxScrollSteps + " بلا صفر");
        var rect = Verify(entry, needsRect: true);
        var s = session!;
        var pattern = FindScrollable(entry.Element, s.Rect);
        if (pattern != null)
        {
            double before = 0, after = 0;
            Act(() => pattern.get_CurrentVerticalScrollPercent(out before));
            var amount = dy > 0 ? Native.ScrollSmallIncrement : Native.ScrollSmallDecrement;
            for (var i = 0; i < Math.Abs(dy); i++) Act(() => pattern.Scroll(Native.ScrollNoAmount, amount));
            Act(() => pattern.get_CurrentVerticalScrollPercent(out after));
            return new JsonObject { ["ok"] = true, ["via"] = "pattern", ["before"] = Math.Round(before, 2), ["after"] = Math.Round(after, 2) };
        }
        var hwnd = WheelHandle(entry.Element, s.Hwnd);
        var x = rect.Left + (rect.Right - rect.Left) / 2;
        var y = rect.Top + (rect.Bottom - rect.Top) / 2;
        // الكلمة العليا من wParam إزاحة العجلة (موجبها إلى الأعلى)، وlParam نقطة الشاشة (x منخفضة، y عليا)
        var wParam = (nint)((uint)(ushort)(short)(-dy * Native.WheelDelta) << 16);
        var lParam = (nint)(((uint)(ushort)(short)y << 16) | (ushort)(short)x);
        if (!Native.PostMessageW(hwnd, Native.WmMouseWheel, wParam, lParam))
            throw new HelperError("internal", "تعذّر إرسال رسالة العجلة إلى النافذة");
        return new JsonObject { ["ok"] = true, ["via"] = "wheel" };
    }

    // capture/window: النافذة المختارة وحدها بـPrintWindow ⇒ PNG ‏RGB بلا شفافية — آخر الملاذ لا الافتراضي
    private static unsafe JsonObject Capture(JsonObject p)
    {
        var targetId = StringParam(p, "targetId") ?? throw new HelperError("bad_request", "targetId مفقود");
        var s = RequireSession();
        if (targetId != s.TargetId) throw new HelperError("not_allowed", "لا التقاط إلا للنافذة المختارة لهذه الجلسة");
        if (Native.IsIconic(s.Hwnd)) throw new HelperError("not_allowed", "النافذة المختارة مصغّرة: لا شيء يُلتقط");
        if (!Native.GetWindowRect(s.Hwnd, out var bounds)) throw new HelperError("closed", "النافذة المختارة أُغلقت: " + s.TargetId);
        var width = bounds.Right - bounds.Left;
        var height = bounds.Bottom - bounds.Top;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384)
            throw new HelperError("not_allowed", "أبعاد النافذة لا تصلح للالتقاط");

        var screen = Native.GetDC(0);
        if (screen == 0) throw new HelperError("internal", "تعذّر الحصول على سياق الرسم");
        var memory = Native.CreateCompatibleDC(screen);
        var header = new BitmapInfoHeader
        {
            Size = (uint)sizeof(BitmapInfoHeader),
            Width = width,
            Height = -height, // من الأعلى إلى الأسفل
            Planes = 1,
            BitCount = 32,
        };
        void* bits = null;
        var bitmap = Native.CreateDIBSection(memory, &header, 0, &bits, 0, 0);
        byte[] bgra;
        try
        {
            if (bitmap == 0 || bits == null) throw new HelperError("internal", "تعذّر حجز صورة الالتقاط");
            var previous = Native.SelectObject(memory, bitmap);
            var printed = Native.PrintWindow(s.Hwnd, memory, Native.PwRenderFullContent) || Native.PrintWindow(s.Hwnd, memory, 0);
            Native.SelectObject(memory, previous);
            if (!printed) throw new HelperError("internal", "PrintWindow أخفق");
            bgra = new byte[width * height * 4];
            Marshal.Copy((nint)bits, bgra, 0, bgra.Length);
        }
        finally
        {
            if (bitmap != 0) Native.DeleteObject(bitmap);
            Native.DeleteDC(memory);
            Native.ReleaseDC(0, screen);
        }
        var scale = Math.Max(1, (int)Math.Ceiling(Math.Max(width, height) / (double)MaxCaptureSide));
        var rgb = ToRgb(bgra, width, height, scale, out var outWidth, out var outHeight);
        var png = Png.Encode(rgb, outWidth, outHeight);
        return new JsonObject
        {
            ["png"] = Convert.ToBase64String(png),
            ["width"] = outWidth,
            ["height"] = outHeight,
            ["sourceWidth"] = width,
            ["sourceHeight"] = height,
        };
    }

    private static JsonObject Shutdown(out bool stop)
    {
        stop = true;
        return new JsonObject { ["ok"] = true };
    }

    // أي مرجع لا يطابق ^w[1-9][0-9]*:e[1-9][0-9]*$ أو لا يوجد في آخر لقطة لهدفه ⇒ stale_ref بلا فعل؛
    // ومرجع هدف غير المختار ⇒ not_allowed؛ ونافذة أُغلقت ⇒ closed
    private static SnapEntry ResolveRef(JsonObject p)
    {
        var reference = StringParam(p, "ref");
        if (reference == null || !IsWellFormedRef(reference, out var targetId))
            throw new HelperError("stale_ref", "مرجع غير صالح: خذ لقطة جديدة");
        var s = RequireSession();
        if (targetId != s.TargetId) throw new HelperError("not_allowed", "المرجع من نافذة غير النافذة المختارة لهذه الجلسة");
        if (!Snapshots.TryGetValue(targetId, out var elements) || !elements.TryGetValue(reference, out var entry))
            throw new HelperError("stale_ref", "المرجع " + reference + " ليس من آخر لقطة: خذ لقطة جديدة");
        return entry;
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

    // يُقرأ العنصر حياً لا من ذاكرة اللقطة: الاحتواء أولاً (حدّ أمان — not_allowed) ثم البصمة
    // (صحّة — target_changed). عنصر بلا مستطيل يُقبل لفعل بنمط UIA ويُرفض لما يحتاج موضعاً
    private static UiaRect Verify(SnapEntry entry, bool needsRect)
    {
        var s = session!;
        int controlType = 0;
        string? name = null;
        UiaRect rect = default;
        Act(() =>
        {
            entry.Element.get_CurrentControlType(out controlType);
            entry.Element.get_CurrentName(out name);
            entry.Element.get_CurrentBoundingRectangle(out rect);
        });
        if (IsEmpty(rect))
        {
            if (needsRect) throw new HelperError("not_allowed", "العنصر بلا مستطيل: هذا الفعل يحتاج موضعه داخل النافذة المأذونة");
        }
        else if (!Contains(s.Rect, rect))
        {
            throw new HelperError("not_allowed", "العنصر خارج مستطيل النافذة المأذونة كلياً أو جزئياً");
        }
        var role = RoleOf(controlType);
        var current = name ?? "";
        if (role != entry.Role || current != entry.Name || !SameRect(rect, entry.Rect))
        {
            throw new HelperError("target_changed", "تغيّر العنصر منذ اللقطة: خذ لقطة جديدة")
            {
                Was = Describe(entry.Role, entry.Name),
                Now = Describe(role, current),
            };
        }
        return rect;
    }

    private static bool IsEmpty(UiaRect r) => r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0;

    // احتواء كامل؛ الحافة الملامسة داخلة (مطابق لـcontains في desktopguard.js)
    private static bool Contains(UiaRect outer, UiaRect r) =>
        r.Left >= outer.Left && r.Top >= outer.Top && r.Right <= outer.Right && r.Bottom <= outer.Bottom;

    private static bool SameRect(UiaRect a, UiaRect b) =>
        (IsEmpty(a) && IsEmpty(b)) || (a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom);

    private static string Describe(string role, string name) =>
        role + " \"" + (name.Length <= DescribeLimit ? name : name.Substring(0, DescribeLimit) + "…") + "\"";

    private static T? TryPattern<T>(IUIAutomationElement el, int patternId) where T : class
    {
        nint ptr = 0;
        Act(() => el.GetCurrentPattern(patternId, out ptr));
        if (ptr == 0) return null;
        try { return (T)Wrappers.GetOrCreateObjectForComInstance(ptr, CreateObjectFlags.UniqueInstance); }
        finally { Marshal.Release(ptr); }
    }

    private static T PatternOf<T>(IUIAutomationElement el, int patternId, string patternName) where T : class =>
        TryPattern<T>(el, patternId) ?? throw new HelperError("unsupported_pattern", "العنصر لا يدعم " + patternName);

    // أقرب عنصر قابل للتمرير عمودياً من العنصر صعوداً — والسلف خارج النافذة المأذونة يوقف المشي
    // (جذر سطح المكتب بمستطيل الشاشة خارجها دائماً)
    private static IUIAutomationScrollPattern? FindScrollable(IUIAutomationElement start, UiaRect bounds)
    {
        Uia().get_ControlViewWalker(out var walker);
        IUIAutomationElement? el = start;
        for (var level = 0; el != null && level <= MaxScrollAncestors; level++)
        {
            var current = el;
            if (level > 0)
            {
                UiaRect r = default;
                Act(() => current.get_CurrentBoundingRectangle(out r));
                if (IsEmpty(r) || !Contains(bounds, r)) return null;
            }
            var pattern = TryPattern<IUIAutomationScrollPattern>(current, Native.ScrollPatternId);
            if (pattern != null)
            {
                var scrollable = 0;
                Act(() => pattern.get_CurrentVerticallyScrollable(out scrollable));
                if (scrollable != 0) return pattern;
            }
            IUIAutomationElement? parent = null;
            Act(() => walker.GetParentElement(current, out parent));
            el = parent;
        }
        return null;
    }

    // مقبض العنصر أو أقرب سلف له مقبض، بشرط أن يكون من شجرة النافذة المختارة نفسها
    private static nint WheelHandle(IUIAutomationElement start, nint sessionHwnd)
    {
        Uia().get_ControlViewWalker(out var walker);
        IUIAutomationElement? el = start;
        for (var level = 0; el != null && level <= MaxScrollAncestors; level++)
        {
            var current = el;
            nint handle = 0;
            Act(() => current.get_CurrentNativeWindowHandle(out handle));
            if (handle != 0) return handle == sessionHwnd || Native.GetAncestor(handle, GaRoot) == sessionHwnd ? handle : sessionHwnd;
            IUIAutomationElement? parent = null;
            Act(() => walker.GetParentElement(current, out parent));
            el = parent;
        }
        return sessionHwnd;
    }

    // ── المفاتيح: قائمة بيضاء ثابتة بنمط browser_press_key، والحروف والأرقام المفردة مع Ctrl/Shift/Alt.
    // لا مفتاح ويندوز ولا F1–F12 (المساعدة وغيرها تفتح خارج النافذة)، وتركيبات مغادرة النافذة ممنوعة.
    private static readonly Dictionary<string, (string Name, ushort Vk, bool Extended)> NamedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Enter"] = ("Enter", 0x0D, false),
        ["Return"] = ("Enter", 0x0D, false),
        ["Tab"] = ("Tab", 0x09, false),
        ["Escape"] = ("Escape", 0x1B, false),
        ["Esc"] = ("Escape", 0x1B, false),
        ["Space"] = ("Space", 0x20, false),
        ["Backspace"] = ("Backspace", 0x08, false),
        ["Delete"] = ("Delete", 0x2E, true),
        ["Del"] = ("Delete", 0x2E, true),
        ["Home"] = ("Home", 0x24, true),
        ["End"] = ("End", 0x23, true),
        ["PageUp"] = ("PageUp", 0x21, true),
        ["PageDown"] = ("PageDown", 0x22, true),
        ["ArrowUp"] = ("ArrowUp", 0x26, true),
        ["Up"] = ("ArrowUp", 0x26, true),
        ["ArrowDown"] = ("ArrowDown", 0x28, true),
        ["Down"] = ("ArrowDown", 0x28, true),
        ["ArrowLeft"] = ("ArrowLeft", 0x25, true),
        ["Left"] = ("ArrowLeft", 0x25, true),
        ["ArrowRight"] = ("ArrowRight", 0x27, true),
        ["Right"] = ("ArrowRight", 0x27, true),
    };
    private const ushort VkControl = 0x11;
    private const ushort VkShift = 0x10;
    private const ushort VkAlt = 0x12;
    private const ushort VkTab = 0x09;
    private const ushort VkEscape = 0x1B;
    private const ushort VkSpace = 0x20;
    private const ushort VkDelete = 0x2E;

    private static KeyChord ParseKeys(string keys)
    {
        const string format = "مفتاح غير مدعوم: الصيغة مثل Enter أو Ctrl+S (استعمل الأسماء المذكورة في وصف الأداة)";
        if (keys.Length == 0 || keys.Length > 32) throw new HelperError("bad_key", format);
        var parts = keys.Split('+');
        if (parts.Length > 4) throw new HelperError("bad_key", format);
        bool ctrl = false, shift = false, alt = false;
        for (var i = 0; i < parts.Length - 1; i++)
        {
            var m = parts[i].Trim();
            if (m.Equals("Ctrl", StringComparison.OrdinalIgnoreCase) || m.Equals("Control", StringComparison.OrdinalIgnoreCase))
            {
                if (ctrl) throw new HelperError("bad_key", format);
                ctrl = true;
            }
            else if (m.Equals("Shift", StringComparison.OrdinalIgnoreCase))
            {
                if (shift) throw new HelperError("bad_key", format);
                shift = true;
            }
            else if (m.Equals("Alt", StringComparison.OrdinalIgnoreCase))
            {
                if (alt) throw new HelperError("bad_key", format);
                alt = true;
            }
            else if (m.Equals("Win", StringComparison.OrdinalIgnoreCase) || m.Equals("Meta", StringComparison.OrdinalIgnoreCase)
                || m.Equals("Super", StringComparison.OrdinalIgnoreCase) || m.Equals("Cmd", StringComparison.OrdinalIgnoreCase))
            {
                throw new HelperError("bad_key", "مفتاح ويندوز ممنوع: يفتح ما هو خارج النافذة المختارة");
            }
            else
            {
                throw new HelperError("bad_key", format);
            }
        }
        var main = parts[^1].Trim();
        string name;
        ushort vk;
        bool extended;
        if (NamedKeys.TryGetValue(main, out var named))
        {
            (name, vk, extended) = named;
        }
        else if (main.Length == 1 && char.IsAsciiLetterOrDigit(main[0]))
        {
            name = main.ToUpperInvariant();
            vk = name[0];
            extended = false;
        }
        else
        {
            throw new HelperError("bad_key", format);
        }
        var canonical = (ctrl ? "Ctrl+" : "") + (shift ? "Shift+" : "") + (alt ? "Alt+" : "") + name;
        // تبديل النوافذ وقائمة ابدأ ومدير المهام وشاشة الأمان وقائمة النظام: كلها تغادر النافذة المختارة
        if ((alt && (vk == VkTab || vk == VkEscape || vk == VkSpace)) || (ctrl && vk == VkEscape) || (ctrl && alt && vk == VkDelete))
            throw new HelperError("not_allowed", "تركيبة تغادر النافذة المختارة: " + canonical);
        return new KeyChord(canonical, ctrl, shift, alt, vk, extended);
    }

    // المقدّمة شرط الإرسال: SendInput يصل النافذة الأمامية أيّاً كانت، فالتحقق يسبقه ولا يُفترض
    private static void Focus(Session s)
    {
        if (Native.IsIconic(s.Hwnd)) throw new HelperError("focus_failed", "النافذة المختارة مصغّرة: لم تُرسل المفاتيح");
        if (Native.GetForegroundWindow() == s.Hwnd) return;
        try { s.Root.SetFocus(); } catch (Exception e) when (!IsGone(e)) { /* قد يرفضه النظام — الطرق التالية */ }
        if (WaitForeground(s.Hwnd, 100)) return;
        Native.SetForegroundWindow(s.Hwnd);
        if (WaitForeground(s.Hwnd, 100)) return;
        // قفل المقدّمة: ربط طابور إدخالنا بخيط النافذة الأمامية مؤقتاً يرفع القفل عن هذا النداء وحده
        var foreground = Native.GetForegroundWindow();
        var foregroundThread = foreground == 0 ? 0u : Native.GetWindowThreadProcessId(foreground, out _);
        var self = Native.GetCurrentThreadId();
        if (foregroundThread != 0 && foregroundThread != self && Native.AttachThreadInput(self, foregroundThread, true))
        {
            try
            {
                Native.SetForegroundWindow(s.Hwnd);
                Native.BringWindowToTop(s.Hwnd);
            }
            finally
            {
                Native.AttachThreadInput(self, foregroundThread, false);
            }
        }
        if (WaitForeground(s.Hwnd, FocusWaitMs)) return;
        throw new HelperError("focus_failed", "تعذّر جلب النافذة المختارة إلى الأمام: لم تُرسل المفاتيح كي لا تصل نافذة أخرى");
    }

    private static bool WaitForeground(nint hwnd, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (true)
        {
            if (Native.GetForegroundWindow() == hwnd) return true;
            if (sw.ElapsedMilliseconds >= timeoutMs) return false;
            Thread.Sleep(20);
        }
    }

    private static unsafe void SendChord(KeyChord chord, nint hwnd)
    {
        var keys = new List<(ushort Vk, bool Extended)>();
        if (chord.Ctrl) keys.Add((VkControl, false));
        if (chord.Shift) keys.Add((VkShift, false));
        if (chord.Alt) keys.Add((VkAlt, false));
        keys.Add((chord.Vk, chord.Extended));
        var inputs = new Input[keys.Count * 2];
        var n = 0;
        foreach (var k in keys) inputs[n++] = KeyInput(k.Vk, k.Extended, up: false);
        for (var i = keys.Count - 1; i >= 0; i--) inputs[n++] = KeyInput(keys[i].Vk, keys[i].Extended, up: true);
        // إعادة فحص المقدّمة ملاصقة للإرسال (المراجعة الأمنية): تضيّق فسحة خطف التركيز بعد Focus إلى
        // نداءين متتاليين — ولا تغلقها كلياً لأن SendInput نفسه غير ذرّي مع الفحص (حدّ مُصرَّح به)
        if (Native.GetForegroundWindow() != hwnd)
            throw new HelperError("focus_failed", "خُطف التركيز من النافذة المختارة قبل الإرسال: لم تُرسل المفاتيح");
        uint sent;
        fixed (Input* first = inputs) sent = Native.SendInput((uint)inputs.Length, first, sizeof(Input));
        if (sent == inputs.Length) return;
        // إرسال جزئي قد يترك معدِّلاً مضغوطاً: رفعٌ صريح لكل المفاتيح قبل الإعلان
        var ups = new Input[keys.Count];
        for (var i = 0; i < keys.Count; i++) ups[i] = KeyInput(keys[i].Vk, keys[i].Extended, up: true);
        fixed (Input* first = ups) Native.SendInput((uint)ups.Length, first, sizeof(Input));
        throw new HelperError("not_allowed", "رفض النظام الإدخال (نافذة بصلاحيات أعلى من سطر؟): لم تكتمل المفاتيح");
    }

    private static Input KeyInput(ushort vk, bool extended, bool up) => new()
    {
        Type = Native.InputKeyboard,
        U = new InputUnion
        {
            Keyboard = new KeyboardInput
            {
                Vk = vk,
                Scan = (ushort)Native.MapVirtualKeyW(vk, Native.MapVkToVsc),
                Flags = (extended ? Native.KeyEventExtendedKey : 0) | (up ? Native.KeyEventKeyUp : 0),
            },
        },
    };

    // BGRA من الأعلى إلى الأسفل ⇒ RGB، مع تصغير بمعامل صحيح (متوسط كل مربع k×k) إن لزم
    private static byte[] ToRgb(byte[] bgra, int width, int height, int k, out int outWidth, out int outHeight)
    {
        outWidth = Math.Max(1, width / k);
        outHeight = Math.Max(1, height / k);
        var rgb = new byte[outWidth * outHeight * 3];
        for (var y = 0; y < outHeight; y++)
        {
            for (var x = 0; x < outWidth; x++)
            {
                int r = 0, g = 0, b = 0, count = 0;
                for (var dy = 0; dy < k && y * k + dy < height; dy++)
                {
                    for (var dx = 0; dx < k && x * k + dx < width; dx++)
                    {
                        var i = ((y * k + dy) * width + (x * k + dx)) * 4;
                        b += bgra[i];
                        g += bgra[i + 1];
                        r += bgra[i + 2];
                        count++;
                    }
                }
                var o = (y * outWidth + x) * 3;
                rgb[o] = (byte)(r / count);
                rgb[o + 1] = (byte)(g / count);
                rgb[o + 2] = (byte)(b / count);
            }
        }
        return rgb;
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

    // {x, y, w, h} أعداد صحيحة بعرض وارتفاع موجبين ⇒ RECT
    private static UiaRect? RectParam(JsonObject o, string key)
    {
        if (o[key] is not JsonObject r) return null;
        var x = IntParam(r, "x");
        var y = IntParam(r, "y");
        var w = IntParam(r, "w");
        var h = IntParam(r, "h");
        if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) return null;
        return new UiaRect { Left = x.Value, Top = y.Value, Right = x.Value + w.Value, Bottom = y.Value + h.Value };
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
        public string? Was { get; init; }
        public string? Now { get; init; }
        public HelperError(string code, string message) : base(message) { Code = code; }
    }

    private sealed class TargetEntry(IUIAutomationElement element, nint hwnd, int pid)
    {
        public IUIAutomationElement Element { get; } = element;
        public nint Hwnd { get; } = hwnd;
        public int Pid { get; } = pid;
    }

    private sealed class SnapEntry(IUIAutomationElement element, string role, string name, UiaRect rect)
    {
        public IUIAutomationElement Element { get; } = element;
        public string Role { get; } = role;
        public string Name { get; } = name;
        public UiaRect Rect { get; } = rect;
    }

    private sealed class Session(string targetId, nint hwnd, int pid, UiaRect rect, IUIAutomationElement root)
    {
        public string TargetId { get; } = targetId;
        public nint Hwnd { get; } = hwnd;
        public int Pid { get; } = pid;
        public UiaRect Rect { get; } = rect;
        public IUIAutomationElement Root { get; } = root;
    }

    private sealed record KeyChord(string Canonical, bool Ctrl, bool Shift, bool Alt, ushort Vk, bool Extended);
}

// مشفّر PNG أدنى بلا System.Drawing (غير متاح في NativeAOT): IHDR + IDAT (zlib بلا مرشّح) + IEND
internal static class Png
{
    private static readonly uint[] CrcTable = BuildCrcTable();

    public static byte[] Encode(byte[] rgb, int width, int height)
    {
        using var output = new MemoryStream();
        output.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
        var ihdr = new byte[13];
        WriteBigEndian(ihdr, 0, (uint)width);
        WriteBigEndian(ihdr, 4, (uint)height);
        ihdr[8] = 8; // عمق 8 بت
        ihdr[9] = 2; // RGB بلا شفافية: PrintWindow يترك قناة ألفا صفراً فتصير الصورة شفافة لو حُملت
        WriteChunk(output, "IHDR", ihdr);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Optimal, leaveOpen: true))
        {
            var stride = width * 3;
            for (var y = 0; y < height; y++)
            {
                zlib.WriteByte(0);
                zlib.Write(rgb, y * stride, stride);
            }
        }
        WriteChunk(output, "IDAT", compressed.ToArray());
        WriteChunk(output, "IEND", Array.Empty<byte>());
        return output.ToArray();
    }

    private static void WriteChunk(Stream output, string type, byte[] data)
    {
        var length = new byte[4];
        WriteBigEndian(length, 0, (uint)data.Length);
        output.Write(length);
        var typeBytes = Encoding.ASCII.GetBytes(type);
        output.Write(typeBytes);
        output.Write(data);
        var crc = Crc(Crc(0xFFFFFFFFu, typeBytes), data) ^ 0xFFFFFFFFu;
        var crcBytes = new byte[4];
        WriteBigEndian(crcBytes, 0, crc);
        output.Write(crcBytes);
    }

    private static uint Crc(uint crc, byte[] data)
    {
        foreach (var b in data) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc;
    }

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }

    private static void WriteBigEndian(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)(value >> 24);
        buffer[offset + 1] = (byte)(value >> 16);
        buffer[offset + 2] = (byte)(value >> 8);
        buffer[offset + 3] = (byte)value;
    }
}
