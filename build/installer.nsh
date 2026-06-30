; سطر — تخصيص مثبّت NSIS (يُضمّ تلقائياً من electron-builder كـ build/installer.nsh)
;
; المشكلة: على ويندوز غير عربي، يضبط NSIS المتغيّر $LANGUAGE تلقائياً على لغة
; واجهة النظام (مثلاً 1033 إنجليزية)، وقد يقرأ لغة محفوظة من تثبيت سابق، فتظهر
; الواجهة بالإنجليزية رغم تحميل العربية فقط.
;
; الحل: نفرض LangID العربية (1025 = ar-SA) في أبكر نقطة ممكنة داخل .onInit
; (preInit يُحقن قبل أي صفحة واجهة)، فتظهر المعالجة بالعربية على كل اللغات.
; نفعل المثل لـ un.onInit عبر customUnInit كي تكون واجهة الإزالة عربية أيضاً.

!macro preInit
  StrCpy $LANGUAGE 1025
!macroend

!macro customUnInit
  StrCpy $LANGUAGE 1025
!macroend
