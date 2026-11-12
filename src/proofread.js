// Spelling and grammar check. The AI reads every line of the resume and
// returns small, exact replacements; this file decides which of them are safe
// to show. Nothing is applied here: the person picks each fix in the editor.

const KINDS = ['spelling', 'grammar', 'punctuation', 'consistency'];
const MAX_ISSUES = 40;

// Every editable line of the resume, by its path in the data ("experience.0.bullets.2").
function fields(d) {
  const out = [];
  const add = (path, text) => { if (typeof text === 'string' && text.trim()) out.push({ path, text }); };
  add('title', d.title);
  add('summary', d.summary);
  (d.experience || []).forEach((e, i) => {
    add(`experience.${i}.role`, e.role);
    add(`experience.${i}.org`, e.org);
    (e.bullets || []).forEach((b, j) => add(`experience.${i}.bullets.${j}`, b));
  });
  (d.education || []).forEach((e, i) => { add(`education.${i}.degree`, e.degree); add(`education.${i}.detail`, e.detail); });
  (d.skills || []).forEach((g, i) => { add(`skills.${i}.group`, g.group); (g.items || []).forEach((s, j) => add(`skills.${i}.items.${j}`, s)); });
  (d.projects || []).forEach((p, i) => {
    add(`projects.${i}.name`, p.name);
    (p.bullets || []).forEach((b, j) => add(`projects.${i}.bullets.${j}`, b));
  });
  (d.certifications || []).forEach((c, i) => add(`certifications.${i}`, c));
  return out;
}

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

/**
 * Keep only issues that point at a real line, quote text that is really there,
 * and change it. Drops duplicates and anything that rewrites more than a phrase.
 */
function validate(d, issues) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(issues) ? issues : []) {
    if (!it || typeof it !== 'object') continue;
    const path = String(it.path || '');
    const original = String(it.original || '');
    const fixed = String(it.fixed == null ? '' : it.fixed);
    if (!/^[a-z]+(\.\d+|\.[a-z]+)*$/.test(path)) continue;
    const text = getPath(d, path);
    if (typeof text !== 'string' || !original || original === fixed) continue;
    if (!text.includes(original)) continue;
    // A proofreading fix is small. Longer rewrites belong in the chat, where the person sees them.
    if (original.length > 160 || fixed.length > original.length + 60) continue;
    const key = `${path}|${original}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${out.length}`,
      path, original, fixed,
      kind: KINDS.includes(it.kind) ? it.kind : 'grammar',
      why: String(it.why || '').trim().slice(0, 160),
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

module.exports = { fields, validate, KINDS };
