// Turns an uploaded file into plain text, then into structured resume data.
// The rule-based parser is a fallback; when an LLM is configured, server.js
// sends the text to llm.extractResume() instead.

const fs = require('fs/promises');
const path = require('path');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const mammoth = require('mammoth');
const { normalize } = require('./schema');

async function fileToText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);
  if (ext === '.pdf') return (await pdfParse(buf)).text;
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer: buf })).value;
  return buf.toString('utf8');
}

const HEADINGS = [
  ['summary', /^(professional )?(summary|profile|about( me)?|objective|career objective)$/],
  ['experience', /^(work |professional )?(experience|employment( history)?|work history)$/],
  ['education', /^(education|academics|academic background)$/],
  ['skills', /^(technical |key |core )?(skills|competencies|technologies|tech stack)$/],
  ['projects', /^(personal |key |academic )?projects$/],
  ['certifications', /^(certifications?|certificates|licenses|awards|achievements)$/],
];
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_RANGE = new RegExp(`((${MONTH}\\s*)?(19|20)\\d{2})\\s*(-|–|—|to)\\s*((${MONTH}\\s*)?(19|20)\\d{2}|present|current|now)`, 'i');
const YEAR = /(?<!\d)(19|20)\d{2}(?!\d)/;
const BULLET = /^[•●▪◦*\-–·]\s*/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /\+?\d[\d\s().-]{8,}\d/;
const LINK = /\b((https?:\/\/)?(www\.)?(linkedin\.com|github\.com|gitlab\.com|behance\.net)\/[\w\-/.]+)/i;

function headingOf(line) {
  const t = line.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return null;
  const hit = HEADINGS.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

function splitHeader(line) {
  const m = line.match(DATE_RANGE);
  const dates = m ? m[0].replace(/\s*(-|–|—|to)\s*/i, ' – ') : '';
  const rest = (m ? line.replace(m[0], '') : line).replace(/[|,–—-]\s*$/, '').trim();
  const parts = rest.split(/\s+(?:—|–|-|\||@|at)\s+|\s{2,}|\t|,\s(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  return { dates, parts };
}

// Group lines into entries: a non-bullet line starts a new entry once the
// current one already has bullets, or when it carries a date range.
function entries(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const isBullet = BULLET.test(raw);
    const line = raw.replace(BULLET, '').trim();
    if (!line) continue;
    if (isBullet) {
      if (!cur) out.push((cur = { head: [], bullets: [] }));
      cur.bullets.push(line);
      continue;
    }
    const last = cur && cur.bullets[cur.bullets.length - 1];
    // Wrapped bullet: starts lowercase, or the bullet so far has no closing punctuation.
    if (last && !DATE_RANGE.test(line) && (/^[a-z(]/.test(line) || !/[.!?;:)]$/.test(last))) {
      cur.bullets[cur.bullets.length - 1] = `${last} ${line}`; // wrapped bullet line
      continue;
    }
    if (!cur || cur.bullets.length || DATE_RANGE.test(line) && cur.head.some((h) => DATE_RANGE.test(h))) {
      out.push((cur = { head: [], bullets: [] }));
    }
    cur.head.push(line);
  }
  return out;
}

function parseText(text) {
  const rawLines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // PDFs made with LaTeX often put each bullet symbol on its own line; join it to the text after it.
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (/^[•●▪◦*\-–·]$/.test(rawLines[i]) && rawLines[i + 1]) lines.push(`• ${rawLines[++i]}`);
    else lines.push(rawLines[i]);
  }
  const data = { name: '', title: '', contact: [], summary: '', experience: [], education: [], skills: [], projects: [], certifications: [] };
  const sections = { top: [] };
  let at = 'top';
  for (const l of lines) {
    const h = headingOf(l);
    if (h) { at = h; sections[h] = sections[h] || []; continue; }
    (sections[at] = sections[at] || []).push(l);
  }

  // Header: name, title and contact details.
  for (const l of sections.top) {
    const bits = l.split(/\s*[|•·]\s*/).filter(Boolean);
    let usedAsContact = false;
    for (const b of bits) {
      const v = (b.match(EMAIL) || b.match(LINK) || b.match(PHONE) || [])[0];
      if (v) { data.contact.push(v.trim()); usedAsContact = true; }
    }
    if (usedAsContact) continue;
    if (!data.name && l.split(' ').length <= 5 && !/\d/.test(l)) { data.name = l; continue; }
    if (data.name && l.length < 60 && /,/.test(l) && l.split(' ').length <= 6) { data.contact.unshift(l); continue; } // a location like "City, State"
    if (data.name && !data.title && l.length < 80) data.title = l;
  }

  data.summary = (sections.summary || []).join(' ');

  data.experience = entries(sections.experience || []).map((e) => {
    const { dates, parts } = splitHeader(e.head.join('  '));
    return { role: parts[0] || '', org: parts.slice(1).join(', '), dates, bullets: e.bullets };
  });

  data.projects = entries(sections.projects || []).map((e) => {
    const head = e.head.join('  ');
    const year = (head.match(YEAR) || [''])[0];
    const [name, ...tech] = head.replace(year, '').split(/\s*\|\s*|\s{2,}/).filter(Boolean);
    return { name: (name || '').trim(), tech: tech.join(', '), year, bullets: e.bullets };
  });

  data.education = entries(sections.education || []).map((e) => {
    const all = e.head.concat(e.bullets).join('  ');
    const dm = all.match(DATE_RANGE) || all.match(YEAR);
    const [school, degree, ...rest] = all.replace(dm ? dm[0] : '', '').split(/\s{2,}|\t/).map((s) => s.trim()).filter(Boolean);
    return { school: school || '', degree: degree || '', dates: dm ? dm[0].replace(/\s*(-|–|—|to)\s*/i, ' – ') : '', detail: rest.join(', ') };
  });

  for (const l of sections.skills || []) {
    const line = l.replace(BULLET, '');
    const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
    const items = (m ? m[2] : line).split(/\s*[,|•·;]\s*/).filter(Boolean);
    if (m) data.skills.push({ group: m[1].trim(), items });
    else if (data.skills.length && !data.skills[data.skills.length - 1].named) data.skills[data.skills.length - 1].items.push(...items);
    else data.skills.push({ group: 'Skills', items });
    if (m) data.skills[data.skills.length - 1].named = true;
  }

  data.certifications = (sections.certifications || []).map((l) => l.replace(BULLET, '').replace(/^[^\p{L}\p{N}(]+/u, ''));
  return normalize(data);
}

module.exports = { fileToText, parseText };
