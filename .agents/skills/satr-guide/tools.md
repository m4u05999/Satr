# كتالوج أدوات «سطر» (مولّد آلياً)

> يولّده `npm run gen:satr-guide` من تعريفات الأدوات الفعلية في الكود — **لا
> تحرّره يدوياً**؛ حارس `npm run test:satr-guide` يفشل عند أي انحراف عنها.

## أدوات المعاينة والمتصفح المدمج

متاحة لمحركي Claude وCodex (نفس المفردات). الأفعال المؤثرة تمرّ بمربع الإذن
العربي ما لم يفعّل المستخدم «وضع تحكم المتصفح» 🖱️ صراحةً.

- **`open_preview`** — اعرض عنوان ويب (عادةً خادم تطوير محلي http://localhost:…) في لوحة المعاينة المدمجة داخل «سطر». استعملها بعد تشغيل خادم المشروع بدل فتح متصفح خارجي.
- **`browser_navigate`** — انتقل بلوحة المعاينة القائمة إلى عنوان http/https آخر (بلا إعادة فتح).
- **`read_page`** — اقرأ محتوى الصفحة المعروضة في المعاينة (بنية نصية: العنوان والعناوين والروابط والأزرار والحقول ومقتطف نصّها) لتفحص ما بنيته وتتحقق منه. قراءة فقط.
- **`browser_snapshot`** — خذ لقطة بنيوية للعناصر التفاعلية في الصفحة المعروضة: كل عنصر بصيغة [ref] role "name" — طريقتك لمعرفة ما يمكن قراءته/التفاعل معه. قراءة فقط.
- **`browser_console`** — اقرأ رسائل console الصفحة المعروضة (بما فيها الأخطاء غير الملتقطة) وأخطاء طلبات الشبكة الفاشلة — لتشخيص لماذا لا تعمل صفحة بنيتها. قراءة فقط.
- **`browser_network`** — اعرض سجلّ طلبات الشبكة للصفحة المعروضة: كل طلب مكتمل (الأسلوب/العنوان/رمز الحالة/النوع) والطلبات الفاشلة — لتشخيص مورد لم يُحمَّل أو واجهة رجعت خطأ. قراءة فقط.
- **`screenshot`** — التقط لقطة شاشة للصفحة المعروضة في المعاينة لتراها بصرياً وتتحقق من مظهرها. مرّر full_page=true للصفحة كاملةً بالتمرير. تعيد صورة PNG.
- **`browser_screenshot_element`** — التقط لقطة بصرية لعنصر واحد في الصفحة المعروضة (بـ ref من browser_snapshot أو مُحدِّد CSS) لتفحص مظهره عن قرب — أوفر من لقطة الصفحة كاملة. قراءة فقط.
- **`browser_wait_for`** — انتظر ظهور نصّ معيّن أو عنصر (بمُحدِّد CSS) في الصفحة المعروضة، بمهلة. مفيد بعد نقر أو تنقّل يحمّل محتوى ديناميكياً قبل أخذ لقطة جديدة. مرّر text أو selector. قراءة فقط.
- **`browser_scroll`** — مرّر الصفحة المعروضة لكشف محتوى خارج نافذة العرض (قبل لقطة جديدة). direction: down/up/top/bottom.
- **`browser_hover`** — حوّم المؤشر فوق عنصر لإظهار قائمة/محتوى يظهر عند التحويم. مرّر ref (من browser_snapshot) أو مُحدِّد CSS.
- **`browser_click`** — انقر عنصراً في الصفحة المعروضة. مرّر **ref** من browser_snapshot (مثل e5 — حتمي ومُفضَّل) أو مُحدِّد CSS. أعد أخذ اللقطة بعد النقر (الـ ref يتغيّر).
- **`browser_type`** — اكتب نصاً في حقل إدخال بالصفحة المعروضة. مرّر **ref** من browser_snapshot (مثل e7) أو مُحدِّد CSS، مع النص. لملء النماذج بعد browser_snapshot.
- **`browser_select_option`** — اختر خياراً من قائمة منسدلة <select>. مرّر ref (من browser_snapshot) أو مُحدِّد CSS، مع value الخيار أو نصّه الظاهر.
- **`browser_press_key`** — اضغط مفتاحاً على العنصر المركّز في الصفحة (بعد browser_click لتركيزه). لإرسال نموذج بـ Enter أو التنقّل بـ Tab/الأسهم. للكتابة استعمل browser_type.
- **`browser_handoff`** — سلّم قيادة المعاينة للمستخدم ليكمل خطوة بيده داخل متصفح «سطر» (تسجيل دخول، كلمة مرور، رمز تحقق 2FA أو بيانات حساسة) ثم انتظر ضغطه «استلمت». استعملها بدل طلب بيانات حساسة في المحادثة وبدل إحالة المستخدم لمتصفح خارجي. أثناء التسليم كل أدوات المعاينة معلّقة ولا ترى الصفحة. بعد الاستلام خذ browser_snapshot جديداً وأكمل.

## أدوات حلقة الوكيل للمحوّلات (DeepSeek/Gemini/Qwen/MiniMax…)

محرك Claude يملك مقابلاتها الأصلية (Read/Grep/Edit/Bash…) مع run_in_terminal
للتنفيذ في الطرفية المرئية؛ الكتابة والتنفيذ خلف مربع الإذن دائماً.

- **`read_file`** — Read a text file from the user's project. Use it to inspect code before answering. Path must be relative to the project root (e.g. src/index.html).
- **`list_files`** — List the files of the user's project as relative paths, one per line. Use it to discover the project structure before reading files.
- **`search_code`** — Search all project files for text (grep-like). Returns matching lines as path:line: excerpt, best-matching files first. Matching is lenient: case-insensitive, Arabic diacritics and letter variants ignored, and substrings match inside identifiers (searching 'save viewer' finds saveFromViewer). Use it to locate where something is defined or handled instead of reading whole files.
- **`repo_map`** — Build a compact approximate map of the user's repository before choosing files to read. Returns prioritized file paths and prominent regex-detected definitions (function/class/const/export) with line numbers. This is an estimate, not a parser; verify with search_code and read_file before editing.
- **`verification_config`** — Read the explicit .satr/verify.json checks approved for this project. This only reads configuration and never runs commands.
- **`verify_project`** — Run configured verification checks from .satr/verify.json in the visible terminal after user permission. Never invent commands. Provide the exact ledger task title so evidence can be linked.
- **`update_task_ledger`** — Create or update the visible persistent task plan. Include status, dependencies, owner, and concrete verification evidence when available. Use replace for a complete plan and merge for incremental updates.
- **`propose_memory`** — Propose one durable project memory for explicit user review. This never saves by itself. Use only for a fact, decision, reusable command, or failure lesson that will matter in later turns. Never include secrets. Mark shareable team knowledge so the UI recommends AGENTS.md or a Skill instead.
- **`load_skill`** — Load the instructions for one enabled Satr Agent Skill when its description matches the current task. Skills use progressive disclosure: call this only when relevant. Bundled scripts are resources to inspect, never automatic commands.
- **`read_skill_resource`** — Read one text resource bundled with an enabled Agent Skill after load_skill lists it. The path must be relative to that skill directory. This reads content only and never executes scripts.
- **`write_file`** — Create a new file or completely overwrite an existing file in the user's project. The user is asked for permission first. Prefer edit_file for small changes to existing files.
- **`delete_file`** — Delete a file from the user's project. The user is asked for permission first. This is reliable for any filename (including Arabic names) — prefer it over shell commands like del/rm for deleting files.
- **`run_command`** — Run a single-line shell command (PowerShell on Windows) in the user's visible terminal and return its output. The user must approve each command. Long-running interactive apps (servers) will be cut by the timeout.
- **`edit_file`** — Edit an existing file by exact string replacement. old_string must match the file content exactly (including whitespace) and must be unique unless replace_all is true. The user is asked for permission first.

