const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { col, toId } = require('./db');
const { normalize, isTheme, isAccent } = require('./schema');
const { fileToText, parseText } = require('./extract');
const llm = require('./llm');
const assistant = require('./assistant');
const { renderPdf } = require('./pdf');
const SAMPLE = require('./sample');
const auth = require('./auth');
const credits = require('./credits');
const ats = require('./ats');
const admin = require('./admin');

const MAX_JD = 8000;
const MAX_MESSAGE = 2000;
const MAX_RESUMES = 200;
// First line of a job description, for lists ("Frontend Engineer, Acme").
const jobLine = (jd) => String(jd || '').split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 120) || '';
const LIMIT_NOTE = 'You are out of AI credits, so I can only handle simple commands (like "add skill X" or "switch to the Modern theme"). Ask the admin for more credits.';
// A paste that reads like a job posting, or a long multi-line paste.
const JD_HINT = /\b(responsibilit|requirements?\b|qualifications?\b|about the role|about the job|what you['’]ll do|we['’]re looking for|we are looking for|job description|years of experience|nice to have|must have)/i;
const looksLikeJd = (s) => (s.length >= 300 && JD_HINT.test(s)) || (s.length > 1200 && (s.match(/\n/g) || []).length >= 4);
const DEFAULT_ACCENT = '#1f3a5f';
const ALLOWED = { '.pdf': ['application/pdf'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], '.txt': ['text/plain'] };

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ---------- uploads: original files on disk, one folder per user ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(config.uploadDir, String(req.user._id));
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = ALLOWED[ext] && (ALLOWED[ext].includes(file.mimetype) || file.mimetype === 'application/octet-stream');
    cb(ok ? null : httpError(400, 'Upload a PDF, DOCX or TXT file.'), Boolean(ok));
  },
});

/* ---------- helpers ---------- */
async function loadOwned(req) {
  const id = toId(req.params.id);
  if (!id) throw httpError(404, 'Resume not found');
  const doc = await col('resumes').findOne({ _id: id, userId: req.user._id });
  if (!doc) throw httpError(404, 'Resume not found');
  return doc;
}

function publicResume(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    file: doc.file ? { name: doc.file.originalName, size: doc.file.size } : null,
    extractedBy: doc.extractedBy,
    data: doc.data,
    theme: doc.theme,
    accent: doc.accent,
    chat: doc.chat || [],
    jd: doc.jd || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function createResume(user, fields) {
  const now = new Date();
  const doc = { userId: user._id, theme: 'classic', accent: DEFAULT_ACCENT, chat: [], createdAt: now, updatedAt: now, ...fields };
  const { insertedId } = await col('resumes').insertOne(doc);
  return { ...doc, _id: insertedId };
}

// index.html with a content hash on every /css and /js link, so browsers (and
// Cloudflare's browser cache, which keeps assets for hours) pick up new code
// right after a deploy. Built once at startup.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
function buildIndexHtml() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  return html.replace(/(href|src)="(\/(?:css|js)\/[^"?]+)"/g, (m, attr, url) => {
    const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC_DIR, url))).digest('hex').slice(0, 10);
    return `${attr}="${url}?v=${hash}"`;
  });
}

const safeFileName = (s) => (s || 'resume').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'resume';

/* ---------- app ---------- */
function createApp({ verifyGoogleCredential = auth.verifyGoogleCredential } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      // Google Identity Services needs its script, button iframe and styles.
      'Content-Security-Policy': [
        "default-src 'self'",
        // Cloudflare injects its Web Analytics beacon into pages it proxies.
        "script-src 'self' https://accounts.google.com/gsi/client https://static.cloudflareinsights.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://*.googleusercontent.com",
        "frame-src https://accounts.google.com/gsi/",
        "connect-src 'self' https://accounts.google.com/gsi/ https://cloudflareinsights.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // Google's sign-in popup talks back to this page, so keep popups working.
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  const indexHtml = buildIndexHtml();
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/health', (req, res) => res.json({ ok: true, llm: llm.isConfigured() }));
  app.get('/api/sample', (req, res) => res.json(normalize(SAMPLE)));

  const api = express.Router();
  api.use(wrap(auth.loadUser));

  api.get('/me', (req, res) => res.json({
    user: auth.publicUser(req.user),
    googleClientId: config.googleClientId || null,
    ai: req.user ? credits.status(req.user) : null,
  }));

  api.post('/auth/google', wrap(async (req, res) => {
    const credential = req.body && typeof req.body.credential === 'string' ? req.body.credential : '';
    if (!credential) throw httpError(400, 'Missing Google credential');
    const profile = await verifyGoogleCredential(credential);
    const user = await auth.signIn(req, res, profile);
    res.json({ user: auth.publicUser(user), ai: credits.status(user) });
  }));

  api.post('/auth/logout', wrap(async (req, res) => {
    await auth.signOut(req, res);
    res.json({ ok: true });
  }));

  // Everything below needs a signed-in user.
  api.use(auth.requireUser);

  // Admin pages: only for the Google accounts in ADMIN_EMAILS.
  api.use('/admin', admin.router());

  api.get('/resumes', wrap(async (req, res) => {
    const docs = await col('resumes')
      .find({ userId: req.user._id }, { projection: { title: 1, theme: 1, updatedAt: 1, file: 1, 'data.name': 1, jd: 1 } })
      .sort({ updatedAt: -1 }).limit(200).toArray();
    res.json(docs.map((d) => ({
      id: String(d._id), title: d.title, name: d.data && d.data.name, theme: d.theme, updatedAt: d.updatedAt, hasFile: Boolean(d.file),
      job: jobLine(d.jd),
    })));
  }));

  // A new copy of a resume to tailor to another job. The uploaded file stays with the original.
  api.post('/resumes/:id/copy', wrap(async (req, res) => {
    const src = await loadOwned(req);
    if (await col('resumes').countDocuments({ userId: req.user._id }) >= MAX_RESUMES) {
      throw httpError(400, `You can keep up to ${MAX_RESUMES} resumes. Delete some old ones first.`);
    }
    const base = String(src.title || 'Resume').replace(/^Copy of /, '').slice(0, 100);
    const doc = await createResume(req.user, {
      title: `Copy of ${base}`, file: null, rawText: src.rawText || '', extractedBy: src.extractedBy, copiedFrom: src._id,
      data: src.data, theme: src.theme, accent: src.accent, jd: '',
    });
    res.status(201).json(publicResume(doc));
  }));

  api.post('/resumes', (req, res, next) => upload.single('resume')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return next(httpError(400, 'That file is over 10 MB. Upload a smaller copy.'));
    next(err);
  }), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'Choose a resume file to upload.');
    let rawText = '';
    let data;
    let extractedBy = 'rules';
    try {
      rawText = await fileToText(req.file.path);
    } catch (e) {
      await fsp.unlink(req.file.path).catch(() => {});
      throw httpError(400, 'We could not read that file. If it is a scanned image, upload a text-based PDF or a Word file.');
    }
    if (!rawText.trim()) {
      await fsp.unlink(req.file.path).catch(() => {});
      throw httpError(400, 'That file has no readable text. If it is a scanned image, upload a text-based PDF or a Word file.');
    }
    let aiLimited = false;
    if (llm.isConfigured() && !credits.hasCredits(req.user)) aiLimited = true;
    else if (llm.isConfigured()) {
      try {
        const out = await llm.extractResume(rawText);
        await credits.charge(req.user, out.tokens);
        data = normalize(out.data); extractedBy = 'llm';
      } catch (e) {
        if (e.tokens) await credits.charge(req.user, e.tokens);
        console.error('LLM extraction failed, using rules:', e.message);
      }
    }
    if (!data) data = parseText(rawText);

    const doc = await createResume(req.user, {
      title: req.file.originalname.slice(0, 120),
      file: { storedPath: path.relative(config.uploadDir, req.file.path), originalName: req.file.originalname.slice(0, 200), size: req.file.size, mime: req.file.mimetype },
      rawText: rawText.slice(0, 100000),
      extractedBy,
      data,
    });
    await credits.count(req.user, 'uploads');
    res.status(201).json({ ...publicResume(doc), aiLimited, ai: credits.status(req.user) });
  }));

  api.post('/resumes/sample', wrap(async (req, res) => {
    const doc = await createResume(req.user, { title: 'Sample resume', file: null, rawText: '', extractedBy: 'sample', data: normalize(SAMPLE) });
    res.status(201).json(publicResume(doc));
  }));

  api.get('/resumes/:id', wrap(async (req, res) => res.json(publicResume(await loadOwned(req)))));

  api.patch('/resumes/:id', wrap(async (req, res) => {
    const doc = await loadOwned(req);
    const set = { updatedAt: new Date() };
    const b = req.body || {};
    if (b.data !== undefined) set.data = normalize(b.data);
    if (b.theme !== undefined) { if (!isTheme(b.theme)) throw httpError(400, 'Unknown theme'); set.theme = b.theme; }
    if (b.accent !== undefined) { if (!isAccent(b.accent)) throw httpError(400, 'Accent must be a hex color like #1f3a5f'); set.accent = b.accent; }
    if (typeof b.title === 'string' && b.title.trim()) set.title = b.title.trim().slice(0, 120);
    if (b.jd !== undefined) {
      if (typeof b.jd !== 'string') throw httpError(400, 'The job description must be text.');
      if (b.jd.length > MAX_JD) throw httpError(400, `Keep the job description under ${MAX_JD.toLocaleString('en-US')} characters.`);
      set.jd = b.jd.trim();
    }
    await col('resumes').updateOne({ _id: doc._id }, { $set: set });
    res.json({ ok: true, updatedAt: set.updatedAt, data: set.data });
  }));

  api.delete('/resumes/:id', wrap(async (req, res) => {
    const doc = await loadOwned(req);
    await col('resumes').deleteOne({ _id: doc._id });
    if (doc.file) await fsp.unlink(path.join(config.uploadDir, doc.file.storedPath)).catch(() => {});
    res.json({ ok: true });
  }));

  api.post('/resumes/:id/chat', wrap(async (req, res) => {
    const doc = await loadOwned(req);
    const raw = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!raw) throw httpError(400, 'Type a message first.');
    // A job posting pasted into the chat becomes the target job, and we tailor to it.
    const pastedJd = looksLikeJd(raw);
    if (!pastedJd && raw.length > MAX_MESSAGE) throw httpError(400, 'Keep messages under 2,000 characters. To tailor to a job, paste its description into the Target job box.');
    if (pastedJd) doc.jd = raw.slice(0, MAX_JD);
    const message = pastedJd ? 'Tailor my resume to this job description.' : raw;
    const shown = pastedJd ? `Pasted a job description (${raw.length.toLocaleString('en-US')} characters). Tailor my resume to it.` : raw;

    let out;
    let aiLimited = false;
    if (llm.isConfigured() && !credits.hasCredits(req.user)) aiLimited = true;
    else if (llm.isConfigured()) {
      try {
        out = await llm.chat({ data: doc.data, theme: doc.theme, message, jd: doc.jd || '', history: (doc.chat || []).slice(-20) });
        await credits.charge(req.user, out.tokens);
      } catch (e) {
        out = undefined;
        if (e.tokens) await credits.charge(req.user, e.tokens);
        console.error('LLM chat failed, using rules:', e.message);
      }
    }
    if (!out) {
      const wantsTailor = /\b(tailor|job description|jd)\b/i.test(message);
      out = wantsTailor
        ? { reply: doc.jd
          ? 'Tailoring to a job description needs the AI model, which is not available right now. Try again later.'
          : 'Add the job description first (the "Target job" box above the chat), then ask me to tailor your resume.' }
        : assistant.respond(doc.data, doc.theme, message);
      if (aiLimited) out.reply = `${LIMIT_NOTE}\n\n${out.reply}`;
    }

    const data = out.data ? normalize(out.data) : doc.data;
    const theme = isTheme(out.theme) ? out.theme : doc.theme;
    const now = new Date();
    const msgs = [
      { role: 'user', text: shown, at: now },
      { role: 'assistant', text: String(out.reply || '').slice(0, 4000), change: out.change || null, at: now },
    ];
    await col('resumes').updateOne({ _id: doc._id }, {
      $set: { data, theme, updatedAt: now, ...(pastedJd ? { jd: doc.jd } : {}) },
      $push: { chat: { $each: msgs, $slice: -200 } },
    });
    res.json({ messages: msgs, data, theme, jd: doc.jd || '', section: out.section || null, aiLimited, ai: credits.status(req.user) });
  }));

  // ATS match score against the target job. Keywords are read once per job
  // description (AI when available, else built-in rules) and cached on the resume.
  api.post('/resumes/:id/ats', wrap(async (req, res) => {
    const doc = await loadOwned(req);
    const onePage = !(req.body && req.body.onePage === false);
    const jd = (doc.jd || '').trim();
    if (!jd) return res.json({ ...ats.score(doc.data, null, { onePage }), ai: credits.status(req.user) });

    const hash = ats.hashJd(jd);
    let job = doc.ats && doc.ats.jdHash === hash ? doc.ats : null;
    // Rules-read keywords are upgraded to AI-read ones once the AI is available again.
    if (!job || (job.by === 'rules' && llm.isConfigured() && credits.hasCredits(req.user) && req.body && req.body.upgrade)) {
      let read = null;
      let by = 'rules';
      if (llm.isConfigured() && credits.hasCredits(req.user)) {
        try {
          const out = await llm.jobKeywords(jd);
          await credits.charge(req.user, out.tokens);
          read = ats.normalizeJob(out.job, jd);
          if (read.keywords.length) by = 'ai'; else read = null;
        } catch (e) {
          if (e.tokens) await credits.charge(req.user, e.tokens);
          console.error('LLM job keywords failed, using rules:', e.message);
        }
      }
      if (!read) read = ats.keywordsByRules(jd);
      job = { jdHash: hash, by, title: read.title, keywords: read.keywords, at: new Date() };
      await col('resumes').updateOne({ _id: doc._id }, { $set: { ats: job } });
    }
    res.json({ ...ats.score(doc.data, job, { onePage }), keywordsBy: job.by, keywords: job.keywords, ai: credits.status(req.user) });
  }));

  api.get('/resumes/:id/pdf', wrap(async (req, res) => {
    const doc = await loadOwned(req);
    const pdf = await renderPdf(doc.data, doc.theme, doc.accent);
    await credits.count(req.user, 'pdfDownloads');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeFileName(doc.data.name)}_Resume.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(pdf));
  }));

  api.get('/resumes/:id/file', wrap(async (req, res) => {
    const doc = await loadOwned(req);
    if (!doc.file) throw httpError(404, 'This resume has no uploaded file');
    const full = path.join(config.uploadDir, doc.file.storedPath);
    if (!full.startsWith(config.uploadDir)) throw httpError(404, 'File not found');
    res.download(full, doc.file.originalName);
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side. Try again.' : err.message });
  });

  return app;
}

module.exports = { createApp };
