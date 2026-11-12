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
  process.env.ADMIN_EMAILS = 'boss@example.com';
  process.env.AI_STARTING_CREDITS = '100';
  const { parseJson } = require('../src/llm');
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! Here it is: {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
  assert.equal(parseJson('no json here'), null);
  console.log('  ok  model replies with code fences or extra text are parsed');
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
    ok('SEO: description, canonical, social card, structured data, robots, sitemap, favicon, manifest, 404 page');

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
    Object.assign(config.llm, { provider: 'openrouter', apiKey: 'test-not-used', model: 'test/model' });
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
