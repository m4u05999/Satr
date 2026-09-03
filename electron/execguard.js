/** حارس نقي يمنع تسريب الخوادم الطويلة إلى شجرة عملية المحرك الخفية. */

function leafName(toolName) { return String(toolName || '').split('__').pop(); }

function isBackgroundBash(toolName, input) {
  const name = leafName(toolName);
  return (name === 'Bash' || name === 'run_in_terminal')
    && Boolean(input && input.run_in_background === true);
}

function isServerCommand(command) {
  const value = String(command || '').trim();
  if (!value || /[\r\n]/.test(value)) return false;
  const patterns = [
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:dev|start|serve|watch)(?:\s|$)/i,
    /^(?:vite|next\s+dev|nuxt\s+dev|astro\s+dev|ng\s+serve|webpack\s+serve)(?:\s|$)/i,
    /^python(?:3)?\s+-m\s+http\.server(?:\s|$)/i,
    /^php\s+-S(?:\s|$)/i,
    /^flask\s+run(?:\s|$)/i,
    /^rails\s+s(?:erver)?(?:\s|$)/i,
    /^node\s+[^\r\n]*(?:server|serve)\.m?js(?:\s|$)/i,
    /^npx\s+(?:serve|http-server|live-server|json-server)(?:\s|$)/i,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

function buildRedirectMessage() {
  return 'هذا خادم أو أمر طويل يجب أن يعيش في تبويب مرئي مستقل. أعد المحاولة بأداة run_in_background، ثم استخدم open_preview للعرض وget_background_output لقراءة السجل.';
}

function isPowerShell(shell) {
  const name = String(shell || '').trim().replace(/\\/g, '/').split('/').pop().toLowerCase();
  return name === 'powershell.exe' || name === 'pwsh.exe';
}

// نخفي السلاسل والتعليقات مع إبقاء المواقع والأسطر كما هي؛ الحارس لا يحاول تفسير
// نصّ يُمرَّر إلى برنامج آخر، ولا يحجب رمزاً مذكوراً في رسالة أو تعليق.
function maskPowerShellText(command) {
  const source = String(command || '');
  const masked = source.split('');
  let state = 'code';
  let hereQuote = '';

  function hide(index) {
    if (masked[index] !== '\r' && masked[index] !== '\n') masked[index] = ' ';
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line_comment') {
      hide(index);
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block_comment') {
      hide(index);
      if (char === '#' && next === '>') {
        hide(index + 1);
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'here_string') {
      hide(index);
      const lineStart = source.lastIndexOf('\n', index - 1) + 1;
      const lineEnd = source.indexOf('\n', index + 2);
      const trailerEnd = lineEnd === -1 ? source.length : lineEnd;
      if (char === hereQuote && next === '@' && index === lineStart
          && /^[\t \r]*$/.test(source.slice(index + 2, trailerEnd))) {
        hide(index + 1);
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'single_quote') {
      hide(index);
      if (char === "'" && next === "'") {
        hide(index + 1);
        index += 1;
      } else if (char === "'") state = 'code';
      continue;
    }
    if (state === 'double_quote') {
      hide(index);
      if (char === '`' && next != null) {
        hide(index + 1);
        index += 1;
      } else if (char === '"') state = 'code';
      continue;
    }

    if (char === '<' && next === '#') {
      hide(index);
      hide(index + 1);
      index += 1;
      state = 'block_comment';
    } else if (char === '#') {
      hide(index);
      state = 'line_comment';
    } else if (char === '@' && (next === "'" || next === '"')) {
      const lineEnd = source.indexOf('\n', index + 2);
      const headerEnd = lineEnd === -1 ? source.length : lineEnd;
      if (/^[\t \r]*$/.test(source.slice(index + 2, headerEnd))) {
        hereQuote = next;
        hide(index);
        hide(index + 1);
        index += 1;
        state = 'here_string';
      }
    } else if (char === "'") {
      hide(index);
      state = 'single_quote';
    } else if (char === '"') {
      hide(index);
      state = 'double_quote';
    } else if (char === '`') {
      hide(index);
      if (next != null) {
        hide(index + 1);
        index += 1;
      }
    }
  }
  return masked.join('');
}

// Windows PowerShell 5.1 حصراً (‏powershell.exe): هو الافتراضي في «سطر»، ولا يعرف
// سلاسل && و||. أما pwsh 7+ فيدعمهما فلا يُحجبان فيه (مراجعة القائد 2026-09-03).
function isWindowsPowerShell5(shell) {
  const name = String(shell || '').trim().replace(/\\/g, '/').split('/').pop().toLowerCase();
  return name === 'powershell.exe';
}

/**
 * يرصد أكثر خلطات cmd/POSIX شيوعاً قبل إقلاع مهمة PowerShell.
 * القائمة مقصودة الضيق: لصدفة أخرى، أو لنص مقتبس/تعليق، نرجع بلا اعتراض.
 * ⚠️ ما لا يُحجب عمداً (قِيس على 5.1 عند المراجعة): `tee` اسم مستعار صالح لـTee-Object،
 * و`~/` مسار المنزل صالح — حجبهما كان إيجابيتين كاذبتين في المسودة الأولى.
 */
function shellSyntaxProblems(command, shell) {
  if (!isPowerShell(shell)) return [];
  const masked = maskPowerShellText(command);
  const problems = [];

  function add(index, token, hint) {
    problems.push({ index, token, hint });
  }

  let match;
  const cdPattern = /(^|[;{}()\r\n|&])[\t ]*(cd[\t ]+\/d)(?=[\t \r\n]|$)/gim;
  while ((match = cdPattern.exec(masked))) {
    add(match.index + match[0].lastIndexOf(match[2]), 'cd /d',
      'استخدم Set-Location <المسار> (أو cd <المسار>) من دون ‎/d في PowerShell.');
  }

  if (isWindowsPowerShell5(shell)) {
    const chainPattern = /[\t ](&&|\|\|)(?=[\t ])/g;
    while ((match = chainPattern.exec(masked))) {
      const token = match[1];
      const hint = token === '&&'
        ? 'استخدم ; ثم if ($?) { … } لتشغيل الأمر التالي عند نجاح السابق في PowerShell 5.1.'
        : 'استخدم ; ثم if (-not $?) { … } لتشغيل الأمر التالي عند فشل السابق في PowerShell 5.1.';
      add(match.index + match[0].indexOf(token), token, hint);
    }
  }

  const nullPattern = /(^|[^0-9])(2?>[\t ]*\/dev\/null)(?=$|[\s;|&])/gi;
  while ((match = nullPattern.exec(masked))) {
    const isStderr = match[2].startsWith('2>');
    add(match.index + match[1].length, isStderr ? '2>/dev/null' : '>/dev/null',
      isStderr
        ? 'استبدل 2>/dev/null بـ 2>$null في PowerShell.'
        : 'استبدل >/dev/null بـ >$null في PowerShell.');
  }

  const exportPattern = /(^|[;{}()\r\n|&])[\t ]*export[\t ]+([A-Za-z_][A-Za-z0-9_]*)=/gim;
  while ((match = exportPattern.exec(masked))) {
    const name = match[2];
    const token = 'export ' + name + '=';
    add(match.index + match[0].toLowerCase().lastIndexOf('export'), token,
      'استبدل ' + token + '… بـ $env:' + name + '=… في PowerShell.');
  }

  return problems
    .sort((left, right) => left.index - right.index)
    .map(({ token, hint }) => ({ token, hint }));
}

module.exports = { isBackgroundBash, isServerCommand, buildRedirectMessage, shellSyntaxProblems };
