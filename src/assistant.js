// Rule-based chat used until an LLM is connected. Handles a handful of
// direct commands and explains what else is possible.

const { THEME_IDS } = require('./schema');

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s) => s.trim().replace(/[."']+$/, '').replace(/^["']+/, '');

function respond(data, theme, message) {
  const d = JSON.parse(JSON.stringify(data));
  const m = message.trim();
  const l = m.toLowerCase();
  let r;

  const th = THEME_IDS.find((t) => l.includes(t));
  if (th && /(theme|template|switch|use|change)/.test(l)) {
    return { reply: `Switched to the ${cap(th)} theme. Your content stays the same.`, change: `Theme: ${cap(th)}`, data: d, theme: th };
  }
  if ((r = m.match(/add (?:the )?skills? (.+)/i))) {
    const items = r[1].split(/,| and /).map(clean).filter(Boolean);
    if (!d.skills.length) d.skills.push({ group: 'Skills', items: [] });
    const g = d.skills[0];
    items.forEach((i) => { if (!g.items.some((x) => x.toLowerCase() === i.toLowerCase())) g.items.push(i); });
    return { reply: `Added ${items.join(', ')} to ${g.group}.`, change: 'Skills updated', section: 'skills', data: d };
  }
  if ((r = m.match(/remove (?:the )?skills? (.+)/i))) {
    const k = clean(r[1]).toLowerCase();
    let hit = false;
    d.skills.forEach((g) => { const n = g.items.length; g.items = g.items.filter((i) => i.toLowerCase() !== k); if (g.items.length < n) hit = true; });
    d.skills = d.skills.filter((g) => g.items.length);
    return hit
      ? { reply: `Removed ${clean(r[1])} from your skills.`, change: 'Skills updated', section: 'skills', data: d }
      : { reply: `I couldn't find "${clean(r[1])}" in your skills. Check the spelling against the Skills section.`, data: d };
  }
  if (/(shorten|shorter|trim|tighten).*summary|summary.*(shorter|shorten)/.test(l)) {
    const first = (d.summary.match(/^.*?[.!?](\s|$)/) || [d.summary])[0].trim();
    if (!d.summary || first === d.summary) return { reply: 'Your summary is already one sentence. Tell me what to cut and I\'ll rewrite it.', data: d };
    d.summary = first;
    return { reply: 'Cut the summary down to its first sentence.', change: 'Summary shortened', section: 'summary', data: d };
  }
  if ((r = m.match(/(?:change|set|update) (?:my )?(?:title|headline|role) to (.+)/i))) {
    d.title = clean(r[1]);
    return { reply: `Your title now reads "${d.title}".`, change: 'Title updated', section: 'name', data: d };
  }
  if ((r = m.match(/(?:change|set|update) (?:my )?name to (.+)/i))) {
    d.name = clean(r[1]);
    return { reply: `Updated your name to ${d.name}.`, change: 'Name updated', section: 'name', data: d };
  }
  if ((r = m.match(/(?:change|set|rewrite|replace) (?:my )?summary (?:to|with) (.+)/i))) {
    d.summary = r[1].trim();
    return { reply: 'Replaced your summary with that text.', change: 'Summary updated', section: 'summary', data: d };
  }
  if ((r = l.match(/remove (?:the |my )?(projects|certifications|summary) section/))) {
    if (r[1] === 'summary') d.summary = ''; else d[r[1]] = [];
    return { reply: `Removed the ${r[1]} section.`, change: 'Section removed', data: d };
  }
  return {
    reply: 'You can edit any text yourself by clicking it on the page. Until the language model is connected I can also: add or remove a skill, change your title or name, shorten or replace the summary, remove a section, or switch theme.',
    data: d,
  };
}

module.exports = { respond };
