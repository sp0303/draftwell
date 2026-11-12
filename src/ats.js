// ATS match score: how well a resume fits a job description.
//
// The job's keywords are read once per job description (by the AI when it is
// available, else from a built-in list of common skills) and kept with the
// resume. Scoring itself is plain code: the same input always gives the same
// score, and checking costs no credits.
//
// 100 points:
//   40 job keywords        required ones count double; repeats past a point add nothing
//   20 relevant experience matching bullets near the top of each role
//   15 job title           headline / latest role vs the posting's title
//   15 readable format     contact details, standard sections, readable dates, one page
//   10 specific results    bullets with real numbers
// Without a job description only the format check runs (format + results, out of 100).

const crypto = require('crypto');

const MAX_KEYWORDS = 25;
const STUFFING = 8; // more mentions than this of one keyword reads as stuffing

const hashJd = (jd) => crypto.createHash('sha1').update(String(jd || '').trim()).digest('hex').slice(0, 16);

/* ---------- matching ---------- */
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Node.js" also matches "nodejs" and "node js"; "REST APIs" matches "REST API".
function termRe(term) {
  const raw = String(term).trim();
  if (!raw) return null;
  // Short terms ("Go", "CI", "ML") only match in the same case, so "go" and "ci" in plain English don't count.
  const exact = raw.replace(/[^A-Za-z0-9]/g, '').length <= 2;
  let t = exact ? raw : raw.toLowerCase();
  const plural = /[a-z]{3,}s$/.test(t) && !/(ss|us|is)$/.test(t);
  if (plural) t = t.slice(0, -1);
  const body = t.split(/[\s.\-/]+/).filter(Boolean).map(escRe).join('[\\s.\\-/]*');
  return new RegExp(`(?<![A-Za-z0-9+#])${body}${plural ? 's?' : ''}(?![A-Za-z0-9+#])`, exact ? 'g' : 'gi');
}
function countIn(text, kw) {
  let n = 0;
  for (const t of [kw.term, ...(kw.aliases || [])]) {
    const re = termRe(t);
    if (re) n = Math.max(n, (text.match(re) || []).length);
  }
  return n;
}
const hasKw = (text, kws) => kws.some((k) => countIn(text, k) > 0);

/* ---------- resume text ---------- */
function resumeText(d) {
  return [
    d.title, d.summary,
    ...(d.experience || []).flatMap((e) => [e.role, ...(e.bullets || [])]),
    ...(d.skills || []).flatMap((g) => g.items || []),
    ...(d.projects || []).flatMap((p) => [p.name, p.tech, ...(p.bullets || [])]),
    ...(d.certifications || []),
    ...(d.education || []).flatMap((e) => [e.degree, e.detail]),
  ].filter(Boolean).join('\n');
}
const allBullets = (d) => [...(d.experience || []).flatMap((e) => e.bullets || []), ...(d.projects || []).flatMap((p) => p.bullets || [])];

/* ---------- parts ---------- */
const DATE_OK = /((19|20)\d{2})|present|current/i;
function formatPart(d, onePage) {
  const contact = (d.contact || []).join(' ');
  const checks = [
    { ok: /[\w.+-]+@[\w-]+\.[\w.]+/.test(contact), pts: 3, yes: 'Email found in the header', no: 'Add your email address to the header' },
    { ok: /\+?\d[\d\s().-]{8,}\d/.test(contact), pts: 2, yes: 'Phone number found', no: 'Add a phone number to the header' },
    { ok: (d.experience || []).length > 0, pts: 3, yes: 'Experience section with roles', no: 'Add an Experience section' },
    { ok: (d.experience || []).length > 0 && d.experience.every((e) => DATE_OK.test(e.dates || '')), pts: 2, yes: 'Every role has dates a parser can read', no: 'Give every role a date range like "Jan 2023 – Present"' },
    { ok: (d.skills || []).some((g) => g.items.length), pts: 2, yes: 'Skills section present', no: 'Add a Skills section' },
    { ok: Boolean(d.summary), pts: 1, yes: 'Summary present', no: 'Add a short summary' },
    { ok: onePage !== false, pts: 2, yes: 'Fits on one page', no: 'Trim the resume to one page' },
  ];
  return { score: checks.reduce((a, c) => a + (c.ok ? c.pts : 0), 0), max: 15, checks: checks.map((c) => ({ ok: c.ok, text: c.ok ? c.yes : c.no })) };
}
function resultsPart(d) {
  const b = allBullets(d);
  const withNum = b.filter((x) => /\d/.test(x)).length;
  // Half the bullets with a number earns full marks.
  const score = b.length ? Math.round(Math.min(1, withNum / Math.max(1, b.length * 0.5)) * 10) : 0;
  return { score, max: 10, withNum, total: b.length };
}

const TITLE_NOISE = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal', 'i', 'ii', 'iii', 'iv', 'the', 'a', 'an', 'and', 'of', 'for', 'at', 'in', 'to', 'with', 'remote', 'hybrid', 'full', 'time', 'part', 'contract']);
const titleWords = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w && !TITLE_NOISE.has(w)));
function titlePart(d, jobTitle) {
  const want = titleWords(jobTitle);
  if (!want.size) return { score: 15, max: 15 };
  const best = [d.title, ...(d.experience || []).slice(0, 2).map((e) => e.role)].reduce((top, t) => {
    const have = titleWords(t);
    const common = [...want].filter((w) => have.has(w)).length;
    return Math.max(top, common / want.size);
  }, 0);
  return { score: Math.round(best * 15), max: 15 };
}
function relevancePart(d, kws) {
  const roles = (d.experience || []).filter((e) => (e.bullets || []).length);
  if (!roles.length || !kws.length) return { score: 0, max: 20 };
  const topShare = roles.filter((e) => hasKw(e.bullets[0], kws)).length / roles.length;
  const b = allBullets(d);
  const bulletShare = b.filter((x) => hasKw(x, kws)).length / b.length;
  return { score: Math.round((0.6 * topShare + 0.4 * Math.min(1, bulletShare / 0.6)) * 20), max: 20, topShare };
}

/* ---------- the score ---------- */
/**
 * @param {object} d        resume data (schema.js shape)
 * @param {{title: string, keywords: {term: string, required: boolean, aliases?: string[]}[]}|null} job
 * @param {{onePage?: boolean}} opts
 */
function score(d, job, opts = {}) {
  const format = formatPart(d, opts.onePage);
  const results = resultsPart(d);
  if (!job || !(job.keywords || []).length) {
    return {
      mode: 'format',
      score: Math.round(((format.score + results.score) / (format.max + results.max)) * 100),
      checks: [...format.checks, { ok: results.score >= 7, text: `${results.withNum} of ${results.total} bullets have a number` }],
    };
  }

  const text = resumeText(d);
  const kws = job.keywords;
  let got = 0;
  let total = 0;
  const hits = [];
  const misses = [];
  const stuffed = [];
  for (const k of kws) {
    const w = k.required ? 2 : 1;
    const n = countIn(text, k);
    total += w;
    if (n > STUFFING) { stuffed.push({ term: k.term, count: n }); got += w * 0.5; hits.push({ term: k.term, required: Boolean(k.required), count: n }); }
    else if (n > 0) { got += w; hits.push({ term: k.term, required: Boolean(k.required), count: n }); }
    else misses.push({ term: k.term, required: Boolean(k.required) });
  }
  const keywords = { score: Math.round((got / total) * 40), max: 40 };
  const relevance = relevancePart(d, kws);
  const title = titlePart(d, job.title);
  const parts = [
    { id: 'keywords', label: 'Job keywords', ...keywords },
    { id: 'relevance', label: 'Relevant experience', score: relevance.score, max: 20 },
    { id: 'title', label: 'Job title', ...title },
    { id: 'format', label: 'Readable format', score: format.score, max: 15 },
    { id: 'results', label: 'Specific results', score: results.score, max: 10 },
  ];
  const total100 = parts.reduce((a, p) => a + p.score, 0);

  // Fixes: each is a precise request the assistant can carry out without inventing anything.
  const fixes = [];
  const reqMiss = misses.filter((m) => m.required).map((m) => m.term);
  if (stuffed.length) {
    fixes.push({ id: 'stuffing', title: `"${stuffed[0].term}" appears ${stuffed[0].count} times`, detail: 'Repeating a keyword this often reads as stuffing, so the extra mentions add nothing.',
      message: `Reduce how often ${stuffed.map((s) => `"${s.term}"`).join(', ')} appear to 2 or 3 natural mentions each.` });
  }
  if (title.score < 10 && job.title) {
    fixes.push({ id: 'title', title: 'Match the job title', detail: `The job is "${job.title}"; your headline is "${d.title || 'empty'}".`,
      message: `Change my headline to match the job title "${job.title}" where my experience supports it.` });
  }
  if (reqMiss.length) {
    fixes.push({ id: 'wording', title: "Use the job's wording", detail: `Required and not found: ${reqMiss.slice(0, 6).join(', ')}${reqMiss.length > 6 ? '…' : ''}.`,
      message: `Where my resume already shows it, use the job's wording for: ${reqMiss.join(', ')}. Do not add anything I haven't done; tell me which ones you left out.` });
  }
  if (relevance.max && relevance.topShare !== undefined && relevance.topShare < 1) {
    fixes.push({ id: 'order', title: 'Lead with relevant work', detail: 'Some roles start with a bullet that has none of the job\'s keywords.',
      message: 'Move the bullets most relevant to the job description to the top of each role. Keep the wording.' });
  }
  if (results.score < 7 && results.total) {
    fixes.push({ id: 'numbers', title: 'Add real numbers', detail: `${results.withNum} of ${results.total} bullets have a number.`,
      message: 'Tell me which bullets would be stronger with a number, and ask me for the real figures. Do not make any up.' });
  }
  for (const c of format.checks) if (!c.ok) fixes.push({ id: `format-${fixes.length}`, title: c.text, detail: 'Readable format', message: null });

  return {
    mode: 'match', score: total100, jobTitle: job.title || '', parts,
    hits, misses, stuffed, fixes,
    found: hits.length, totalKeywords: kws.length, requiredMissing: reqMiss.length,
  };
}

/* ---------- reading a job's keywords without the AI ---------- */
// Common skills and tools, with other spellings. Used when the AI is off or out of credits.
const DICT = [
  ['JavaScript', 'JS', 'ES6'], ['TypeScript', 'TS'], ['Python'], ['Java'], ['Kotlin'], ['Swift'], ['Go', 'Golang'], ['Rust'], ['C++'], ['C#', '.NET', 'dotnet'], ['PHP'], ['Ruby', 'Rails', 'Ruby on Rails'], ['Scala'],
  ['SQL'], ['PostgreSQL', 'Postgres'], ['MySQL'], ['MongoDB', 'Mongo'], ['Redis'], ['Elasticsearch'], ['DynamoDB'], ['Snowflake'], ['BigQuery'],
  ['React', 'React.js', 'ReactJS'], ['Next.js', 'NextJS'], ['Vue', 'Vue.js'], ['Angular'], ['Svelte'], ['Redux'], ['HTML', 'HTML5'], ['CSS', 'CSS3'], ['Tailwind', 'Tailwind CSS'], ['Sass', 'SCSS'],
  ['Node.js', 'NodeJS', 'Node'], ['Express'], ['NestJS'], ['Django'], ['Flask'], ['FastAPI'], ['Spring', 'Spring Boot'], ['GraphQL'], ['REST APIs', 'REST', 'RESTful'], ['gRPC'], ['Microservices'],
  ['AWS', 'Amazon Web Services'], ['GCP', 'Google Cloud'], ['Azure'], ['Docker'], ['Kubernetes', 'K8s'], ['Terraform'], ['CI/CD', 'CI', 'continuous integration'], ['Jenkins'], ['GitHub Actions'], ['Linux'], ['Git'],
  ['Kafka'], ['RabbitMQ'], ['Spark'], ['Airflow'], ['Pandas'], ['NumPy'], ['TensorFlow'], ['PyTorch'], ['Machine learning', 'ML'], ['Deep learning'], ['LLM', 'LLMs', 'large language models'], ['NLP'], ['Computer vision'], ['Data analysis'], ['Power BI'], ['Tableau'], ['Excel'],
  ['Testing', 'unit tests', 'integration tests', 'test automation'], ['Jest'], ['Cypress'], ['Playwright'], ['Selenium'], ['TDD'],
  ['Accessibility', 'WCAG', 'a11y'], ['Performance', 'performance optimisation', 'performance optimization'], ['Code splitting'], ['Design systems', 'design system'], ['Component library', 'component libraries'], ['Responsive design', 'responsive'], ['Figma'], ['UX'], ['SEO'],
  ['Security', 'OWASP'], ['OAuth'], ['Payments', 'payment'], ['Fintech'], ['E-commerce', 'ecommerce'], ['SaaS'],
  ['Agile', 'Scrum'], ['Jira'], ['System design'], ['Distributed systems'], ['Mobile', 'iOS', 'Android'], ['React Native'], ['Flutter'],
  ['Product management'], ['Stakeholder management'], ['Project management'], ['Communication'], ['Leadership'], ['Mentoring'],
];
const OPTIONAL_HEAD = /(nice to have|nice-to-have|preferred|bonus|good to have|plus\b|desirable)/i;

function jobTitleFrom(jd) {
  const first = String(jd || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return first.split(/\s+(?:at|@|·|\||–|—|-)\s+|\s*[(,]/)[0].trim().slice(0, 80);
}
function keywordsByRules(jd) {
  // The first line is usually the title and company ("Frontend Engineer, Acme Fintech"): leave it out.
  const lines = String(jd || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(1);
  const text = lines.join('\n');
  const optFrom = lines.findIndex((l) => OPTIONAL_HEAD.test(l));
  const optText = optFrom >= 0 ? lines.slice(optFrom).join('\n') : '';
  const mainText = optFrom >= 0 ? lines.slice(0, optFrom).join('\n') : text;
  const out = [];
  for (const [term, ...aliases] of DICT) {
    const kw = { term, aliases };
    const inMain = countIn(mainText, kw) > 0;
    const inOpt = countIn(optText, kw) > 0;
    if (inMain || inOpt) out.push({ term, aliases, required: inMain });
  }
  return { title: jobTitleFrom(jd), keywords: out.slice(0, MAX_KEYWORDS) };
}

// Clean up whatever the AI returned into the shape score() expects.
function normalizeJob(j, jd) {
  const seen = new Set();
  const keywords = (Array.isArray(j && j.keywords) ? j.keywords : []).map((k) => ({
    term: String((k && k.term) || '').trim().slice(0, 60),
    required: Boolean(k && k.required),
    aliases: (Array.isArray(k && k.aliases) ? k.aliases : []).map((a) => String(a).trim().slice(0, 60)).filter(Boolean).slice(0, 5),
  })).filter((k) => k.term && !seen.has(k.term.toLowerCase()) && seen.add(k.term.toLowerCase())).slice(0, MAX_KEYWORDS);
  return { title: String((j && j.title) || jobTitleFrom(jd)).trim().slice(0, 100), keywords };
}

module.exports = { score, keywordsByRules, normalizeJob, hashJd, countIn, termRe, MAX_KEYWORDS };
