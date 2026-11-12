// Resume templates shared by the browser preview and the server's PDF export.
// Every editable text node carries data-p, the path of its value in the data.
(function (root) {
  'use strict';

  const THEMES = [
    { id: 'classic', name: 'Classic', desc: 'Serif, small caps, ruled sections. The LaTeX look.' },
    { id: 'modern', name: 'Modern', desc: 'Tinted sidebar for contact and skills.' },
    { id: 'minimal', name: 'Minimal', desc: 'Quiet label column and lots of air.' },
    { id: 'bold', name: 'Bold', desc: 'Colored header band, strong headings.' },
    { id: 'elegant', name: 'Elegant', desc: 'Centered serif with fine double rules.' },
    { id: 'timeline', name: 'Timeline', desc: 'Dates down the left, roles on a line.' },
    { id: 'compact', name: 'Compact', desc: 'Dense two-column bottom. Fits more on one page.' },
    { id: 'tech', name: 'Tech', desc: 'Monospace headings for engineering roles.' },
  ];
  const ACCENTS = [['Navy', '#1f3a5f'], ['Clay', '#a94a26'], ['Forest', '#2f5d50'], ['Plum', '#5b3a6e'], ['Teal', '#1d6670'], ['Ink', '#222222']];
  const FONTS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const F = (path, val, tag, extra) => `<${tag || 'span'} data-p="${path}"${extra || ''}>${esc(val)}</${tag || 'span'}>`;
  const bullets = (b, base) => (b && b.length ? '<ul>' + b.map((x, i) => F(`${base}.${i}`, x, 'li')).join('') + '</ul>' : '');

  const expItem = (e, i) => `<div class="it"><div class="it-h"><b>${F(`experience.${i}.role`, e.role)}</b>${F(`experience.${i}.dates`, e.dates, 'span', ' class="dt"')}</div><div class="it-s">${F(`experience.${i}.org`, e.org)}</div>${bullets(e.bullets, `experience.${i}.bullets`)}</div>`;
  const eduItem = (e, i) => `<div class="it"><div class="it-h"><b>${F(`education.${i}.school`, e.school)}</b>${F(`education.${i}.dates`, e.dates, 'span', ' class="dt"')}</div><div class="it-s">${F(`education.${i}.degree`, e.degree)}${F(`education.${i}.detail`, e.detail)}</div></div>`;
  const projItem = (p, i) => `<div class="it"><div class="it-h"><b>${F(`projects.${i}.name`, p.name)} <span class="tech">| ${F(`projects.${i}.tech`, p.tech)}</span></b>${F(`projects.${i}.year`, p.year, 'span', ' class="dt"')}</div>${bullets(p.bullets, `projects.${i}.bullets`)}</div>`;

  const secExp = (d) => d.experience.map(expItem).join('');
  const secEdu = (d) => d.education.map(eduItem).join('');
  const secProj = (d) => d.projects.map(projItem).join('');
  const secSkills = (d) => d.skills.map((g, i) => `<p class="sk"><b>${F(`skills.${i}.group`, g.group)}:</b> ${F(`skills.${i}.items`, g.items.join(', '), 'span', ' data-list')}</p>`).join('');
  const secCert = (d) => (d.certifications.length ? bullets(d.certifications, 'certifications') : '');
  const contact = (d, sep) => d.contact.map((c, i) => F(`contact.${i}`, c)).join(sep || '');
  const nameBlock = (d) => F('name', d.name, 'div', ' class="nm"') + F('title', d.title, 'div', ' class="ttl"');

  // Timeline puts dates in their own column.
  const tlItem = (kind, title, sub, dates, bl, i) => `<div class="it"><div class="when">${F(`${kind}.${i}.${dates[0]}`, dates[1])}</div><div class="what"><b>${F(`${kind}.${i}.${title[0]}`, title[1])}</b><div class="it-s">${sub}</div>${bl}</div></div>`;

  function render(d, theme, accent) {
    const st = `style="--ac:${/^#[0-9a-f]{6}$/i.test(accent || '') ? accent : '#1f3a5f'}"`;
    const S = (id, title, body) => (body ? `<section class="sec" data-sec="${id}"><h4>${title}</h4><div>${body}</div></section>` : '');
    const summary = d.summary ? F('summary', d.summary, 'p') : '';

    switch (theme) {
      case 'modern':
        return `<div class="sheet t-modern" ${st}><aside><div data-sec="name">${nameBlock(d)}</div>
          <div class="ct" data-sec="contact">${contact(d)}</div>
          ${d.skills.length ? `<div data-sec="skills"><h4>Skills</h4>${d.skills.map((g, i) => `<div class="grp">${F(`skills.${i}.group`, g.group, 'b')}<div class="tags">${g.items.map((it, j) => F(`skills.${i}.items.${j}`, it)).join('')}</div></div>`).join('')}</div>` : ''}
          ${d.education.length ? `<div data-sec="education"><h4>Education</h4>${d.education.map((e, i) => `<div class="grp">${F(`education.${i}.dates`, e.dates, 'b')}${F(`education.${i}.school`, e.school, 'div', ' style="font-weight:600"')}${F(`education.${i}.degree`, e.degree, 'div')}${F(`education.${i}.detail`, e.detail, 'div', ' style="color:#555"')}</div>`).join('')}</div>` : ''}
          ${d.certifications.length ? `<div data-sec="certifications"><h4>Certifications</h4>${d.certifications.map((c, i) => F(`certifications.${i}`, c, 'div', ' class="grp"')).join('')}</div>` : ''}
          </aside><main>
          ${summary ? `<div data-sec="summary"><h4>Profile</h4>${summary}</div>` : ''}
          ${d.experience.length ? `<div data-sec="experience"><h4>Experience</h4>${secExp(d)}</div>` : ''}
          ${d.projects.length ? `<div data-sec="projects"><h4>Projects</h4>${secProj(d)}</div>` : ''}
          </main></div>`;

      case 'bold':
        return `<div class="sheet t-bold" ${st}><div class="band" data-sec="name">${nameBlock(d)}<div class="ct" data-sec="contact">${contact(d)}</div></div>
          <div class="body">${S('summary', 'Summary', summary)}${S('experience', 'Experience', secExp(d))}${S('projects', 'Projects', secProj(d))}${S('skills', 'Skills', secSkills(d))}${S('education', 'Education', secEdu(d))}${S('certifications', 'Certifications', secCert(d))}</div></div>`;

      case 'minimal':
        return `<div class="sheet t-minimal" ${st}><div data-sec="name">${nameBlock(d)}</div><div class="ct" data-sec="contact">${contact(d)}</div>
          ${S('summary', 'About', summary)}${S('experience', 'Experience', secExp(d))}${S('projects', 'Projects', secProj(d))}${S('skills', 'Skills', secSkills(d))}${S('education', 'Education', secEdu(d))}${S('certifications', 'Certificates', secCert(d))}</div>`;

      case 'elegant':
        return `<div class="sheet t-elegant" ${st}><div class="hd" data-sec="name">${nameBlock(d)}<div class="ct" data-sec="contact">${contact(d, '<i>◆</i>')}</div></div>
          ${S('summary', 'Profile', summary)}${S('experience', 'Experience', secExp(d))}${S('education', 'Education', secEdu(d))}${S('skills', 'Skills', secSkills(d))}${S('projects', 'Projects', secProj(d))}${S('certifications', 'Certifications', secCert(d))}</div>`;

      case 'timeline': {
        const exp = d.experience.map((e, i) => tlItem('experience', ['role', e.role], F(`experience.${i}.org`, e.org), ['dates', e.dates], bullets(e.bullets, `experience.${i}.bullets`), i)).join('');
        const edu = d.education.map((e, i) => tlItem('education', ['school', e.school], F(`education.${i}.degree`, e.degree) + (e.detail ? ' · ' + F(`education.${i}.detail`, e.detail) : ''), ['dates', e.dates], '', i)).join('');
        const proj = d.projects.map((p, i) => tlItem('projects', ['name', p.name], F(`projects.${i}.tech`, p.tech), ['year', p.year], bullets(p.bullets, `projects.${i}.bullets`), i)).join('');
        return `<div class="sheet t-timeline" ${st}><div class="hd" data-sec="name">${nameBlock(d)}<div class="ct" data-sec="contact">${contact(d)}</div></div>
          ${S('summary', 'Summary', summary)}${S('experience', 'Experience', exp)}${S('education', 'Education', edu)}${S('projects', 'Projects', proj)}${S('skills', 'Skills', secSkills(d))}${S('certifications', 'Certifications', secCert(d))}</div>`;
      }

      case 'compact':
        return `<div class="sheet t-compact" ${st}><div class="hd" data-sec="name"><div>${nameBlock(d)}</div><div class="ct" data-sec="contact">${contact(d)}</div></div>
          ${S('summary', 'Summary', summary)}${S('experience', 'Experience', secExp(d))}${S('projects', 'Projects', secProj(d))}
          <div class="two">${S('skills', 'Skills', secSkills(d))}<div>${S('education', 'Education', secEdu(d))}${S('certifications', 'Certifications', secCert(d))}</div></div></div>`;

      case 'tech':
        return `<div class="sheet t-tech" ${st}><div class="hd" data-sec="name">${nameBlock(d)}<div class="ct" data-sec="contact">${contact(d)}</div></div>
          ${S('summary', '// about', summary)}${S('experience', '// experience', secExp(d))}${S('projects', '// projects', secProj(d))}
          ${d.skills.length ? `<section class="sec" data-sec="skills"><h4>// skills</h4><div>${d.skills.map((g, i) => `<p class="sk"><b>${F(`skills.${i}.group`, g.group)}</b> <span class="tags">${g.items.map((it, j) => F(`skills.${i}.items.${j}`, it)).join('')}</span></p>`).join('')}</div></section>` : ''}
          ${S('education', '// education', secEdu(d))}${S('certifications', '// certifications', secCert(d))}</div>`;

      default:
        return `<div class="sheet t-classic" ${st}><div class="hd" data-sec="name">${F('name', d.name, 'div', ' class="nm"')}<div class="ct" data-sec="contact">${contact(d, ' &nbsp;|&nbsp; ')}</div></div>
          ${S('summary', 'Professional Summary', summary)}${S('education', 'Education', secEdu(d))}${S('experience', 'Experience', secExp(d))}${S('skills', 'Technical Skills', secSkills(d))}${S('projects', 'Projects', secProj(d))}${S('certifications', 'Certifications', secCert(d))}</div>`;
    }
  }

  const api = { THEMES, ACCENTS, FONTS_URL, render, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Templates = api;
})(typeof self !== 'undefined' ? self : this);
