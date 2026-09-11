/**
 * اختبار طرف خدمات التوصيلات نفسه عبر حقن النقل فقط: الطلبات الحقيقية تبقى في الموديول.
 * لا حسابات ولا شبكة خارجية ولا رموز مستخدم؛ جميع القيم أدناه عينات مصطنعة.
 */
'use strict';
const assert = require('node:assert/strict');
const { createServices } = require('../electron/connection-services');

const TOKEN = 'OpaqueSatrAccessCredentialForTests123';
const REPO = 'satr-owner/project';
const SITE = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_SITE = '550e8400-e29b-41d4-a716-446655440001';
const REF = 'abcdefghijklmnopqrst';
const repo = { id: 42, full_name: REPO, private: true, description: 'وصف المشروع', default_branch: 'main' };
const site = { id: SITE, name: 'موقع التجربة', state: 'current', ssl_url: 'https://satr-test.netlify.app/' };
const project = { id: REF, ref: REF, name: 'قاعدة التجربة', status: 'ACTIVE_HEALTHY', region: 'eu-west-1' };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function transport(responses, options = {}) {
  const calls = [];
  const queue = [...responses];
  const services = createServices({
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      assert.ok(queue.length, 'طلب إضافي غير متوقع');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, init) : next;
    },
  });
  return { services, calls, remaining: () => queue.length };
}
async function rejected(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes('https://'));
    return true;
  });
}

async function main() {
  let passed = 0;
  async function check(label, body) {
    await body();
    passed += 1;
    console.log('PASS ' + passed + ' ' + label);
  }

  await check('الحسابات تُقرأ من المسارات الرسمية ولا تعيد أسرار الرد', async () => {
    const t = transport([
      json({ id: 1, login: 'satr-owner', token: TOKEN }),
      json({ id: 'user123', full_name: 'مالك ' + TOKEN, password: 'provider-password' }),
      json({ gotrue_id: SITE, username: 'user ' + TOKEN, primary_email: 'hidden@example.test' }),
    ]);
    assert.deepEqual(await t.services.github.authenticate(TOKEN), { id: '1', label: 'satr-owner' });
    assert.equal((await t.services.netlify.authenticate(TOKEN)).label, 'مالك [secret]');
    assert.equal((await t.services.supabase.authenticate(TOKEN)).label, 'user [secret]');
    assert.deepEqual(t.calls.map((c) => c.url), [
      'https://api.github.com/user', 'https://api.netlify.com/api/v1/user', 'https://api.supabase.com/v1/profile',
    ]);
    for (const call of t.calls) {
      assert.equal(call.headers.Authorization, 'Bearer ' + TOKEN);
      assert.equal(call.headers['User-Agent'], 'satr');
      assert.equal(call.redirect, 'error', 'إعادة التوجيه يجب أن تبقى مرفوضة');
      assert.ok(call.signal instanceof AbortSignal);
      assert.ok(!call.url.includes(TOKEN));
    }
    assert.equal(t.calls[0].headers['X-GitHub-Api-Version'], '2026-03-10');
  });

  await check('المورد والمسار المدخلان لا يصيران وجهة HTTP حرة', async () => {
    const t = transport([]);
    for (const resource of ['https://evil.test/a', '../owner/repo', 'owner/..', 'owner/repo?x=1', 'owner/repo#x', 'owner/repo%2fother', 'owner\\repo']) {
      await rejected(() => t.services.github.inspect(TOKEN, resource), 'bad_input');
    }
    await rejected(() => t.services.netlify.inspect(TOKEN, SITE + '/deploys'), 'bad_input');
    await rejected(() => t.services.supabase.inspect(TOKEN, REF + '?sql=delete'), 'bad_input');
    for (const path of ['../secret', '/absolute', 'a/../secret', 'a\\secret', 'a%2fsecret', 'a?ref=other']) {
      await rejected(() => t.services.github.run(TOKEN, REPO, 'read_file', { path }), 'bad_input');
    }
    await rejected(() => t.services.github.run(TOKEN, REPO, 'constructor'), 'bad_input');
    await rejected(() => t.services.github.run(TOKEN, REPO, 'list_issues', { url: 'https://evil.test' }), 'bad_input');
    await rejected(() => t.services.supabase.run(TOKEN, REF, 'list_tables', { query: 'DELETE FROM x' }), 'bad_input');
    await rejected(() => t.services.github.authenticate(TOKEN + '\r\nInjected: yes'), 'bad_input');
    assert.equal(t.calls.length, 0);
  });

  await check('الانتقال وتغيير هوية المورد يفشلان مغلقين', async () => {
    let t = transport([json({ ...repo, full_name: 'satr-owner/renamed' })]);
    await rejected(() => t.services.github.inspect(TOKEN, REPO), 'invalid_response');
    t = transport([json({ ...site, id: OTHER_SITE })]);
    await rejected(() => t.services.netlify.inspect(TOKEN, SITE), 'invalid_response');
    t = transport([json({ ...project, ref: 'tsrqponmlkjihgfedcba' })]);
    await rejected(() => t.services.supabase.inspect(TOKEN, REF), 'invalid_response');
    t = transport([json({}, 301, { location: 'https://evil.test/' + TOKEN })]);
    await rejected(() => t.services.github.inspect(TOKEN, REPO), 'invalid_response');
    const moved = json(repo);
    Object.defineProperty(moved, 'redirected', { value: true });
    t = transport([moved]);
    await rejected(() => t.services.github.inspect(TOKEN, REPO), 'invalid_response');
    const otherUrl = json(repo);
    Object.defineProperty(otherUrl, 'url', { value: 'https://api.github.com/repos/satr-owner/other' });
    t = transport([otherUrl]);
    await rejected(() => t.services.github.inspect(TOKEN, REPO), 'invalid_response');
  });

  await check('نتائج Netlify منتقاة وتحذف قيم الحماية وكلمات المرور', async () => {
    const t = transport([
      json({ ...site, password: TOKEN, session_id: 'PRIVATE-SESSION', build_settings: { env: { KEY: 'OTHER-SECRET' } } }),
      json(site),
      json([{ id: 'deploy1', site_id: SITE, state: 'ready', branch: 'main', created_at: '2026-09-08', deploy_ssl_url: 'https://preview.netlify.app/?token=SECRET', skew_protection_token: TOKEN }]),
    ]);
    const inspected = await t.services.netlify.inspect(TOKEN, SITE);
    assert.deepEqual(Object.keys(inspected).sort(), ['id', 'label', 'state', 'url']);
    const result = await t.services.netlify.run(TOKEN, SITE, 'list_deploys');
    assert.equal(result.deploys[0].url, '');
    assert.ok(!JSON.stringify({ inspected, result }).includes(TOKEN));
    assert.ok(!JSON.stringify({ inspected, result }).includes('PRIVATE-SESSION'));
    assert.ok(!JSON.stringify({ inspected, result }).includes('OTHER-SECRET'));
    assert.equal(result.truncated, false);
    const mismatch = transport([json(site), json([{ id: 'deploy2', site_id: OTHER_SITE }])]);
    await rejected(() => mismatch.services.netlify.run(TOKEN, SITE, 'list_deploys'), 'invalid_response');
  });

  await check('قراءة الملفات تحجب الأسرار قبل القص وتتحقق من اسم الملف', async () => {
    const content = 'نص ' + TOKEN + '\npassword=another-secret\n'
      + 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890\n'
      + 'sbp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890\nنهاية';
    const data = { type: 'file', path: 'docs/read me.md', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
    const t = transport([json(repo), json(data)]);
    const result = await t.services.github.run(TOKEN, REPO, 'read_file', { path: data.path, ref: 'feature/demo' });
    assert.ok(result.content.includes('نهاية'));
    for (const secret of [TOKEN, 'another-secret', 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'sbp_ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
      assert.ok(!result.content.includes(secret), 'تسرّب سر من محتوى الملف');
    }
    assert.equal(t.calls[1].url, 'https://api.github.com/repos/' + REPO + '/contents/docs/read%20me.md?ref=feature%2Fdemo');
    const wrong = transport([json(repo), json({ ...data, path: 'other.md' })]);
    await rejected(() => wrong.services.github.run(TOKEN, REPO, 'read_file', { path: data.path }), 'invalid_response');
    const largeContent = 'a'.repeat(33000);
    const large = transport([json(repo), json({ ...data, size: largeContent.length, content: Buffer.from(largeContent).toString('base64') })]);
    const clipped = await large.services.github.run(TOKEN, REPO, 'read_file', { path: data.path });
    assert.equal(clipped.content.length, 32000);
    assert.equal(clipped.truncated, true);
  });

  await check('الأفعال المؤثرة معلنة ولا تتوسع مدخلاتها إلى API عام', async () => {
    const t = transport([
      json(repo), json({ number: 7, title: 'عنوان', repository_url: 'https://api.github.com/repos/' + REPO, token: TOKEN }, 201),
      json(site), json({ id: 'build1', deploy_id: 'deploy1', done: false, created_at: '2026-09-08', password: TOKEN }),
    ]);
    assert.equal(t.services.github.actions.create_issue.write, true);
    assert.equal(t.services.netlify.actions.trigger_build.write, true);
    assert.equal(t.services.supabase.actions.list_tables.write, false);
    await t.services.github.run(TOKEN, REPO, 'create_issue', { title: 'عنوان', body: 'تفاصيل' });
    assert.equal(t.calls[1].method, 'POST');
    assert.deepEqual(JSON.parse(t.calls[1].body), { title: 'عنوان', body: 'تفاصيل' });
    await t.services.netlify.run(TOKEN, SITE, 'trigger_build', { branch: 'feature/demo' });
    assert.equal(t.calls[3].url, 'https://api.netlify.com/api/v1/sites/' + SITE + '/builds?branch=feature%2Fdemo');
    assert.equal(t.calls[3].method, 'POST');
    assert.equal(t.calls[3].body, undefined);
  });

  await check('سرد الموارد محدود ولا يتبع رابط pagination غير موثوق', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ full_name: 'satr-owner/repo-' + i }));
    const t = transport([json(rows, 200, { link: '<https://evil.test/leak>; rel="next"' }), json([{ full_name: REPO }])]);
    const list = await t.services.github.listResources(TOKEN);
    assert.equal(list.resources.length, 101);
    assert.equal(list.truncated, false);
    assert.equal(t.calls[1].url, 'https://api.github.com/user/repos?per_page=100&page=2');
    const capped = transport([json(rows), json(rows), json(rows)]);
    assert.equal((await capped.services.github.listResources(TOKEN)).truncated, true);
    assert.equal(capped.calls.length, 3);
    const other = transport([json([site]), json(Array.from({ length: 301 }, () => project))]);
    assert.deepEqual(await other.services.netlify.listResources(TOKEN), { resources: [{ id: SITE, label: site.name }], truncated: false });
    const supabase = await other.services.supabase.listResources(TOKEN);
    assert.equal(supabase.resources.length, 300);
    assert.equal(supabase.truncated, true);
  });

  await check('Supabase يستعمل استعلاماً ثابتاً عبر حساب القراءة فقط', async () => {
    const t = transport([json(project), json([{ table_schema: 'public', table_name: 'projects', private_key: TOKEN }], 201)]);
    const tables = await t.services.supabase.run(TOKEN, REF, 'list_tables');
    assert.deepEqual(tables, { tables: [{ schema: 'public', name: 'projects' }], truncated: false });
    assert.equal(t.calls[1].url, 'https://api.supabase.com/v1/projects/' + REF + '/database/query/read-only');
    assert.equal(t.calls[1].method, 'POST');
    const body = JSON.parse(t.calls[1].body);
    assert.deepEqual(Object.keys(body), ['query']);
    assert.ok(body.query.includes('information_schema.tables'));
    assert.ok(body.query.includes('LIMIT 101'));
  });

  await check('انتهاء الرمز والصلاحية والموارد وأخطاء النقل تبقى حالات منفصلة', async () => {
    for (const [status, code] of [[401, 'auth_expired'], [403, 'forbidden'], [404, 'not_found'], [429, 'network'], [500, 'network']]) {
      const t = transport([json({ error: 'https://evil.test/' + TOKEN }, status)]);
      await rejected(() => t.services.github.authenticate(TOKEN), code);
    }
    const t = transport([new Error('fetch rejected https://evil.test/' + TOKEN)]);
    await rejected(() => t.services.github.authenticate(TOKEN), 'network');
  });

  await check('حجم الرد ونوعه وترميزه والمهلة محكومة في النقل', async () => {
    let t = transport([new Response('not-json ' + TOKEN, { headers: { 'content-type': 'application/json' } })]);
    await rejected(() => t.services.github.authenticate(TOKEN), 'invalid_response');
    t = transport([new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } })]);
    await rejected(() => t.services.github.authenticate(TOKEN), 'invalid_response');
    t = transport([json({}, 200, { 'content-length': String(3 * 1024 * 1024) })]);
    await rejected(() => t.services.github.authenticate(TOKEN), 'invalid_response');
    t = transport([new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]);
    await rejected(() => t.services.github.authenticate(TOKEN), 'invalid_response');
    t = transport([new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } })]);
    await rejected(() => t.services.github.authenticate(TOKEN), 'invalid_response');
    t = transport([(_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('timeout ' + TOKEN)), { once: true });
    })], { requestTimeoutMs: 10 });
    await rejected(() => t.services.github.authenticate(TOKEN), 'network');
  });


  await check('الملف العربي يبقى مساراً مقيداً ومشفراً في عنوان الطلب', async () => {
    const name = 'وثائق/شرح (١).md';
    const content = 'محتوى عربي معلوم';
    const t = transport([json(repo), json({ type: 'file', path: name, encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') })]);
    assert.equal((await t.services.github.run(TOKEN, REPO, 'read_file', { path: name })).content, content);
    assert.equal(t.calls[1].url, 'https://api.github.com/repos/' + REPO + '/contents/' + name.split('/').map(encodeURIComponent).join('/'));
  });

  await check('فصل الاتصال أثناء قراءة التحقق يمنع POST اللاحق', async () => {
    for (const [service, resource, action, params, data] of [
      ['github', REPO, 'create_issue', { title: 'قضية تجريبية' }, repo],
      ['netlify', SITE, 'trigger_build', {}, site],
    ]) {
      let release;
      let active = true;
      const t = transport([() => new Promise((resolve) => { release = resolve; })]);
      const running = t.services[service].run(TOKEN, resource, action, params, {
        assertActive() { if (!active) throw Object.assign(new Error('inactive'), { connectionCode: 'inactive' }); },
      });
      assert.equal(t.calls.length, 1);
      active = false;
      release(json(data));
      await assert.rejects(() => running, (error) => error.connectionCode === 'inactive', 'يجب منع الفعل بعد إبطال الاتصال');
      assert.equal(t.calls.filter((call) => call.method === 'POST').length, 0, 'أُرسل POST بعد فصل الاتصال');
    }
  });

  console.log('PASS connection-services ' + passed + '/' + passed);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
