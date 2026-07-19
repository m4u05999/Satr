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

module.exports = { isBackgroundBash, isServerCommand, buildRedirectMessage };
