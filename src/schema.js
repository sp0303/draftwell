// Normalizes resume data from any source (uploads, the browser, the LLM)
// into one predictable shape, with length caps so bad input can't bloat the database.

const str = (v, max = 400) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const list = (v, max, fn) => (Array.isArray(v) ? v : []).slice(0, max).map(fn);
const strList = (v, max, len) => list(v, max, (x) => str(x, len)).filter(Boolean);

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    name: str(d.name, 120),
    title: str(d.title, 160),
    contact: strList(d.contact, 8, 160),
    summary: str(d.summary, 1500),
    experience: list(d.experience, 15, (e) => ({
      role: str(e && e.role, 160),
      org: str(e && e.org, 160),
      dates: str(e && e.dates, 60),
      bullets: strList(e && e.bullets, 12, 400),
    })),
    education: list(d.education, 6, (e) => ({
      school: str(e && e.school, 160),
      degree: str(e && e.degree, 160),
      dates: str(e && e.dates, 60),
      detail: str(e && e.detail, 160),
    })),
    skills: list(d.skills, 10, (g) => ({
      group: str(g && g.group, 60) || 'Skills',
      items: strList(g && g.items, 40, 60),
    })).filter((g) => g.items.length),
    projects: list(d.projects, 10, (p) => ({
      name: str(p && p.name, 160),
      tech: str(p && p.tech, 200),
      year: str(p && p.year, 30),
      bullets: strList(p && p.bullets, 8, 400),
    })),
    certifications: strList(d.certifications, 12, 200),
  };
}

const THEME_IDS = ['classic', 'modern', 'minimal', 'bold', 'elegant', 'timeline', 'compact', 'tech'];
const isTheme = (t) => THEME_IDS.includes(t);
const isAccent = (a) => typeof a === 'string' && /^#[0-9a-f]{6}$/i.test(a);

module.exports = { normalize, THEME_IDS, isTheme, isAccent };
