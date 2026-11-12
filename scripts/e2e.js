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
      fd.append('resume', new Blob([fs.readFileSync(file)], { type: 'application/pdf' }), path.basename(file));
      up = await call('POST', '/api/resumes', fd);
      assert.equal(up.status, 201, JSON.stringify(up.json));
      const d = up.json.data;
      console.log(`  ok  upload parsed: name="${d.name}", ${d.experience.length} roles, ${d.skills.length} skill groups, ${d.projects.length} projects, ${d.education.length} schools, ${d.contact.length} contact items`);
      const stored = fs.readdirSync(process.env.UPLOAD_DIR, { recursive: true }).filter((f) => /\.pdf$/.test(f));
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
