// واجهات COM لـUI Automation — المجموعة الدنيا التي تحتاجها التوابع الخمسة، لا أكثر.
//
// ⚠️ المصدر الحرفي لترتيب كل جدول دوال (vtable):
//   Windows SDK 10.0.26100.0 — um\UIAutomationClient.idl (ومنه UIAutomationClient.h).
// GeneratedComInterface يبني الجدول بترتيب **إعلان** التوابع هنا، فخطأ ترتيب واحد يعني
// أن نداءً يصل إلى تابع آخر في الكائن البعيد: انهيار صامت أو قيمة خاطئة بلا أي خطأ.
// لذلك تُعلَن كل التوابع السابقة لآخر تابع مستعمَل — حتى غير المستعمَل منها — بأسمائها
// الأصلية ورقم موضعها، ويُقطع الإعلان بعد آخر تابع نحتاجه (ما بعده لا يؤثّر في المواضع).
// التوابع غير المستعملة تحمل تواقيع مبسّطة (nint) عمداً: لا تُستدعى، ودورها حجز الموضع فقط.
//
// الأرقام الثابتة من UIAutomationClient.h ‏(UIA_*PatternId · UIA_*ControlTypeId · TreeScope)
// ومن UIAutomationCoreApi.h ‏(UIA_E_*).
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;

namespace SatrUia;

// RECT من windef.h — أربعة int بالترتيب left, top, right, bottom
[StructLayout(LayoutKind.Sequential)]
internal struct UiaRect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

// IUIAutomation : IUnknown — uuid(30cbe57d-d9d0-452a-ab13-7ac5ac4825ee) — 55 تابعاً، نستعمل حتى الموضع 19
[GeneratedComInterface]
[Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee")]
internal partial interface IUIAutomation
{
    void CompareElements(nint el1, nint el2, out int areSame);                  // 1
    void CompareRuntimeIds(nint runtimeId1, nint runtimeId2, out int areSame);  // 2
    void GetRootElement(out IUIAutomationElement root);                          // 3 ✔
    void ElementFromHandle(nint hwnd, out nint element);                         // 4
    void ElementFromPoint(long pt, out nint element);                            // 5 (POINT بالقيمة = 8 بايت)
    void GetFocusedElement(out nint element);                                    // 6
    void GetRootElementBuildCache(nint cacheRequest, out nint root);             // 7
    void ElementFromHandleBuildCache(nint hwnd, nint cacheRequest, out nint element); // 8
    void ElementFromPointBuildCache(long pt, nint cacheRequest, out nint element);   // 9
    void GetFocusedElementBuildCache(nint cacheRequest, out nint element);       // 10
    void CreateTreeWalker(nint condition, out nint walker);                      // 11
    void get_ControlViewWalker(out IUIAutomationTreeWalker walker);              // 12 ✔
    void get_ContentViewWalker(out nint walker);                                 // 13
    void get_RawViewWalker(out nint walker);                                     // 14
    void get_RawViewCondition(out nint condition);                               // 15
    void get_ControlViewCondition(out nint condition);                           // 16
    void get_ContentViewCondition(out nint condition);                           // 17
    void CreateCacheRequest(out nint cacheRequest);                              // 18
    void CreateTrueCondition(out IUIAutomationCondition newCondition);           // 19 ✔
}

// IUIAutomationElement : IUnknown — uuid(d22108aa-8ac5-49a5-837b-37bbb3d7591e) — 82 تابعاً، نستعمل حتى الموضع 41
[GeneratedComInterface]
[Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e")]
internal partial interface IUIAutomationElement
{
    void SetFocus();                                                             // 1
    void GetRuntimeId(out nint runtimeId);                                       // 2
    void FindFirst(int scope, nint condition, out nint found);                   // 3
    void FindAll(int scope, IUIAutomationCondition condition, out IUIAutomationElementArray found); // 4 ✔
    void FindFirstBuildCache(int scope, nint condition, nint cacheRequest, out nint found);          // 5
    void FindAllBuildCache(int scope, nint condition, nint cacheRequest, out nint found);            // 6
    void BuildUpdatedCache(nint cacheRequest, out nint updatedElement);          // 7
    void GetCurrentPropertyValue(int propertyId, nint retVal);                   // 8 (VARIANT* — غير مستعمل)
    void GetCurrentPropertyValueEx(int propertyId, int ignoreDefault, nint retVal); // 9
    void GetCachedPropertyValue(int propertyId, nint retVal);                    // 10
    void GetCachedPropertyValueEx(int propertyId, int ignoreDefault, nint retVal);  // 11
    void GetCurrentPatternAs(int patternId, nint riid, out nint patternObject);  // 12
    void GetCachedPatternAs(int patternId, nint riid, out nint patternObject);   // 13
    void GetCurrentPattern(int patternId, out nint patternObject);               // 14 ✔ (IUnknown* خام؛ صفر = غير مدعوم)
    void GetCachedPattern(int patternId, out nint patternObject);                // 15
    void GetCachedParent(out nint parent);                                       // 16
    void GetCachedChildren(out nint children);                                   // 17
    void get_CurrentProcessId(out int retVal);                                   // 18 ✔
    void get_CurrentControlType(out int retVal);                                 // 19 ✔
    void get_CurrentLocalizedControlType(out nint retVal);                       // 20 (BSTR — غير مستعمل)
    void get_CurrentName([MarshalAs(UnmanagedType.BStr)] out string? retVal);    // 21 ✔
    void get_CurrentAcceleratorKey(out nint retVal);                             // 22
    void get_CurrentAccessKey(out nint retVal);                                  // 23
    void get_CurrentHasKeyboardFocus(out int retVal);                            // 24
    void get_CurrentIsKeyboardFocusable(out int retVal);                         // 25 ✔
    void get_CurrentIsEnabled(out int retVal);                                   // 26 ✔
    void get_CurrentAutomationId(out nint retVal);                               // 27
    void get_CurrentClassName(out nint retVal);                                  // 28
    void get_CurrentHelpText(out nint retVal);                                   // 29
    void get_CurrentCulture(out int retVal);                                     // 30
    void get_CurrentIsControlElement(out int retVal);                            // 31
    void get_CurrentIsContentElement(out int retVal);                            // 32
    void get_CurrentIsPassword(out int retVal);                                  // 33 ✔
    void get_CurrentNativeWindowHandle(out nint retVal);                         // 34
    void get_CurrentItemType(out nint retVal);                                   // 35
    void get_CurrentIsOffscreen(out int retVal);                                 // 36
    void get_CurrentOrientation(out int retVal);                                 // 37
    void get_CurrentFrameworkId(out nint retVal);                                // 38
    void get_CurrentIsRequiredForForm(out int retVal);                           // 39
    void get_CurrentItemStatus(out nint retVal);                                 // 40
    void get_CurrentBoundingRectangle(out UiaRect retVal);                       // 41 ✔
}

// IUIAutomationElementArray : IUnknown — uuid(14314595-b4bc-4055-95f2-58f2e42c9855) — تابعان
[GeneratedComInterface]
[Guid("14314595-b4bc-4055-95f2-58f2e42c9855")]
internal partial interface IUIAutomationElementArray
{
    void get_Length(out int length);                                             // 1 ✔
    void GetElement(int index, out IUIAutomationElement element);                // 2 ✔
}

// IUIAutomationTreeWalker : IUnknown — uuid(4042c624-389c-4afc-a630-9df854a541fc) — 13 تابعاً، نستعمل حتى الموضع 4
[GeneratedComInterface]
[Guid("4042c624-389c-4afc-a630-9df854a541fc")]
internal partial interface IUIAutomationTreeWalker
{
    void GetParentElement(nint element, out nint parent);                        // 1
    void GetFirstChildElement(IUIAutomationElement element, out IUIAutomationElement? first);  // 2 ✔
    void GetLastChildElement(nint element, out nint last);                       // 3
    void GetNextSiblingElement(IUIAutomationElement element, out IUIAutomationElement? next);  // 4 ✔
}

// IUIAutomationCondition : IUnknown — uuid(352ffba8-0973-437c-a61f-f64cafd81df9) — بلا توابع خاصة
[GeneratedComInterface]
[Guid("352ffba8-0973-437c-a61f-f64cafd81df9")]
internal partial interface IUIAutomationCondition
{
}

// IUIAutomationInvokePattern : IUnknown — uuid(fb377fbe-8ea6-46d5-9c73-6499642d3059) — تابع واحد
[GeneratedComInterface]
[Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059")]
internal partial interface IUIAutomationInvokePattern
{
    void Invoke();                                                               // 1 ✔
}

// IUIAutomationValuePattern : IUnknown — uuid(a94cd8b1-0844-4cd6-9d2d-640537ab39e9) — 5 توابع، نستعمل حتى الموضع 3
[GeneratedComInterface]
[Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9")]
internal partial interface IUIAutomationValuePattern
{
    void SetValue([MarshalAs(UnmanagedType.BStr)] string val);                   // 1 ✔
    void get_CurrentValue([MarshalAs(UnmanagedType.BStr)] out string? retVal);   // 2 ✔
    void get_CurrentIsReadOnly(out int retVal);                                  // 3 ✔
}

internal static partial class Native
{
    // coclass CUIAutomation من UIAutomationClient.idl
    public static readonly Guid ClsidCUIAutomation = new("ff48dba4-60ef-4201-aa87-54103eef594e");
    public static readonly Guid IidIUIAutomation = new("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee");

    public const int TreeScopeChildren = 0x2;
    public const int InvokePatternId = 10000;
    public const int ValuePatternId = 10002;

    public const int UiaElementNotEnabled = unchecked((int)0x80040200);
    public const int UiaElementNotAvailable = unchecked((int)0x80040201);
    // النافذة أُغلقت بين النداءين: الكائن البعيد انقطع
    public const int RpcDisconnected = unchecked((int)0x80010108);
    public const int RpcServerUnavailable = unchecked((int)0x800706BA);

    public const uint ClsctxInprocServer = 0x1;
    public const uint CoinitMultithreaded = 0x0;
    public const int AppModelErrorNoPackage = 15700;
    public const int ErrorInsufficientBuffer = 122;

    [LibraryImport("ole32.dll")]
    public static partial int CoInitializeEx(nint reserved, uint coInit);

    [LibraryImport("ole32.dll")]
    public static partial int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out nint obj);

    [LibraryImport("kernel32.dll")]
    public static unsafe partial int GetCurrentPackageFullName(ref int length, char* packageFullName);
}
