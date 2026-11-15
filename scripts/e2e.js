// End-to-end check of the API against an in-memory MongoDB.
// Usage: npm run test:e2e [path/to/resume.pdf]
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resumely-e2e-'));
  process.env.LLM_API_KEY = ''; // keep the tests on the built-in rules, never a live model
  process.env.NVIDIA_API_KEY = '';
  process.env.LLM_ORDER = '';
  process.env.ADMIN_EMAILS = 'boss@example.com';
  process.env.AI_STARTING_CREDITS = '100';
  const { parseJson } = require('../src/llm');
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! Here it is: {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
  assert.equal(parseJson('no json here'), null);
  console.log('  ok  model replies with code fences or extra text are parsed');
  {
    // Model order with a fake provider: "busy" answers 429, "empty" answers nothing, "good" answers.
    const cfg = require('../src/config');
    const llm = require('../src/llm');
    const saved = { ...cfg.llm };
    Object.assign(cfg.llm, { provider: 'openrouter', apiKeys: ['test-key'], model: 'busy', fallbackModels: ['empty', 'good'] });
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opt) => {
      const b = JSON.parse(opt.body);
      calls.push(`${b.model}:${b.max_tokens}`);
      const reply = (o, status = 200) => ({ ok: status === 200, status, json: async () => o });
      if (b.model === 'busy') return reply({ error: { code: 429, message: 'Provider returned error' } }, 429);
      if (b.model === 'empty') return reply({ choices: [{ message: { content: '' } }], usage: { total_tokens: 5 } });
      return reply({ choices: [{ message: { content: '{"title":"Dev","keywords":[{"term":"React","required":true}]}' } }], usage: { total_tokens: 50 } });
    };
    try {
      await llm.resetLimits({ clearCount: true });
      const a = await llm.jobKeywords('Dev\nReact');
      assert.equal(a.job.keywords[0].term, 'React');
      assert.deepEqual(calls, ['busy:1800', 'empty:1800', 'good:1800']);
      calls.length = 0;
      await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['empty:1800', 'good:1800'], 'the busy model is skipped while cooling down');
      // LLM_ORDER mixes providers; entries for a provider without a key are skipped.
      await llm.resetLimits({ clearCount: true });
      calls.length = 0;
      const nvSaved = { ...cfg.nvidia };
      Object.assign(cfg.nvidia, { apiKeys: ['nv-test'], models: ['nv-model'] });
      cfg.llm.order = ['openrouter:empty', 'nvidia:nv-busy', 'openrouter:good', 'nowhere:x', 'nvidia:nv-model'];
      global.fetch = async (url, opt) => {
        const b = JSON.parse(opt.body);
        calls.push(`${url.includes('nvidia') ? 'nv' : 'or'}:${b.model}`);
        const reply = (o, status = 200) => ({ ok: status === 200, status, json: async () => o });
        if (b.model === 'empty') return reply({ choices: [{ message: { content: '' } }] });
        if (b.model === 'nv-busy') return reply({ status: 503, detail: 'temporarily unavailable' }, 503);
        return reply({ choices: [{ message: { content: '{"title":"Dev","keywords":[{"term":"React","required":true}]}' } }] });
      };
      await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['or:empty', 'nv:nv-busy', 'or:good'], 'LLM_ORDER is followed across providers');

      // Two NVIDIA keys: key A is rate-limited, so the same model is retried at once on key B,
      // and the next request starts with key B while A sits out.
      await llm.resetLimits({ clearCount: true });
      Object.assign(cfg.nvidia, { apiKeys: ['key-A', 'key-B'] });
      cfg.llm.order = ['nvidia:nv-model'];
      calls.length = 0;
      global.fetch = async (url, opt) => {
        const b = JSON.parse(opt.body);
        const key = opt.headers.Authorization.replace('Bearer ', '');
        calls.push(`${b.model}@${key}`);
        const reply = (o, status = 200) => ({ ok: status === 200, status, json: async () => o });
        if (key === 'key-A') return reply({ status: 429, title: 'Too Many Requests' }, 429);
        return reply({ choices: [{ message: { content: '{"title":"Dev","keywords":[{"term":"React","required":true}]}' } }] });
      };
      await llm.jobKeywords('Dev\nReact');
      await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['nv-model@key-A', 'nv-model@key-B', 'nv-model@key-B'], 'a rate-limited key sits out; the other key takes over');

      // OpenRouter's daily free limit: once it says so, every OpenRouter model is skipped
      // and requests go straight to NVIDIA.
      await llm.resetLimits({ clearCount: true });
      Object.assign(cfg.nvidia, { apiKeys: ['nv-key'] });
      cfg.llm.order = ['openrouter:or-a:free', 'openrouter:or-b:free', 'nvidia:nv-model'];
      let orAnswer = 'limit';
      global.fetch = async (url, opt) => {
        const b = JSON.parse(opt.body);
        calls.push(`${url.includes('nvidia') ? 'nv' : 'or'}:${b.model}`);
        const reply = (o, status = 200) => ({ ok: status === 200, status, json: async () => o });
        if (!url.includes('nvidia') && orAnswer === 'limit') {
          return reply({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', metadata: { headers: { 'X-RateLimit-Reset': String(Date.now() + 3600e3) } } } }, 429);
        }
        return reply({ choices: [{ message: { content: '{"title":"Dev","keywords":[{"term":"React","required":true}]}' } }] });
      };
      calls.length = 0;
      await llm.jobKeywords('Dev\nReact');
      await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['or:or-a:free', 'nv:nv-model', 'nv:nv-model'], 'after "free-models-per-day", OpenRouter is skipped entirely');

      // Our own count: at the daily limit, OpenRouter is skipped before it has to say no.
      await llm.resetLimits({ clearCount: true });
      const savedLimit = cfg.openrouterDailyLimit;
      cfg.openrouterDailyLimit = 2;
      orAnswer = 'ok';
      calls.length = 0;
      for (let i = 0; i < 3; i++) await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['or:or-a:free', 'or:or-a:free', 'nv:nv-model'], 'the third request skips OpenRouter (2 of 2 used)');
      cfg.openrouterDailyLimit = savedLimit;

      // A model that keeps failing (empty replies, timeouts) moves behind healthy ones.
      await llm.resetLimits({ clearCount: true });
      cfg.llm.order = ['openrouter:flaky', 'openrouter:solid'];
      global.fetch = async (url, opt) => {
        const b = JSON.parse(opt.body);
        calls.push(`or:${b.model}`);
        const content = b.model === 'flaky' ? '' : '{"title":"Dev","keywords":[{"term":"React","required":true}]}';
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
      };
      calls.length = 0;
      for (let i = 0; i < 3; i++) await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['or:flaky', 'or:solid', 'or:flaky', 'or:solid', 'or:solid'], 'after 2 failures in a row, the healthy model goes first');

      // Two OpenRouter accounts: each key has its own daily count. Key 1 used up -> key 2,
      // both used up -> straight to NVIDIA.
      await llm.resetLimits({ clearCount: true });
      cfg.llm.apiKeys = ['or-key-1', 'or-key-2'];
      Object.assign(cfg.nvidia, { apiKeys: ['nv-key'], models: ['nv-model'] });
      cfg.llm.order = ['openrouter:or-a:free', 'nvidia:nv-model'];
      cfg.openrouterDailyLimit = 1;
      global.fetch = async (url, opt) => {
        const b = JSON.parse(opt.body);
        const key = opt.headers.Authorization.replace('Bearer ', '');
        calls.push(url.includes('nvidia') ? 'nv' : `or@${key}`);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"title":"Dev","keywords":[{"term":"React","required":true}]}' } }] }) };
      };
      calls.length = 0;
      for (let i = 0; i < 3; i++) await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['or@or-key-1', 'or@or-key-2', 'nv'], 'per-key daily counts: key 1, then key 2, then NVIDIA');

      // A key whose account privacy settings block free models (404 "data policy"): the same
      // model is retried on the other key, and the blocked key sits out.
      await llm.resetLimits({ clearCount: true });
      cfg.openrouterDailyLimit = 50;
      global.fetch = async (url, opt) => {
        const key = opt.headers.Authorization.replace('Bearer ', '');
        calls.push(url.includes('nvidia') ? 'nv' : `or@${key}`);
        if (key === 'or-key-1') return { ok: false, status: 404, json: async () => ({ error: { code: 404, message: '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy.' } }) };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"title":"Dev","keywords":[{"term":"React","required":true}]}' } }] }) };
      };
      calls.length = 0;
      await llm.jobKeywords('Dev\nReact');
      await llm.jobKeywords('Dev\nReact');
      assert.deepEqual(calls, ['or@or-key-1', 'or@or-key-2', 'or@or-key-2'], 'a key blocked by its privacy settings hands over to the other key');
      cfg.openrouterDailyLimit = savedLimit;
      await llm.resetLimits({ clearCount: true });
      await llm.resetLimits({ clearCount: true });
      Object.assign(cfg.nvidia, nvSaved);
    } finally { global.fetch = realFetch; Object.assign(cfg.llm, saved); }
    console.log('  ok  busy models cool down, empty replies fall through, reply cap per task, LLM_ORDER mixes providers, a rate-limited key hands over to the other key');
    console.log("  ok  OpenRouter's daily limit (it says so, or our per-key count reaches it) sends requests straight to the next key, then NVIDIA");
    console.log('  ok  models that keep failing go behind healthy ones');
  }
  const db = require('../src/db');
  const { createApp } = require('../src/app');
  const { closeBrowser } = require('../src/pdf');
  await db.connect(mongo.getUri());
  // Stand-in for Google: credentials look like "good:<sub>:<email>".
  const verifyGoogleCredential = async (c) => {
    const [tag, sub, email] = String(c).split(':');
    if (tag !== 'good') throw Object.assign(new Error('Google sign-in could not be verified. Try again.'), { status: 401 });
    return { sub, email, email_verified: true, name: email.split('@')[0], picture: '' };
  };
  const server = createApp({ verifyGoogleCredential }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  let sampleId2;

  async function call(method, url, body, raw) {
    const headers = cookie ? { cookie } : {};
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) { const c = sc.split(';')[0]; cookie = c.endsWith('=') ? '' : c; }
    return raw ? res : { status: res.status, json: await res.json().catch(() => null) };
  }
  const signIn = (sub, email) => call('POST', '/api/auth/google', { credential: `good:${sub}:${email}` });
  const ok = (label) => console.log(`  ok  ${label}`);

  try {
    // ---- landing page ----
    const home = await call('GET', '/', undefined, true);
    const html = await home.text();
    assert.equal(home.status, 200); assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.match(html, /src="\/js\/app\.js\?v=[0-9a-f]{10}"/); assert.match(html, /href="\/css\/app\.css\?v=[0-9a-f]{10}"/);
    ok('landing page loads signed out, with versioned script and style links');
    assert.match(home.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY'); assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    ok('security headers set (CSP, no framing, nosniff)');
    const badJson = await fetch(`${base}/api/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(badJson.status, 400); assert.equal((await badJson.json()).error, 'The request body is not valid JSON.');
    ok('malformed JSON gets a plain 400 message');
    // ---- SEO and static files ----
    assert.match(html, /<meta name="description" content="[^"]{80,}/); assert.match(html, /<link rel="canonical" href="https:\/\/resume\.sarey\.tech\/">/);
    assert.match(html, /property="og:image" content="https:\/\/resume\.sarey\.tech\/og\.png"/); assert.match(html, /application\/ld\+json/);
    let s = await fetch(`${base}/robots.txt`); assert.equal(s.status, 200); assert.match(await s.text(), /Sitemap: https:\/\/resume\.sarey\.tech\/sitemap\.xml/);
    s = await fetch(`${base}/sitemap.xml`); assert.equal(s.status, 200); assert.match(s.headers.get('content-type'), /xml/);
    s = await fetch(`${base}/favicon.ico`); assert.equal(s.status, 200); assert.match(s.headers.get('content-type'), /image\/png/);
    s = await fetch(`${base}/og.png`); assert.equal(s.status, 200);
    s = await fetch(`${base}/site.webmanifest`); assert.match(s.headers.get('content-type'), /manifest\+json/);
    s = await fetch(`${base}/css/app.css?v=abc`); assert.match(s.headers.get('cache-control'), /immutable/);
    s = await fetch(`${base}/no-such-page`); assert.equal(s.status, 404); assert.match(await s.text(), /This page doesn't exist/);
    // On-page checks from the SEO audit
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one H1');
    assert.match(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1], /AI/);
    const title = html.match(/<title>([^<]*)<\/title>/)[1].replace(/&amp;/g, '&');
    assert.ok(title.length <= 60 && /Resumely AI/.test(title) && /AI Resume Builder/i.test(title), `title: ${title}`);
    const desc = html.match(/<meta name="description" content="([^"]*)"/)[1];
    assert.ok(desc.length >= 140 && desc.length <= 160, `description is ${desc.length} characters`);
    const faqLd = JSON.parse(html.match(/<script type="application\/ld\+json">\s*(\{\s*"@context": "https:\/\/schema.org",\s*"@type": "FAQPage"[\s\S]*?)<\/script>/)[1]);
    const visibleQs = [...html.matchAll(/<summary><h3>([\s\S]*?)<\/h3><\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(faqLd.mainEntity.map((q) => q.name), visibleQs, 'FAQ structured data matches the visible FAQ');
    s = await fetch(`${base}/llms.txt`); assert.equal(s.status, 200); assert.match(await s.text(), /^# Resumely AI/);
    s = await fetch(`${base}/sitemap.xml`); const sm = await s.text();
    assert.match(sm, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/); assert.match(sm, /<loc>http/);
    ok('SEO: one H1 with AI, keyword title, description length, FAQ data matches the page, llms.txt, self-updating sitemap, canonical, social card, robots, 404');

    let r = await call('GET', '/api/sample');
    assert.equal(r.status, 200); assert.ok(r.json.name); ok('sample preview data is public');

    // ---- signed out: nothing works ----
    r = await call('GET', '/api/me');
    assert.equal(r.json.user.signedIn, false); assert.equal(cookie, '');
    for (const [m, u] of [['GET', '/api/resumes'], ['POST', '/api/resumes/sample'], ['GET', '/api/resumes/000000000000000000000000'], ['GET', '/api/resumes/000000000000000000000000/pdf']]) {
      r = await call(m, u);
      assert.equal(r.status, 401, `${m} ${u}`);
    }
    ok('signed-out visitor is refused on every resume route (401)');
    const fd0 = new FormData();
    fd0.append('resume', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
    r = await call('POST', '/api/resumes', fd0);
    assert.equal(r.status, 401);
    assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0); ok('signed-out upload is refused and nothing is written to disk');

    r = await call('POST', '/api/auth/google', { credential: 'bad' });
    assert.equal(r.status, 401); assert.equal(cookie, ''); ok('bad Google credential rejected');

    // ---- signed in ----
    r = await signIn('111', 'ana@example.com');
    assert.equal(r.status, 200); assert.equal(r.json.user.signedIn, true); assert.equal(r.json.user.email, 'ana@example.com');
    assert.ok(cookie.startsWith('rl_sid='));
    r = await call('GET', '/api/resumes');
    assert.equal(r.status, 200); assert.deepEqual(r.json, []); ok('Google sign-in starts a session; new account has no resumes');

    r = await call('POST', '/api/resumes/sample');
    assert.equal(r.status, 201); const sampleId = r.json.id;
    ok('sample resume created');

    const file = process.argv[2];
    let up;
    if (file) {
      const fd = new FormData();
      const type = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[path.extname(file).toLowerCase()];
      fd.append('resume', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
      up = await call('POST', '/api/resumes', fd);
      assert.equal(up.status, 201, JSON.stringify(up.json));
      const d = up.json.data;
      console.log(`  ok  upload parsed: name="${d.name}", ${d.experience.length} roles, ${d.skills.length} skill groups, ${d.projects.length} projects, ${d.education.length} schools, ${d.contact.length} contact items`);
      const stored = fs.readdirSync(process.env.UPLOAD_DIR, { recursive: true }).filter((f) => /\.(pdf|txt|docx)$/.test(f));
      assert.equal(stored.length, 1); ok(`original saved on disk (${stored[0]})`);
    }

    const bad = new FormData();
    bad.append('resume', new Blob(['x'], { type: 'image/png' }), 'photo.png');
    r = await call('POST', '/api/resumes', bad);
    assert.equal(r.status, 400); ok(`bad file type rejected: "${r.json.error}"`);

    r = await call('PATCH', `/api/resumes/${sampleId}`, { theme: 'timeline', accent: '#2f5d50', data: { name: 'Edited Name', summary: 'New summary.', skills: [{ group: 'Frontend', items: ['React'] }] } });
    assert.equal(r.status, 200);
    r = await call('GET', `/api/resumes/${sampleId}`);
    assert.equal(r.json.data.name, 'Edited Name'); assert.equal(r.json.theme, 'timeline'); assert.equal(r.json.accent, '#2f5d50');
    ok('direct edits, theme and accent saved to Mongo');

    r = await call('PATCH', `/api/resumes/${sampleId}`, { theme: 'nope' });
    assert.equal(r.status, 400); ok('unknown theme rejected');

    r = await call('POST', `/api/resumes/${sampleId}/chat`, { message: 'add skill Redux' });
    assert.equal(r.status, 200); assert.ok(r.json.data.skills[0].items.includes('Redux'));
    r = await call('GET', `/api/resumes/${sampleId}`);
    assert.equal(r.json.chat.length, 2); assert.ok(r.json.data.skills[0].items.includes('Redux'));
    ok('chat command applied and chat history saved');

    const pdf = await call('GET', `/api/resumes/${sampleId}/pdf`, undefined, true);
    assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const buf = Buffer.from(await pdf.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    const pdfOut = path.join(__dirname, '..', 'storage', 'e2e-sample.pdf');
    fs.mkdirSync(path.dirname(pdfOut), { recursive: true }); fs.writeFileSync(pdfOut, buf);
    ok(`PDF rendered (${Math.round(buf.length / 1024)} KB, saved to storage/e2e-sample.pdf)`);

    if (up) {
      const f = await call('GET', `/api/resumes/${up.json.id}/file`, undefined, true);
      assert.equal(f.status, 200); ok('original file downloads');
    }

    // ---- other people and other browsers ----
    const ana = cookie;
    cookie = '';
    await signIn('222', 'ben@example.com');
    r = await call('GET', '/api/resumes');
    assert.deepEqual(r.json, []);
    r = await call('GET', `/api/resumes/${sampleId}`);
    assert.equal(r.status, 404); ok("another Google account can't see or open Ana's resumes");

    cookie = '';
    await signIn('111', 'ana@example.com');
    const anaPhone = cookie;
    assert.notEqual(anaPhone, ana);
    r = await call('GET', '/api/resumes');
    assert.equal(r.json.length, up ? 2 : 1); ok('Ana sees her resumes when she signs in on a second browser');

    await signIn('111', 'ana@example.com');
    assert.notEqual(cookie, anaPhone);
    const fresh = cookie; cookie = anaPhone;
    r = await call('GET', '/api/resumes');
    assert.equal(r.status, 401); cookie = fresh; ok('signing in again replaces the old session cookie');

    cookie = ana;
    r = await call('GET', '/api/me');
    assert.equal(r.json.user.signedIn, true); ok('the first browser is still signed in');

    r = await call('DELETE', `/api/resumes/${sampleId}`);
    assert.equal(r.status, 200);
    r = await call('GET', '/api/resumes');
    assert.equal(r.json.length, up ? 1 : 0); ok('delete removes the resume');

    r = await call('POST', '/api/auth/logout');
    assert.equal(r.status, 200);
    cookie = ana;
    r = await call('GET', '/api/resumes');
    assert.equal(r.status, 401);
    r = await call('GET', '/api/me');
    assert.equal(r.json.user.signedIn, false); ok('sign out ends the session; the old cookie no longer works');

    cookie = fresh;
    r = await call('GET', '/api/resumes');
    assert.equal(r.status, 200); ok("signing out one browser doesn't sign out the others");

    // ---- credits ----
    r = await call('GET', '/api/me');
    assert.equal(r.json.ai.credits, 100); assert.equal(r.json.user.isAdmin, false); ok('new account starts with 100 AI credits');
    const config = require('../src/config');
    const credits = require('../src/credits');
    const { col } = require('../src/db');
    const anaDoc = await col('users').findOne({ 'google.sub': '111' });
    assert.equal((await credits.charge(anaDoc, 2500)).credits, 97);
    await credits.charge(anaDoc, 1);
    assert.equal((await col('users').findOne({ _id: anaDoc._id })).credits, 96); ok('an AI call costs 1 credit per 1,000 tokens (at least 1)');

    // ---- job description ----
    r = await call('POST', '/api/resumes/sample'); const jdResume = r.json.id;
    r = await call('PATCH', `/api/resumes/${jdResume}`, { jd: 'x'.repeat(8001) });
    assert.equal(r.status, 400);
    r = await call('PATCH', `/api/resumes/${jdResume}`, { jd: '  Senior React Engineer at Acme  ' });
    r = await call('GET', `/api/resumes/${jdResume}`);
    assert.equal(r.json.jd, 'Senior React Engineer at Acme'); ok('job description saved on the resume (and over-long ones refused)');
    const posting = `About the role\nWe are looking for a Frontend Engineer to build our design system.\nRequirements\n- 4+ years of React and TypeScript\n- Experience with accessibility and testing\nNice to have: GraphQL, Next.js. ${'Details. '.repeat(30)}`;
    r = await call('POST', `/api/resumes/${jdResume}/chat`, { message: posting });
    assert.equal(r.status, 200); assert.equal(r.json.jd, posting.trim());
    assert.match(r.json.messages[0].text, /^Pasted a job description/); assert.match(r.json.messages[1].text, /needs the AI model/);
    r = await call('GET', `/api/resumes/${jdResume}`);
    assert.equal(r.json.jd, posting.trim()); ok('a job posting pasted into the chat becomes the target job');
    // ---- ATS score ----
    r = await call('POST', `/api/resumes/${sampleId2 = (await call('POST', '/api/resumes/sample')).json.id}/ats`, {});
    assert.equal(r.status, 200); assert.equal(r.json.mode, 'format'); assert.ok(r.json.score > 0 && r.json.score <= 100);
    assert.ok(r.json.checks.every((c) => typeof c.text === 'string')); ok('ATS: without a job description only the format check runs');
    const creditsBefore = (await call('GET', '/api/me')).json.ai.credits;
    r = await call('POST', `/api/resumes/${jdResume}/ats`, { onePage: true });
    assert.equal(r.json.mode, 'match'); assert.equal(r.json.keywordsBy, 'rules');
    assert.equal(r.json.parts.length, 5); assert.equal(r.json.parts.reduce((a, p) => a + p.score, 0), r.json.score);
    assert.ok(r.json.hits.some((h) => h.term === 'React')); assert.ok(r.json.misses.some((m) => m.term === 'GraphQL' && !m.required));
    assert.ok(r.json.hits.some((h) => h.term === 'TypeScript' && h.required));
    assert.equal((await call('GET', '/api/me')).json.ai.credits, creditsBefore);
    ok(`ATS: match score ${r.json.score}/100 with hits, misses and fixes; no credits used without the AI`);
    const cached = await col('resumes').findOne({ _id: require('../src/db').toId(jdResume) });
    assert.equal(cached.ats.by, 'rules'); assert.ok(cached.ats.keywords.length >= 4);
    const firstScore = r.json.score;
    const stuffedData = (await call('GET', `/api/resumes/${jdResume}`)).json.data;
    stuffedData.summary = 'React developer. ' + 'React '.repeat(10);
    await call('PATCH', `/api/resumes/${jdResume}`, { data: stuffedData });
    r = await call('POST', `/api/resumes/${jdResume}/ats`, { onePage: false });
    assert.ok(r.json.stuffed.some((s) => s.term === 'React')); assert.ok(r.json.fixes.some((f) => f.id === 'stuffing'));
    assert.ok(r.json.parts.find((p) => p.id === 'format').score < 15); assert.notEqual(r.json.score, firstScore);
    ok('ATS: keyword stuffing is flagged and earns less, and a resume over one page loses format points');
    r = await call('POST', `/api/resumes/${sampleId2}/ats`, {});
    await call('DELETE', `/api/resumes/${sampleId2}`);

    // ---- spelling and grammar ----
    const proof = require('../src/proofread');
    const pd = (await call('GET', `/api/resumes/${jdResume}`)).json.data;
    pd.experience[0].bullets[0] = 'Built React dashbords for internal tools';
    const good = proof.validate(pd, [
      { path: 'experience.0.bullets.0', original: 'dashbords', fixed: 'dashboards', kind: 'spelling', why: 'Misspelled' },
      { path: 'experience.0.bullets.0', original: 'dashbords', fixed: 'dashboards' },
      { path: 'experience.0.bullets.0', original: 'not in the line', fixed: 'x' },
      { path: 'summary', original: 'React', fixed: 'React' },
      { path: '__proto__.polluted', original: 'a', fixed: 'b' },
      { path: 'experience.9.bullets.0', original: 'a', fixed: 'b' },
      { path: 'summary', original: 'React', fixed: 'x'.repeat(300) },
    ]);
    assert.equal(good.length, 1); assert.equal(good[0].fixed, 'dashboards'); assert.equal(good[0].kind, 'spelling');
    assert.ok(proof.fields(pd).some((f) => f.path === 'experience.0.bullets.0'));
    ok('proofread: only fixes that quote real text on a real line are kept (no duplicates, rewrites or odd paths)');
    r = await call('POST', `/api/resumes/${jdResume}/proofread`);
    assert.equal(r.status, 503); assert.match(r.json.error, /needs the AI/);
    for (let i = 0; i < 9; i++) await call('POST', `/api/resumes/${jdResume}/proofread`);
    const limited = await call('POST', `/api/resumes/${jdResume}/proofread`, undefined, true);
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.match((await limited.json()).error, /Too many spelling checks/);
    ok('proofread needs the AI, and costly routes are rate limited (429 with Retry-After)');

    r = await call('GET', '/api/resumes');
    assert.equal(r.json.find((x) => x.id === jdResume).job, 'About the role');
    const srcData = (await call('GET', `/api/resumes/${jdResume}`)).json.data;
    r = await call('POST', `/api/resumes/${jdResume}/copy`);
    assert.equal(r.status, 201); assert.notEqual(r.json.id, jdResume); assert.equal(r.json.jd, ''); assert.equal(r.json.file, null);
    assert.deepEqual(r.json.data, srcData); assert.equal(r.json.title, 'Copy of Sample resume');
    const copyId = r.json.id;
    r = await call('GET', `/api/resumes/${jdResume}`);
    assert.equal(r.json.jd, posting.trim());
    r = await call('DELETE', `/api/resumes/${copyId}`); assert.equal(r.status, 200);
    ok('copy for another job: same content, empty job description, original untouched');
    r = await call('POST', `/api/resumes/${jdResume}/chat`, { message: 'make it better '.repeat(200) });
    assert.equal(r.status, 400); ok('over-long chat messages that are not job postings are refused');

    // Out of credits: the model is skipped and the built-in rules answer.
    const savedLlm = { ...config.llm };
    Object.assign(config.llm, { provider: 'openrouter', apiKeys: ['test-not-used'], model: 'test/model' });
    await col('users').updateOne({ _id: anaDoc._id }, { $set: { credits: 0 } });
    r = await call('POST', `/api/resumes/${jdResume}/chat`, { message: 'add skill Go' });
    Object.assign(config.llm, savedLlm);
    assert.equal(r.json.aiLimited, true); assert.equal(r.json.ai.credits, 0);
    assert.match(r.json.messages[1].text, /out of AI credits/); assert.ok(r.json.data.skills[0].items.includes('Go'));
    ok('with no credits left the model is not called and simple commands still work');

    // ---- admin ----
    r = await call('GET', '/api/admin/users');
    assert.equal(r.status, 403); ok('non-admins are refused on the admin API (403)');
    const anaCookie = cookie; cookie = '';
    r = await signIn('999', 'Boss@Example.com');
    assert.equal(r.json.user.isAdmin, true);
    r = await call('GET', '/api/admin/users');
    assert.equal(r.status, 200);
    const anaRow = r.json.users.find((u) => u.email === 'ana@example.com');
    assert.equal(anaRow.credits, 0); assert.equal(anaRow.creditsUsed, 4); assert.equal(anaRow.aiRequests, 2);
    assert.equal(anaRow.pdfDownloads, 1); assert.equal(anaRow.uploads, up ? 1 : 0); assert.equal(anaRow.resumes, up ? 2 : 1);
    assert.equal(r.json.totals.users, 3); ok('admin sees every user with credits, AI use, uploads, PDF downloads and resumes');
    // AI usage log: two OpenRouter attempts (one busy) and one NVIDIA answer.
    const ailog = require('../src/ailog');
    ailog.record({ task: 'chat', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', ok: false, ms: 300, tokens: 0, error: '429 rate limited' });
    ailog.record({ task: 'chat', provider: 'nvidia', model: 'minimaxai/minimax-m3.1-flash', ok: true, ms: 2500, tokens: 1400 });
    ailog.record({ task: 'spelling', provider: 'openrouter', model: 'baidu/ernie-5.5-flash-preview:free', ok: true, ms: 1800, tokens: 900 });
    await new Promise((res) => setTimeout(res, 200));
    r = await call('GET', '/api/admin/ai');
    assert.equal(r.status, 200); assert.equal(r.json.totals.calls, 3); assert.equal(r.json.totals.failed, 1);
    assert.equal(r.json.openrouterFree.used, 2); assert.equal(r.json.openrouterFree.limit, 50);
    assert.ok(['openrouter', 'nvidia'].includes(r.json.lastAnswer.provider)); // both answers share a timestamp here
    assert.ok(r.json.models.some((m) => m.provider === 'nvidia' && m.ok === 1 && m.tokens === 1400));
    assert.deepEqual(r.json.tasks.map((x) => x.task).sort(), ['chat', 'spelling']);
    assert.equal(r.json.recent.length, 3); assert.equal(r.json.days.at(-1).calls, 3);
    ok('admin AI usage: requests today by provider and model, OpenRouter free count, tasks, last 7 days, latest calls');
    const aistate = require('../src/aistate');
    aistate.rest('model:openrouter|test-model', Date.now() + 3600e3, 'test rest');
    await new Promise((res) => setTimeout(res, 200));
    assert.equal((await col('ai_state').findOne({ _id: 'model:openrouter|test-model' })).reason, 'test rest');
    r = await call('GET', '/api/admin/ai-routing');
    assert.equal(r.status, 200); assert.ok(Array.isArray(r.json.models)); assert.ok(r.json.openrouterFree);
    r = await call('POST', '/api/admin/ai-routing/reset');
    assert.equal(r.status, 200); assert.equal(await col('ai_state').countDocuments(), 0);
    ok('AI routing state is saved in the database; the admin can see it and reset it');
    r = await call('POST', `/api/admin/users/${anaRow.id}/credits`, { add: 50 });
    assert.equal(r.status, 200); assert.equal(r.json.credits, 50);
    r = await call('POST', `/api/admin/users/${anaRow.id}/credits`, { set: 500 });
    assert.equal(r.json.credits, 500); assert.equal(r.json.creditLog[0].by.toLowerCase(), 'boss@example.com'); assert.equal(r.json.creditLog[0].before, 50);
    r = await call('POST', `/api/admin/users/${anaRow.id}/credits`, { add: 1.5 });
    assert.equal(r.status, 400);
    r = await call('POST', `/api/admin/users/000000000000000000000000/credits`, { add: 5 });
    assert.equal(r.status, 404); ok('admin can add credits or set a balance, and each change is logged');
    cookie = anaCookie;
    r = await call('GET', '/api/me');
    assert.equal(r.json.ai.credits, 500); ok('the user sees the new balance');

    console.log('\nAll checks passed.');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    await closeBrowser();
    await db.close();
    await mongo.stop();
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
})();
