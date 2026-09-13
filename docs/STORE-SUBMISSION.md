# رفع حزمة سطر إلى Microsoft Store — مسبار جدوى

## الخلاصة أولاً

**الرفع الآلي لا يُرجَّح أن يعمل بحساب مطوّر فردي، والأتمتة تنتظر حساب شركة.** السبب
سلسلة موثَّقة لا استنتاج: واجهة `Microsoft Store submission API` تشترط قبل أي نداء أن
يكون لدى الحساب **مستأجر Microsoft Entra ID مرتبط بـPartner Center**، وأن يُضاف
**تطبيق Entra** في صفحة «Users» ويُمنح دور **Manager**، ومن صفحة ذلك التطبيق وحدها
تُقرأ `Tenant ID` و`Client ID` ويُولَّد `Key` — وهي الأسرار الثلاثة التي لا تعمل الواجهة
بدونها. لكن توثيق Partner Center يقول صراحةً إن إضافة المستخدمين متاحة
**for Company accounts (linked to Entra ID)** وإن **«Individual accounts do not support
multiple users»**، وإن **«Individual developer accounts must use a personal Microsoft
account»**. وحساب سطر فردي (الناشر `Moxa`، ‏Store ID ‏`9N7F5RKQJ9WF`).

⚠️ **غير متحقَّق**: مايكروسوفت **لا تنصّ حرفياً** في أي صفحة اطُّلع عليها على أن واجهة
الرفع ممنوعة على الحساب الفردي. الممنوع المنصوص عليه هو **تعدّد المستخدمين**، وربط
المستأجر موصوف بلغة المؤسسات (**«your organization's Microsoft Entra ID»**) لا بلغة
منع صريح. فالاستنتاج أعلاه **ترجيح مبنيّ على شرطٍ موثَّق يبدو غير قابل للاستيفاء**، لا
حكم منقول. الحسم الوحيد بيد المالك: فتح
`Partner Center → Account settings → Tenants` ورؤية هل يظهر زرّ
**«Associate Microsoft Entra ID with your Partner Center account»** ويعمل على هذا
الحساب. تلك تجربة دقيقتين تُغني عن كل تخمين — وحتى تُجرى تبقى هذه الوثيقة **مسبار جدوى
لا خطة تنفيذ**.

ولذلك: **لا سكربت رفع في هذه الدفعة.** كتابة أداة لمسارٍ قد يكون مغلقاً على حسابنا
تُنتج كوداً لا يستطيع أحد تشغيله ولا اختباره حياً — وهو بالضبط «الحارس الأخضر الكاذب»
بصيغة أخرى. المسار العملي الآن هو **الرفع اليدوي** (القسم الرابع)، والمسار الآلي
موثَّق كاملاً (القسم الثالث) ليُنفَّذ في يوم واحد متى توفّر الحساب.

---

## ١) متطلبات المرة الواحدة بيد المالك

كل بند بمصدره الرسمي وتاريخ الاطلاع. البنود ١–٤ هي بوابة الجدوى؛ ٥–٦ شروط على
التطبيق نفسه وهي **مستوفاة** لسطر أصلاً.

| # | المتطلَّب | ما يقوله المصدر | الصفحة (اطُّلع عليها ‏2026-09-13) | الحالة عندنا |
|---|---|---|---|---|
| ١ | مستأجر Entra ID مع صلاحية Global administrator عليه | «You (or your organization) must have an Azure AD directory and you must have Global administrator permission for the directory.» ويمكن إنشاء مستأجر جديد من داخل Partner Center بلا كلفة إضافية | [create-and-manage-submissions-using-windows-store-services](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) · [create-new-azure-ad-tenant](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/create-new-azure-ad-tenant) | غير معروف — يحتاج فتح الصفحة |
| ٢ | ربط المستأجر بحساب Partner Center | `Account settings → Tenants → Associate Microsoft Entra ID with your Partner Center account`، ثم تسجيل الدخول باعتماد المستأجر وتأكيد اسم النطاق. و«Any user who has the **Manager** role for a Partner Center account can associate Microsoft Entra ID tenants» | [associate-existing-azure-ad-tenant-with-partner-center-account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/associate-existing-azure-ad-tenant-with-partner-center-account) | **البوابة المشكوك فيها** |
| ٣ | إضافة تطبيق Entra في «Users» بدور Manager | «from the **Users** page… add the Azure AD application… Make sure you assign this application the **Manager** role.» والإضافة من `User management → Microsoft Entra applications → Add Microsoft Entra application`، وتتطلب الدخول بحساب Manager يملك Global administrator على المستأجر | [create-and-manage-submissions…](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) · [manage-azure-ad-applications-in-partner-center](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/manage-azure-ad-applications-in-partner-center) | يعتمد على ٢ |
| ٤ | قراءة `Tenant ID`/`Client ID` وتوليد `Key` | «select the application name to review settings… including the Tenant ID, Client ID» ثم «To add a new key, click on **Add new key**… Be sure to print or copy this info, as you won't be able to access it again after you leave this page.» | [manage-azure-ad-applications-in-partner-center](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/manage-azure-ad-applications-in-partner-center) | يعتمد على ٣ |
| ٥ | التطبيق موجود في Partner Center باسم محجوز | «You cannot use the Microsoft Store submission API to create an app in Partner Center; you must work in Partner Center to create it» | [create-and-manage-submissions…](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) | ✅ مستوفى (‏`9N7F5RKQJ9WF`) |
| ٦ | ‏submission واحدة مكتملة سابقاً من الواجهة الرسومية، بما فيها استبيان التصنيف العمري | «you must first create one submission for the app in Partner Center, including answering the age ratings questionnaire. After you do this, you will be able to programmatically create new submissions» | [create-and-manage-submissions…](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) | يستوفيه الرفع اليدوي الأول (القسم ٤) |

### شواهد شقّ «الحساب الفردي»

| الادّعاء | النصّ الحرفي | الصفحة (‏2026-09-13) |
|---|---|---|
| الحساب الفردي لا يدعم تعدّد المستخدمين | «Yes, but only for **Company accounts** (linked to Entra ID)… **Individual accounts** do not support multiple users.» | [manage-users-in-partner-center](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/manage-users-in-partner-center) |
| الحساب الفردي يستعمل حساباً شخصياً لا حساب عمل | «This option is available for company accounts only. Individual developer accounts must use a personal Microsoft account.» و«Entra ID (work account) sign-up is currently supported only for Company accounts.» | [open-a-developer-account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account) |
| إضافة المستخدمين مشروطة بربط المستأجر | «In order to add users to your account, you must first associate your Partner Center account with your organization's Microsoft Entra ID tenant.» | [overview-users-groups-azure-ad-applications](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/overview-users-groups-azure-ad-applications) |
| تحويل الحساب من فردي إلى شركة غير مدعوم | «Changing a developer account from Individual to Company is **not** supported in Partner Center. To publish as a company, you'll need to create a new Company developer account.» | [open-a-developer-account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account) |

البند الأخير يضاعف كلفة القرار: الانتقال إلى الأتمتة ليس ترقية بل **حساب جديد**،
وهوية ناشر أخرى، وإعادة نشر — وهو القيد نفسه المسجَّل في
`docs/internals/41-msix-store-package.md` كقرار مالك في 2026-09-04. فلا تُعاد فتح هذه
المقايضة إلا إذا صار تحديث المتجر عبئاً متكرراً فعلياً.

---

## ٢) قيود معروفة على الواجهة (موثَّقة، وتسري متى فُتح المسار)

- **‏submission معلّقة واحدة فقط.** لا تنصّ الصفحات على العبارة حرفياً، لكن النموذج
  يفرضه: مورد التطبيق يحمل حقلاً مفرداً `pendingApplicationSubmission` واحداً
  («A submission resource that provides information about the current pending submission
  for the app») بجانب `lastPublishedApplicationSubmission`، والعيّنة الرسمية بلغة
  بايثون تبدأ بـ**«it deletes the pending submission for the app, if one exists»** قبل
  إنشاء واحدة جديدة. وإنشاء submission يعيد `409` «because of the current state of the
  app». ⚠️ **غير متحقَّق حرفياً**: نصّ صريح بصيغة «only one pending submission» لم
  أجده؛ الدليل بنيوي وسلوكي لا اقتباس.
  ([get-app-data](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-app-data) ·
  [python-code-examples…](https://learn.microsoft.com/en-us/windows/uwp/monetize/python-code-examples-for-the-windows-store-submission-api) ·
  [create-an-app-submission](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-an-app-submission)، ‏2026-09-13)
- **ما تنسخه الواجهة**: إنشاء submission ينتج **نسخة من آخر submission منشورة** —
  «This method creates a new in-progress submission, which is a copy of your last
  published submission» — ويعيد في جسم الردّ **كل** بيانات الـsubmission: القوائم
  (`listings`) بوصفها وصورها، والتسعير، والفئة، وخيارات النشر، إضافةً إلى
  `fileUploadUrl` و`applicationPackages`.
  ([manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions)، ‏2026-09-13)
- **ما لا يلزم إعادة إرساله**: الوصف واللقطات **تُنسَخ تلقائياً** وتصل بحالة
  `fileStatus: "Uploaded"`، فلا يُعاد رفعها إلا إذا أردت تغييرها. الصور تأخذ قيم
  `fileStatus` نفسها الأربع: `None / PendingUpload / Uploaded / PendingDelete`.
  ([manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions)، ‏2026-09-13)
- **ما يجب إعادة إرساله فعلاً**: **الحزمة** وحدها في حالتنا — الحزمة القديمة تُعلَّم
  `PendingDelete` والجديدة تُضاف `PendingUpload`، وتُرفع داخل أرشيف ZIP. وعند التحديث
  يكفي من كل حزمة **أربعة حقول**: «only the *fileName*, *fileStatus*,
  *minimumDirectXVersion*, and *minimumSystemRam* values of this object are required in
  the request body. The other values are populated by Partner Center.»
  ([manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions) ·
  [update-an-app-submission](https://learn.microsoft.com/en-us/windows/uwp/monetize/update-an-app-submission)، ‏2026-09-13)
- **لا تخلط الواجهتين**: «If you use Partner Center to change a submission that you
  originally created by using the API, you will no longer be able to change or commit
  that submission by using the API… you must delete the submission and create a new
  submission.»
  ([create-and-manage-submissions…](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)، ‏2026-09-13)
- **الرمز يعيش 60 دقيقة**: «After you obtain a token, you have 60 minutes to use this
  token in calls to the Microsoft Store submission API before the token expires.» ودورة
  الرفع كلها أقصر من ذلك عادةً، لكن الاستطلاع الطويل حتى `Published` يتجاوزها فيلزم
  رمز جديد.
  ([create-and-manage-submissions…](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)، ‏2026-09-13)
- **مدّة الاعتماد**: «This process can take up to three business days. After your
  submission passes certification, on average, customers will be able to see the app's
  listing within 15 minutes.»
  ([app-certification-process](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process)، ‏2026-09-13)
- **حدّان يبطلان الواجهة أصلاً**: التطبيقات التي تستعمل
  *mandatory app updates* أو *Store-managed consumable add-ons* تعيد `409`؛ والتطبيقات
  على *Pricing Version 2* تعيد طبقة تسعير مجهولة (ويبقى ما عدا التسعير قابلاً
  للتحديث). ⚠️ **غير مقيس**: هل سطر على Pricing Version 2؟ يُعرف من وجود زرّ
  **Review price per market** في صفحة التسعير.
  ([create-and-manage-submissions…](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)، ‏2026-09-13)

---

## ٣) المسار الموثَّق حين يتوفّر الحساب

ست خطوات، كلٌّ منها بمصدره. الجذر في كل النداءات
`https://manage.devcenter.microsoft.com/v1.0/my/applications/{applicationId}`،
و`{applicationId}` هو **Store ID** نصّاً: «applicationId | string | Required. The Store
ID of the app to retrieve».
([manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions) ·
[get-an-app](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app)، ‏2026-09-13)

### ١. الرمز — Azure AD client credentials

```http
POST https://login.microsoftonline.com/<tenant_id>/oauth2/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded; charset=utf-8

grant_type=client_credentials
&client_id=<your_client_id>
&client_secret=<your_client_secret>
&resource=https://manage.devcenter.microsoft.com
```

«For the *resource* parameter, you must specify `https://manage.devcenter.microsoft.com`».
ويُمرَّر بعدها في ترويسة `Authorization: Bearer <token>` في كل نداء.
([create-and-manage-submissions…](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) ·
[get-an-app](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app)، ‏2026-09-13)

**أسماء الأسرار في CI** (اصطلاحنا لا نصّ مايكروسوفت): ثلاثة
`GitHub → Settings → Secrets and variables → Actions → Repository secrets` باسم
`STORE_TENANT_ID` · `STORE_CLIENT_ID` · `STORE_CLIENT_SECRET`، تُقرأ من البيئة وحدها ولا
تُطبع. ومفتاح Entra له تاريخ انتهاء يظهر في صفحة التطبيق («including the date on which
the key was created and when it will expire») فيلزم تدويره قبل انتهائه وإلا سقط الإصدار
التالي بلا سبب ظاهر.

### ٢. قراءة التطبيق

```http
GET /v1.0/my/applications/9N7F5RKQJ9WF
Authorization: Bearer <token>
```

يعيد `id` · `primaryName` · `packageIdentityName` · `packageFamilyName` ·
`publisherName` · `lastPublishedApplicationSubmission` · `pendingApplicationSubmission`.
ووجود الأخير هو **علامة التوقف**: تُحذف أولاً
(`DELETE /v1.0/my/applications/{applicationId}/submissions/{submissionId}`) كما تفعل
العيّنة الرسمية.
([get-an-app](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app) ·
[manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions) ·
[python-code-examples…](https://learn.microsoft.com/en-us/windows/uwp/monetize/python-code-examples-for-the-windows-store-submission-api)، ‏2026-09-13)

### ٣. إنشاء submission بنسخ الأخيرة

```http
POST /v1.0/my/applications/9N7F5RKQJ9WF/submissions
Authorization: Bearer <token>
```

بلا جسم طلب («Do not provide a request body for this method»). الردّ يحمل `id` الجديد
و`fileUploadUrl` (عنوان SAS إلى Azure Blob Storage) و`status: "PendingCommit"` وكل بيانات
الـsubmission المنسوخة.
([create-an-app-submission](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-an-app-submission)، ‏2026-09-13)

### ٤. تحديث قائمة الحزم — القديمة `PendingDelete` والجديدة `PendingUpload`

```http
PUT /v1.0/my/applications/9N7F5RKQJ9WF/submissions/{submissionId}
Authorization: Bearer <token>
Content-Type: application/json
```

النمط من عيّنة C# الرسمية حرفياً — **القديمة تبقى في المصفوفة موسومة للحذف ولا تُزال
منها**:

```csharp
// Let's say we want to delete the existing package.
clonedSubmission.applicationPackages[0].fileStatus = "PendingDelete";
var packages = new List<dynamic>();
packages.Add(clonedSubmission.applicationPackages[0]);
packages.Add(new {
    fileStatus = "PendingUpload",
    fileName = "package.appx",
    minimumDirectXVersion = "None",
    minimumSystemRam = "None"
});
```

و«If you are adding new files for the submission, make sure you update the submission
data to refer to the name and relative path of these files in the ZIP archive» — أي أن
`fileName` يجب أن يطابق اسم المدخل داخل الأرشيف، وهو عندنا `Satr-Store-<version>.appx`.
([csharp-code-examples…](https://learn.microsoft.com/en-us/windows/uwp/monetize/csharp-code-examples-for-the-windows-store-submission-api) ·
[manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions)، ‏2026-09-13)

### ٥. رفع ZIP إلى `fileUploadUrl`

«Add all of these files to a ZIP archive» ثم «upload the ZIP archive to Azure Blob
Storage using the SAS URI that was provided in the response body of the POST method you
called earlier».

```http
PUT <fileUploadUrl>
x-ms-blob-type: BlockBlob
Content-Length: <طول الأرشيف>
```

`x-ms-blob-type` **إلزامية**: «`x-ms-blob-type: <BlockBlob | PageBlob | AppendBlob>` |
Required. Specifies the type of blob to create»، والنجاح **201 (Created)**. والـSAS تكفي
للتخويل (قسم «Shared access signatures (SAS)» يذكر صراحةً صلاحيتَي Create/Write لعملية
`Put Blob`).

⚠️ **سقف معلن**: هذه **عملية كتابة واحدة**، وسقفها بحسب نسخة الخدمة الموقَّعة في العنوان
(‏`sv=`): ‏**5,000 MiB** للنسخة 2019-12-12 فأحدث، و**256 MiB** لـ2016-05-31…2019-07-07،
و**64 MiB** لما قبلها؛ وتجاوزه يعيد **413 (Request Entity Too Large)**. مثبّت سطر
حالياً ~80 م.ب فهو تحت السقفين الأعلى والأوسط وفوق الأدنى — فإن أعادت Partner Center
عنواناً بنسخة قديمة لزم الرفع بالكتل (`Put Block` + `Put Block List`).
([manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions) ·
[put-blob](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob)، ‏2026-09-13)

### ٦. ‏commit ثم مراقبة الحالة

```http
POST /v1.0/my/applications/9N7F5RKQJ9WF/submissions/{submissionId}/commit
GET  /v1.0/my/applications/9N7F5RKQJ9WF/submissions/{submissionId}/status
```

‏commit يعيد `{"status": "CommitStarted"}`، و«This value should change from
**CommitStarted** to either **PreProcessing** if the request succeeds or to
**CommitFailed** if there are errors in the request. If there are errors, the
*statusDetails* field contains further details about the error.» والعيّنة الرسمية
تستطلع كل **60 ثانية** ما دامت الحالة `CommitStarted`.

**قيم الحالة الخمس عشرة** كما في جدول الردّ:
`None` · `Canceled` · `PendingCommit` · `CommitStarted` · `CommitFailed` ·
`PendingPublication` · `Publishing` · `Published` · `PublishFailed` · `PreProcessing` ·
`PreProcessingFailed` · `Certification` · `CertificationFailed` · `Release` ·
`ReleaseFailed`.

رموز الخطأ المتوقَّعة: `400` طلب غير صالح · `404` غير موجود · `409` حالة التطبيق لا
تسمح أو الحساب يستعمل ميزة غير مدعومة بالواجهة. وترويسة الردّ `MS-CorrelationId` هي ما
تسجّله العيّنات الرسمية في كل نداء وما يطلبه الدعم عند التقصّي.
([commit-an-app-submission](https://learn.microsoft.com/en-us/windows/uwp/monetize/commit-an-app-submission) ·
[get-status-for-an-app-submission](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-status-for-an-app-submission) ·
[manage-app-submissions](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions) ·
[python-code-examples…](https://learn.microsoft.com/en-us/windows/uwp/monetize/python-code-examples-for-the-windows-store-submission-api)، ‏2026-09-13)

> بديل جاهز بدل كتابة عميل من الصفر: **StoreBroker**، وحدة PowerShell مفتوحة من
> مايكروسوفت فوق الواجهة نفسها — «The StoreBroker module is actively used within
> Microsoft as the primary way that many first-party applications are submitted to the
> Store» (<https://github.com/Microsoft/StoreBroker>). تسري عليها **شروط الجدوى نفسها**
> (تحتاج tenant/client/key)، لكنها تُغني عن صيانة كودنا. ⚠️ **غير مقيس**: حيويّة
> المشروع وتوافقه مع Node/Windows عندنا لم يُفحصا.

---

## ٤) الرفع اليدوي الآن — المسار العملي

هذا هو المسار المعتمد حتى إشعار آخر، وهو أيضاً **شرط تفعيل الواجهة لاحقاً** (البند ٦
في جدول المتطلبات).

1. **ابنِ الحزمة**: `npm run dist:appx` ⇒ `Satr-Store-<version>.appx` غير موقّعة عمداً
   (مايكروسوفت توقّعها بنفسها — انظر `docs/internals/41-msix-store-package.md`). و«The
   Microsoft Store automatically signs all MSIX/AppX packages with a Microsoft
   certificate… You don't need to provide your own code signing certificate for Store
   distribution».
2. **ابدأ submission**: من صفحة نظرة التطبيق في Partner Center اضغط **Start
   submission**، فتظهر مسودّة بكل الخطوات. أكمل الأقسام الستة: **Pricing and
   availability** · **Properties** · **Age ratings** (كل الأسئلة إلزامية) ·
   **Packages** (ارفع ملف `.appx`) · **Store listings** (الوصف ولقطة واحدة على الأقلّ
   إلزاميان) · **Submission options**. في تحديثات الإصدار لا يتغيّر عادةً غير
   **Packages** و**What's new in this version**.
3. **أرسل**: «Once you have completed all the sections, you can submit your app for
   certification by clicking **Submit for certification** button on the Application
   overview page.»

ثم **الاعتماد حتى ثلاثة أيام عمل** («This process can take up to three business days»)،
وبعد اجتيازه تظهر القائمة للعملاء خلال **~15 دقيقة** وسطياً، وتصير حالة التطبيق
**In the Store**. ملاحظة مفيدة من الصفحة نفسها: قسم **Packages** يبقى «Incomplete» حتى
تُملأ كل الحقول الإلزامية حتى لو ظهرت الحزمة نفسها **Validated**.
([create-app-submission (MSIX)](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission) ·
[app-certification-process](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process)، ‏2026-09-13)

---

## ٥) ما لم يُقَس

الفصل بين ما قرأتُه وما خمّنته — وبلا هذا القسم تصير الوثيقة أوثق ممّا تستحق.

1. **هل يعمل ربط مستأجر Entra على حسابنا الفردي فعلاً؟** لم يُجرَّب. لا صفحة تمنعه
   حرفياً ولا صفحة تُجيزه للفردي. **هذا السؤال الوحيد الذي يحسم الوثيقة كلها**،
   وجوابه بفتح `Account settings → Tenants`.
2. **لم يُنفَّذ أي نداء حقيقي.** لا رمز استُخرج ولا `GET /applications/9N7F5RKQJ9WF`
   نُفِّذ. كل ما ورد أعلاه **منقول من التوثيق** لا مرصود من الشبكة.
3. **نسخة الـSAS التي تعيدها Partner Center فعلياً** (`sv=` في `fileUploadUrl`) غير
   معروفة، وعليها يتوقّف سقف الرفع بعملية واحدة (٦٤ م.ب أم ٢٥٦ أم ٥٠٠٠).
4. **هل سطر على Pricing Version 2؟** غير مفحوص؛ لو كان كذلك فالتسعير غير قابل
   للتحديث بالواجهة.
5. **العبارة الحرفية «submission معلّقة واحدة»** لم أجدها؛ استنتجتها من مفردية الحقل
   ومن سلوك العيّنة الرسمية.
6. **StoreBroker**: لم يُفحص حالُه ولا توافقه.
7. **كلفة القرار البديل** (حساب شركة جديد) مذكورة من التوثيق كمنع تحويل، لكن أثرها على
   هوية الناشر وسلسلة التحديث عند المستخدمين الحاليين **لم يُقَس** — وهو ما يجعل
   السؤال قراراً تجارياً للمالك لا مسألة تقنية.
8. **الوثيقة كلها من مصدر واحد**: توثيق مايكروسوفت الرسمي بتاريخ اطلاع 2026-09-13. لم
   تُستشَر منتديات ولا تجارب طرف ثالث، فما فيها صحيح بقدر صحّة ذلك التوثيق وحداثته.

---

## المراجع

كلها من `learn.microsoft.com`، وتاريخ الاطلاع على جميعها **2026-09-13**.

**الواجهة البرمجية**
1. <https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services>
2. <https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions>
3. <https://learn.microsoft.com/en-us/windows/uwp/monetize/get-app-data>
4. <https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app>
5. <https://learn.microsoft.com/en-us/windows/uwp/monetize/create-an-app-submission>
6. <https://learn.microsoft.com/en-us/windows/uwp/monetize/update-an-app-submission>
7. <https://learn.microsoft.com/en-us/windows/uwp/monetize/commit-an-app-submission>
8. <https://learn.microsoft.com/en-us/windows/uwp/monetize/get-status-for-an-app-submission>
9. <https://learn.microsoft.com/en-us/windows/uwp/monetize/csharp-code-examples-for-the-windows-store-submission-api>
10. <https://learn.microsoft.com/en-us/windows/uwp/monetize/python-code-examples-for-the-windows-store-submission-api>

**التخزين**
11. <https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob>

**‏Partner Center والحساب**
12. <https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/associate-existing-azure-ad-tenant-with-partner-center-account>
13. <https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/create-new-azure-ad-tenant>
14. <https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/manage-azure-ad-applications-in-partner-center>
15. <https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/manage-users-in-partner-center>
16. <https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/overview-users-groups-azure-ad-applications>
17. <https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account>

**النشر والاعتماد**
18. <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission>
19. <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process>
