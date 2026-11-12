(function () {
  'use strict';
  const { THEMES, ACCENTS, render, esc } = window.Templates;
  const $ = (s) => document.querySelector(s);
  const CURRENT_KEY = 'resumely.current';

  const state = { sample: null, list: [], resume: null, llm: false, me: { signedIn: false }, googleClientId: null, ai: null };

  /* ---------- API ---------- */
  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(url, opt);
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.startsWith('/api/auth/')) signedOut();
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }
  const remember = (id) => { try { if (id) localStorage.setItem(CURRENT_KEY, id); else localStorage.removeItem(CURRENT_KEY); } catch (e) {} };
  const remembered = () => { try { return localStorage.getItem(CURRENT_KEY); } catch (e) { return null; } };

  async function openResume(id) {
    state.resume = await api('GET', `/api/resumes/${id}`);
    remember(id);
  }
  async function refreshList() {
    state.list = await api('GET', '/api/resumes');
  }

  /* ---------- sheet scaling ---------- */
  const ro = new ResizeObserver((es) => es.forEach((e) => fit(e.target)));
  function fit(w) {
    const s = w.querySelector('.sheet');
    if (!s) return;
    const k = w.clientWidth / 794;
    s.style.transform = `scale(${k})`;
    if (w.id === 'paper') {
      const h = Math.max(1123, s.offsetHeight);
      w.style.height = `${h * k}px`;
      let m = w.querySelector('.page-end');
      const over = s.offsetHeight > 1125;
      if (over && !m) { m = document.createElement('div'); m.className = 'page-end'; m.innerHTML = '<span>Page 1 ends here</span>'; w.appendChild(m); }
      if (m) { m.hidden = !over; m.style.top = `${1123 * k}px`; }
      setPageWarning(over);
    }
  }
  function mount(w, theme, data, accent) { w.innerHTML = render(data, theme, accent); fit(w); ro.observe(w); }

  /* ---------- routing ---------- */
  const VIEWS = ['home', 'upload', 'themes', 'editor', 'admin'];
  function route() {
    let v = (location.hash || '#home').slice(1);
    if (!VIEWS.includes(v)) v = 'home';
    if ((v !== 'home' && !state.me.signedIn) || (v === 'admin' && !state.me.isAdmin)) {
      v = 'home';
      history.replaceState(null, '', '#home');
    }
    if ((v === 'themes' || v === 'editor') && !state.resume) {
      v = 'upload';
      history.replaceState(null, '', '#upload');
      toast('Upload your resume first so we have your details.');
    }
    VIEWS.forEach((x) => { $(`#view-${x}`).hidden = x !== v; });
    $('#steps').hidden = v === 'home' || v === 'admin';
    document.querySelectorAll('.step').forEach((b) => {
      const g = b.dataset.go;
      b.setAttribute('aria-current', g === v ? 'step' : 'false');
      b.classList.toggle('done', VIEWS.indexOf(g) < VIEWS.indexOf(v));
      b.disabled = g !== 'upload' && !state.resume;
    });
    ({ home: renderHome, upload: renderUpload, themes: renderThemes, editor: renderEditor, admin: renderAdmin })[v]();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); location.hash = g.dataset.go; }
  });

  /* ---------- home ---------- */
  function renderHome() {
    const inside = state.me.signedIn;
    $('#home-cta').hidden = !inside;
    $('#home-gate').hidden = inside;
    if (!state.googleClientId) $('#home-gate .gate-note').textContent = 'Sign-in is not set up on this server yet (GOOGLE_CLIENT_ID is empty).';
    if (!inside) renderGoogleButton($('#gbtn-home'), 'large');
    const data = (state.resume && state.resume.data) || state.sample;
    if (!data) return;
    document.querySelectorAll('#view-home [data-render]').forEach((w) => mount(w, w.dataset.render, data, (state.resume && state.resume.accent) || ACCENTS[0][1]));
  }
  async function startSample() {
    try {
      const r = await api('POST', '/api/resumes/sample');
      state.resume = r; remember(r.id); await refreshList();
      location.hash = 'themes';
    } catch (e) { toast(e.message); }
  }
  $('#home-sample').addEventListener('click', startSample);
  $('#many-cta').addEventListener('click', () => {
    if (state.me.signedIn) { location.hash = state.resume ? 'editor' : 'upload'; return; }
    $('#view-home').scrollTo({ top: 0, behavior: 'smooth' });
    toast('Sign in with Google to get started.');
  });
  $('#upload-sample').addEventListener('click', startSample);

  /* ---------- upload ---------- */
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  function renderUpload() {
    $('#drop').hidden = false;
    $('#progress').hidden = true;
    renderRecent();
    // The list may be out of date (theme or name changed in the editor).
    refreshList().then(renderRecent).catch(() => {});
  }
  function renderRecent() {
    const box = $('#recent');
    box.hidden = !state.list.length;
    $('#recent-list').innerHTML = state.list.map((r) => `<li>
      <div class="rt"><b>${esc(r.job ? `For: ${r.job}` : r.name || r.title)}</b><span>${esc(r.job ? r.name || r.title : r.title)} · ${esc(cap(r.theme))} · edited ${fmtDate(r.updatedAt)}</span></div>
      <button class="btn" data-open="${r.id}">Open</button>
      <button class="del" data-del="${r.id}" aria-label="Delete ${esc(r.title)}">Delete</button></li>`).join('');
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  $('#recent-list').addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]');
    const d = e.target.closest('[data-del]');
    try {
      if (o) { await openResume(o.dataset.open); location.hash = 'editor'; }
      if (d) {
        if (d.dataset.armed !== '1') { d.dataset.armed = '1'; d.textContent = 'Click again to delete'; setTimeout(() => { d.dataset.armed = ''; d.textContent = 'Delete'; }, 3000); return; }
        await api('DELETE', `/api/resumes/${d.dataset.del}`);
        if (state.resume && state.resume.id === d.dataset.del) { state.resume = null; remember(null); }
        await refreshList(); renderRecent(); toast('Resume deleted');
      }
    } catch (err) { toast(err.message); }
  });

  function setChecks(n, failAt) {
    document.querySelectorAll('#checks li').forEach((li, i) => {
      li.className = failAt === i ? 'fail' : i < n ? 'on' : i === n ? 'run' : '';
    });
  }
  async function handleFile(file) {
    if (!file) return;
    if (!/\.(pdf|docx|txt)$/i.test(file.name)) { toast("That file type isn't supported. Upload a PDF, DOCX or TXT file."); return; }
    if (file.size > 10 * 1048576) { toast('That file is over 10 MB. Upload a smaller copy.'); return; }
    $('#drop').hidden = true; $('#progress').hidden = false;
    $('#fname').textContent = file.name; $('#fsize').textContent = fmtSize(file.size);
    ['#found', '#extract-note', '#upload-err', '#upload-next'].forEach((s) => { $(s).hidden = true; });
    setChecks(0);
    const fd = new FormData(); fd.append('resume', file);
    let step = 0;
    const t = setInterval(() => { if (step < 2) setChecks(++step); }, 700);
    try {
      const r = await api('POST', '/api/resumes', fd);
      clearInterval(t); setChecks(3);
      state.resume = r; remember(r.id); await refreshList();
      showFound(r);
    } catch (e) {
      clearInterval(t); setChecks(step, step);
      $('#upload-err').textContent = e.message; $('#upload-err').hidden = false;
      $('#upload-next').hidden = false;
    }
  }
  function showFound(r) {
    const d = r.data;
    const n = d.skills.reduce((a, g) => a + g.items.length, 0);
    $('#found').innerHTML = [[d.experience.length, 'roles'], [n, 'skills'], [d.projects.length, 'projects'], [d.education.length, 'schools']]
      .map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
    $('#found').hidden = false;
    $('#extract-note').textContent = r.extractedBy === 'llm'
      ? 'Read with the AI model. Check names and dates in the editor.'
      : `${r.aiLimited ? 'You are out of AI credits, so this was read' : 'Read'} with built-in rules. Some details may land in the wrong place; you can fix any line in the editor.`;
    if (r.ai) setAi(r.ai);
    $('#extract-note').hidden = false;
    $('#upload-next').hidden = false;
  }
  $('#file').addEventListener('change', (e) => handleFile(e.target.files[0]));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
  $('#reupload').addEventListener('click', () => { $('#file').value = ''; renderUpload(); });

  /* ---------- themes ---------- */
  async function patch(body) {
    const r = state.resume;
    Object.assign(r, body);
    try {
      await api('PATCH', `/api/resumes/${r.id}`, body); setMeta('saved');
      if ((body.data || body.theme) && !$('#view-editor').hidden) { drawChips(); if (body.data) scheduleAts(); }
    } catch (e) { setMeta('error'); toast(e.message); }
  }
  function renderSwatches(onPick) {
    const box = $('#swatches');
    box.querySelectorAll('.sw').forEach((n) => n.remove());
    ACCENTS.forEach(([n, c]) => {
      const b = document.createElement('button');
      b.className = 'sw'; b.style.background = c; b.title = n; b.setAttribute('aria-label', `${n} accent`);
      b.setAttribute('aria-pressed', String(state.resume.accent === c));
      b.onclick = () => { patch({ accent: c }); onPick(); };
      box.appendChild(b);
    });
  }
  function renderThemes() {
    renderSwatches(renderThemes);
    const g = $('#theme-grid');
    g.innerHTML = '';
    THEMES.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'theme-card';
      b.setAttribute('aria-pressed', String(state.resume.theme === t.id));
      b.innerHTML = `<div class="sheet-wrap"></div><div><h3>${t.name}</h3><p>${t.desc}</p></div>`;
      b.onclick = () => { patch({ theme: t.id }); g.querySelectorAll('.theme-card').forEach((c) => c.setAttribute('aria-pressed', String(c === b))); };
      b.ondblclick = () => { location.hash = 'editor'; };
      g.appendChild(b);
      mount(b.querySelector('.sheet-wrap'), t.id, state.resume.data, state.resume.accent);
    });
  }

  /* ---------- editor ---------- */
  let pageOver = false;
  function setPageWarning(over) {
    const changed = over !== pageOver;
    pageOver = over; setMeta();
    if (changed && state.resume && !$('#view-editor').hidden) { drawChips(); scheduleAts(); }
  }
  let metaState = '';
  function setMeta(s) {
    if (s !== undefined) metaState = s;
    const el = $('#meta');
    if (!el || !state.resume) return;
    const parts = [];
    if (metaState === 'saving') parts.push('Saving…');
    if (metaState === 'saved') parts.push('Saved');
    if (metaState === 'error') parts.push('Not saved');
    if (pageOver) parts.push('Runs past one page');
    parts.push(cap(state.resume.theme), 'A4');
    el.textContent = parts.join(' · ');
    el.classList.toggle('warn', pageOver || metaState === 'error');
  }
  function renderSeg() {
    const s = $('#theme-seg');
    s.innerHTML = '';
    THEMES.forEach((t) => {
      const b = document.createElement('button');
      b.textContent = t.name;
      b.setAttribute('aria-pressed', String(state.resume.theme === t.id));
      b.onclick = () => { patch({ theme: t.id }); renderSeg(); paint(); };
      s.appendChild(b);
    });
  }
  function paint(flashSec) {
    const paper = $('#paper');
    const r = state.resume;
    mount(paper, r.theme, r.data, r.accent);
    paper.querySelectorAll('[data-p]').forEach((el) => {
      el.contentEditable = 'plaintext-only';
      if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
      el.spellcheck = true;
    });
    $('#download').href = `/api/resumes/${r.id}/pdf`;
    setMeta();
    highlightKeywords();
    if (flashSec) {
      const el = paper.querySelector(`[data-sec="${flashSec}"]`);
      if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  }
  function renderEditor() {
    const st = $('#llm-status');
    st.textContent = state.llm ? 'AI connected' : 'Basic mode';
    st.classList.toggle('live', state.llm);
    st.title = state.llm ? '' : 'The language model is not connected yet, so the assistant handles a few direct commands';
    renderSeg(); paint(); drawChat(); drawChips(true); drawJd(); drawAiLeft();
    if (state.atsFor !== state.resume.id) { state.ats = null; state.atsFor = state.resume.id; drawAts(); }
    refreshAts();
  }

  /* AI credits */
  const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
  function setAi(ai) { state.ai = ai; drawAiLeft(); renderAccount(); }
  function drawAiLeft() {
    const el = $('#ai-left');
    const ai = state.ai;
    if (!state.llm || !ai) { el.textContent = ''; return; }
    el.textContent = ai.credits > 0 ? `${fmtN(ai.credits)} AI credits left` : 'Out of AI credits';
    el.classList.toggle('out', ai.credits <= 0);
    el.title = `1 credit = ${fmtN(ai.tokensPerCredit)} AI tokens. A typical edit uses 3 to 8 credits.`;
  }

  /* target job: the job description the resume is tailored to */
  const jdInput = $('#jd-input');
  function jdOpen(open) {
    $('#jd-body').hidden = !open;
    $('#jd-toggle').setAttribute('aria-expanded', String(open));
  }
  function drawJd() {
    const jd = state.resume.jd || '';
    jdInput.value = jd;
    $('#jd').classList.toggle('has', Boolean(jd));
    $('#jd-sum').textContent = jd ? jd.split(/\n/).map((s) => s.trim()).find(Boolean) : "Paste the job you're applying for";
    // Ask for it up front on a fresh resume.
    jdOpen(!jd && !state.resume.chat.length && innerHeight >= 700 && innerWidth > 960);
    jdCount();
  }
  function jdCount() {
    const n = jdInput.value.trim().length;
    $('#jd-count').textContent = n ? `${fmtN(n)} / 8,000 characters` : '';
    $('#jd-tailor').disabled = !n;
    $('#jd-save').disabled = jdInput.value.trim() === (state.resume.jd || '');
  }
  async function saveJd() {
    const jd = jdInput.value.trim();
    if (jd === (state.resume.jd || '')) return true;
    try {
      await api('PATCH', `/api/resumes/${state.resume.id}`, { jd });
      state.resume.jd = jd;
      refreshAts();
      return true;
    } catch (e) { toast(e.message); return false; }
  }
  $('#jd-toggle').addEventListener('click', () => jdOpen($('#jd-body').hidden));
  jdInput.addEventListener('input', jdCount);
  $('#jd-save').addEventListener('click', async () => {
    if (await saveJd()) { toast(state.resume.jd ? 'Job description saved' : 'Job description removed'); drawJd(); drawChips(); jdOpen(false); }
  });
  $('#jd-tailor').addEventListener('click', async () => {
    if (!(await saveJd())) return;
    drawJd(); drawChips(); jdOpen(false);
    send('Tailor my resume to this job description.');
  });

  /* direct editing on the page: no LLM involved */
  const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setP(o, p, v) { const k = p.split('.'); const last = k.pop(); k.reduce((a, x) => a[x], o)[last] = v; }
  function listItem(p) {
    const k = p.split('.');
    const i = Number(k[k.length - 1]);
    if (!Number.isInteger(i)) return null;
    const arrPath = k.slice(0, -1).join('.');
    const arr = getP(state.resume.data, arrPath);
    return Array.isArray(arr) && /(bullets|certifications|contact|items)$/.test(arrPath) ? { arrPath, arr, i } : null;
  }
  function focusPath(p) {
    const el = $('#paper').querySelector(`[data-p="${p}"]`);
    if (!el) return;
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  let saveTimer;
  function queueSave() {
    setMeta('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => patch({ data: state.resume.data }), 600);
  }
  const paperEl = $('#paper');
  paperEl.addEventListener('input', (e) => {
    const el = e.target.closest('[data-p]');
    if (!el) return;
    const v = el.innerText.replace(/\s*\n\s*/g, ' ');
    setP(state.resume.data, el.dataset.p, el.hasAttribute('data-list') ? v.split(/\s*,\s*/).filter(Boolean) : v);
    fit(paperEl);
    queueSave();
  });
  paperEl.addEventListener('paste', (e) => {
    if (!e.target.closest('[data-p]')) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text').replace(/\s*\n\s*/g, ' '));
  });
  paperEl.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-p]');
    if (!el) return;
    const li = listItem(el.dataset.p);
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!li) { el.blur(); return; }
      li.arr.splice(li.i + 1, 0, '');
      paint(); focusPath(`${li.arrPath}.${li.i + 1}`); queueSave();
      return;
    }
    if (e.key === 'Backspace' && li && !el.innerText.trim() && li.arr.length > 1) {
      e.preventDefault();
      li.arr.splice(li.i, 1);
      paint(); focusPath(`${li.arrPath}.${Math.max(0, li.i - 1)}`); queueSave();
      return;
    }
    if (e.key === 'Escape') el.blur();
  });
  paperEl.addEventListener('focusout', (e) => {
    const el = e.target.closest('[data-p]');
    if (!el) return;
    const li = listItem(el.dataset.p);
    if (li && !String(li.arr[li.i] || '').trim() && li.arr.length > 1) {
      li.arr.splice(li.i, 1); queueSave();
      setTimeout(() => { if (!paperEl.contains(document.activeElement)) paint(); }, 0);
    }
  });

  $('#copy-job').addEventListener('click', async () => {
    const btn = $('#copy-job');
    btn.disabled = true;
    try {
      clearTimeout(saveTimer);
      if (metaState === 'saving') await patch({ data: state.resume.data });
      const copy = await api('POST', `/api/resumes/${state.resume.id}/copy`);
      state.resume = copy; remember(copy.id); await refreshList();
      renderEditor(); jdOpen(true); jdInput.focus();
      toast('Copy made. Paste the next job description.');
    } catch (e) { toast(e.message); } finally { btn.disabled = false; }
  });

  $('#download').addEventListener('click', async (e) => {
    if (metaState === 'saving') { e.preventDefault(); clearTimeout(saveTimer); await patch({ data: state.resume.data }); location.href = $('#download').href; }
    toast('Preparing your PDF…');
  });

  /* chat */
  function drawChat() {
    const msgs = state.resume.chat.length ? state.resume.chat : [{ role: 'assistant', text: `I've loaded ${state.resume.extractedBy === 'sample' ? 'the sample resume' : 'your resume'}. Applying for a particular job? Paste its description here or in the Target job box above, and I'll tailor your resume to it. You can also click any line on the page to edit it yourself, or tell me what to change.` }];
    $('#msgs').innerHTML = msgs.map((m) => (m.role === 'user'
      ? `<div class="msg user">${esc(m.text)}</div>`
      : `<div class="msg bot"><div class="who"><i></i>Assistant</div>${esc(m.text)}${m.change ? `<br><span class="change">${esc(m.change)}</span>` : ''}</div>`)).join('');
    const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  }
  // Suggestions worked out from this resume (no AI call). With the AI off,
  // only requests the built-in rules can carry out are offered.
  const WEAK_START = /^(worked|responsible|helped|assisted|involved|participated|handled|tasked|did|was|were|in charge)\b/i;
  const short = (s, n = 28) => { s = String(s || '').trim(); return s.length > n ? `${s.slice(0, n - 1).trim()}…` : s; };
  function suggestions() {
    const r = state.resume;
    const d = r.data;
    const ai = state.llm && !(state.ai && state.ai.credits <= 0);
    const out = [];
    const add = (text, run) => { if (text && !out.some((x) => x.text === text)) out.push({ text, run }); };
    const jobs = d.experience || [];
    const bullets = jobs.flatMap((j) => (j.bullets || []).map((b) => ({ b, j })));
    const skills = (d.skills || []).flatMap((g) => g.items || []);
    const sentences = (d.summary || '').split(/(?<=[.!?])\s+/).filter(Boolean).length;

    if (ai) {
      if (r.jd) add('Tailor to the job');
      else add('Paste a job description', () => { jdOpen(true); jdInput.focus(); });
      if (pageOver) add('Fit my resume on one page');
      const weak = bullets.find((x) => WEAK_START.test(x.b.trim()));
      if (weak) add(`Rewrite "${short(weak.b, 26)}" with a stronger verb`);
      const long = jobs.find((j) => (j.bullets || []).some((b) => b.length > 190));
      if (long) add(`Tighten my bullets at ${short(long.org || long.role)}`);
      const vague = jobs.find((j) => (j.bullets || []).length && !(j.bullets || []).some((b) => /\d/.test(b)));
      if (vague) add(`Make my ${short(vague.org || vague.role)} bullets more specific`);
      if (!d.summary) add('Write a summary from my experience');
      else if (d.summary.length > 420 || sentences > 3) add('Shorten my summary');
      else if (d.title) add(`Sharpen my summary for ${short(d.title, 30)} roles`);
      if (!d.title && jobs[0] && jobs[0].role) add(`Add a headline based on my ${short(jobs[0].role)} role`);
      if (skills.length > 24) add('Trim my skills to the strongest ones');
      else if ((d.skills || []).length === 1 && skills.length > 8) add('Group my skills by category');
      const seen = new Set();
      if (skills.some((s) => { const k = s.toLowerCase(); if (seen.has(k)) return true; seen.add(k); return false; })) add('Remove duplicate skills');
      if (jobs[0] && (jobs[0].bullets || []).length) add(`Improve my bullets at ${short(jobs[0].org || jobs[0].role)}`);
    } else {
      if (pageOver && r.theme !== 'compact') add('Switch to the Compact theme');
      if (pageOver && (d.projects || []).length) add('Remove the projects section');
      if (d.summary && (d.summary.length > 300 || sentences > 2)) add('Shorten my summary');
      if (!d.title && jobs[0] && jobs[0].role) add(`Change my title to ${jobs[0].role}`);
      const techy = /engineer|developer|devops|data|software|programmer|sre|ml\b/i.test(`${d.title} ${jobs.map((j) => j.role).join(' ')}`);
      const pick = techy && r.theme !== 'tech' ? 'Tech' : r.theme !== 'modern' ? 'Modern' : 'Elegant';
      add(`Switch to the ${pick} theme`);
    }
    return out.slice(0, 5);
  }
  let chipKey = '';
  function drawChips(force) {
    const list = suggestions();
    const key = list.map((x) => x.text).join('|');
    if (!force && key === chipKey) return;
    chipKey = key;
    const c = $('#chips'); c.innerHTML = '';
    list.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = s.text;
      b.onclick = () => (s.run ? s.run() : send(s.text));
      c.appendChild(b);
    });
    chipsEdge();
  }
  // Fade the right edge only while more chips are hidden off to the side (phones).
  function chipsEdge() { const c = $('#chips'); c.classList.toggle('at-end', c.scrollLeft + c.clientWidth >= c.scrollWidth - 4); }
  $('#chips').addEventListener('scroll', chipsEdge, { passive: true });
  window.addEventListener('resize', chipsEdge);
  let sending = false;
  async function send(text) {
    text = (text || '').trim();
    if (!text || sending) return;
    sending = true;
    clearTimeout(saveTimer);
    if (metaState === 'saving') await patch({ data: state.resume.data });
    const r = state.resume;
    r.chat.push({ role: 'user', text }); drawChat();
    const box = $('#msgs');
    const ty = document.createElement('div');
    ty.className = 'msg bot typing';
    ty.innerHTML = '<div class="who"><i></i>Assistant</div><span></span><span></span><span></span>';
    box.appendChild(ty); box.scrollTop = box.scrollHeight;
    input.value = ''; $('#send').disabled = true; autoGrow();
    try {
      const out = await api('POST', `/api/resumes/${r.id}/chat`, { message: text });
      r.chat.pop(); r.chat.push(...out.messages);
      r.data = out.data;
      if (out.theme !== r.theme) { r.theme = out.theme; renderSeg(); }
      if (out.ai) setAi(out.ai);
      if (typeof out.jd === 'string' && out.jd !== (r.jd || '')) { r.jd = out.jd; drawJd(); drawChips(); }
      drawChips();
      drawChat(); paint(out.section);
      refreshAts();
    } catch (e) {
      ty.remove(); toast(e.message);
    } finally { sending = false; }
  }
  const input = $('#chat-input');
  function autoGrow() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; }
  input.addEventListener('input', () => { $('#send').disabled = !input.value.trim(); autoGrow(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });

  /* account: optional Google sign-in */
  function renderAccount() {
    const box = $('#account');
    const me = state.me;
    if (me.signedIn) {
      const face = me.picture
        ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">`
        : `<b class="initial">${esc((me.name || me.email || '?')[0].toUpperCase())}</b>`;
      const ai = state.llm && state.ai;
      box.innerHTML = `${me.isAdmin ? '<a class="admin-link" href="#admin">Admin</a>' : ''}
        ${ai ? `<span class="credits${ai.credits > 0 ? '' : ' empty'}" title="AI credits left. 1 credit = ${fmtN(ai.tokensPerCredit)} AI tokens.">${fmtN(ai.credits)} credits</span>` : ''}
        <div class="who" title="${esc(me.email)}">${face}<span>${esc(me.name || me.email)}</span></div>
        <button class="btn out" id="sign-out">Sign out</button>`;
      $('#sign-out').addEventListener('click', signOut);
      return;
    }
    box.innerHTML = '';
  }
  function renderGoogleButton(el, size) {
    if (!el || !state.googleClientId) return;
    loadGoogle().then((g) => {
      if (!gInit) { g.accounts.id.initialize({ client_id: state.googleClientId, callback: onGoogleCredential, ux_mode: 'popup', context: 'signin' }); gInit = true; }
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      el.replaceChildren();
      g.accounts.id.renderButton(el, { type: 'standard', theme: dark ? 'filled_black' : 'outline', size, text: 'signin_with', shape: 'pill', width: size === 'large' ? 280 : undefined });
    }).catch(() => toast('Could not load Google sign-in. Check your connection and reload.'));
  }
  let gInit = false;
  let gLoad;
  function loadGoogle() {
    if (window.google && window.google.accounts) return Promise.resolve(window.google);
    gLoad = gLoad || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => resolve(window.google); s.onerror = reject;
      document.head.appendChild(s);
    });
    return gLoad;
  }
  async function onGoogleCredential(resp) {
    try {
      const { user, ai } = await api('POST', '/api/auth/google', { credential: resp.credential });
      state.me = user; state.ai = ai || null; renderAccount();
      await refreshList();
      const id = remembered();
      const pick = state.list.find((r) => r.id === id) || state.list[0];
      if (pick) await openResume(pick.id).catch(() => remember(null));
      toast(`Signed in as ${user.name || user.email}`);
      if (location.hash === '#upload') route(); else location.hash = 'upload';
    } catch (e) { toast(e.message); }
  }
  async function signOut() {
    try {
      await api('POST', '/api/auth/logout');
      if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
      remember(null); signedOut();
      toast('Signed out');
    } catch (e) { toast(e.message); }
  }

  // Back to the signed-out home page (after sign-out, or when the session has ended).
  function signedOut() {
    if (!state.me.signedIn) return;
    state.me = { signedIn: false }; state.resume = null; state.list = []; state.ai = null; adminData = null;
    state.ats = null; state.atsFor = null; atsPane.innerHTML = ''; if (window.CSS && CSS.highlights) CSS.highlights.delete('ats-hit');
    $('#admin-rows').innerHTML = '';
    // Don't leave the last person's resume in the page (shared computers).
    $('#recent-list').innerHTML = ''; $('#recent').hidden = true;
    $('#paper').innerHTML = ''; $('#msgs').innerHTML = ''; $('#theme-grid').innerHTML = '';
    renderAccount();
    if (location.hash && location.hash !== '#home') location.hash = 'home'; else route();
  }

  /* admin: users, usage and credits */
  let adminData = null;
  const when = (d) => {
    if (!d) return '—';
    const s = (Date.now() - new Date(d)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return new Date(d).toLocaleDateString();
  };
  async function renderAdmin() {
    try {
      adminData = await api('GET', '/api/admin/users');
      drawAdmin();
    } catch (e) { toast(e.message); }
  }
  function drawAdmin() {
    if (!adminData) return;
    const t = adminData.totals;
    $('#admin-sub').textContent = `1 credit = 1,000 AI tokens. New accounts start with ${fmtN(adminData.startingCredits)} credits.`;
    $('#admin-totals').innerHTML = [[t.users, 'Users'], [t.credits, 'Credits left'], [t.creditsUsed, 'Credits used'], [t.aiRequests, 'AI requests'], [t.uploads, 'Uploads'], [t.pdfDownloads, 'PDF downloads'], [t.resumes, 'Resumes']]
      .map(([v, l]) => `<div><b>${fmtN(v)}</b><span>${l}</span></div>`).join('');
    const q = $('#admin-search').value.trim().toLowerCase();
    const rows = adminData.users.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q));
    $('#admin-rows').innerHTML = rows.length ? rows.map((u) => `<tr data-id="${esc(u.id)}">
      <td><div class="au">${u.picture ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : `<b class="initial">${esc((u.name || u.email || '?')[0].toUpperCase())}</b>`}
        <div><b>${esc(u.name || '—')}${u.isAdmin ? ' <span class="tag">admin</span>' : ''}</b><span>${esc(u.email)}</span></div></div></td>
      <td class="num"><b class="${u.credits > 0 ? '' : 'zero'}">${fmtN(u.credits)}</b></td>
      <td class="num">${fmtN(u.creditsUsed)}</td><td class="num">${fmtN(u.aiRequests)}</td>
      <td class="num">${fmtN(u.uploads)}</td><td class="num">${fmtN(u.pdfDownloads)}</td><td class="num">${fmtN(u.resumes)}</td>
      <td title="Joined ${esc(u.createdAt ? new Date(u.createdAt).toLocaleString() : '—')}">${when(u.lastSeenAt)}</td>
      <td><form class="grant"><input type="number" step="1" min="-1000000" max="1000000" value="100" aria-label="Credits for ${esc(u.email)}">
        <button class="btn" data-mode="add" type="submit">Add</button><button class="link" data-mode="set" type="submit">Set to</button></form></td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">No users match.</td></tr>';
  }
  $('#admin-search').addEventListener('input', drawAdmin);
  $('#admin-refresh').addEventListener('click', renderAdmin);
  $('#admin-rows').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = form.closest('tr').dataset.id;
    const mode = (e.submitter && e.submitter.dataset.mode) || 'add';
    const n = Number(form.querySelector('input').value);
    if (!Number.isInteger(n)) { toast('Enter a whole number of credits.'); return; }
    const u = adminData.users.find((x) => x.id === id);
    if (mode === 'set' && !confirm(`Set ${u.email} to ${fmtN(n)} credits? They have ${fmtN(u.credits)} now.`)) return;
    try {
      const row = await api('POST', `/api/admin/users/${id}/credits`, mode === 'set' ? { set: n } : { add: n });
      const before = u.credits;
      Object.assign(u, row);
      adminData.totals.credits += row.credits - before;
      if (id === state.me.id || u.email === state.me.email) setAi({ ...state.ai, credits: row.credits });
      drawAdmin();
      toast(`${u.email}: ${fmtN(before)} → ${fmtN(row.credits)} credits`);
    } catch (err) { toast(err.message); }
  });

  /* ---------- ATS match score ---------- */
  // The score comes from the server (plain code, no credits once the job's keywords are read).
  const atsPane = $('#pane-ats');
  let atsBusy = false;
  let atsAgain = false;
  let atsTimer;
  let atsBefore = null; // score before a tailor or fix, to show the change
  function setTab(t) {
    const ats = t === 'ats';
    $('#tab-chat').setAttribute('aria-selected', String(!ats)); $('#tab-chat').tabIndex = ats ? -1 : 0;
    $('#tab-ats').setAttribute('aria-selected', String(ats)); $('#tab-ats').tabIndex = ats ? 0 : -1;
    $('#pane-chat').hidden = ats; atsPane.hidden = !ats;
    if (ats) { drawAts(); refreshAts(); }
  }
  $('#tab-chat').addEventListener('click', () => setTab('chat'));
  $('#tab-ats').addEventListener('click', () => setTab('ats'));
  $('.rail-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = $('#tab-ats').getAttribute('aria-selected') === 'true' ? 'chat' : 'ats';
    setTab(next); $(`#tab-${next}`).focus();
  });
  $('#ats-pill').addEventListener('click', () => { setTab('ats'); $('.chat').scrollIntoView({ block: 'start', behavior: 'smooth' }); });

  function scheduleAts() { clearTimeout(atsTimer); atsTimer = setTimeout(refreshAts, 900); }
  async function refreshAts(opts = {}) {
    const r = state.resume;
    if (!r || $('#view-editor').hidden) return;
    if (atsBusy) { atsAgain = true; return; }
    atsBusy = true;
    if (!state.ats) drawAts();
    try {
      const out = await api('POST', `/api/resumes/${r.id}/ats`, { onePage: !pageOver, upgrade: Boolean(opts.upgrade) });
      if (state.resume !== r) return;
      state.ats = out; state.atsFor = r.id;
      if (out.ai) setAi(out.ai);
      drawAts(); highlightKeywords();
    } catch (e) {
      if (!atsPane.hidden) toast(e.message);
    } finally {
      atsBusy = false;
      if (atsAgain) { atsAgain = false; refreshAts(); }
    }
  }

  const RING = 2 * Math.PI * 42;
  const verdictOf = (n) => (n >= 80 ? 'Strong match' : n >= 60 ? 'Fair match' : 'Weak match');
  const tick = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
  function ring(n, label) {
    return `<div class="ats-ring" role="img" aria-label="${esc(label)}: ${n} out of 100">
      <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="42"/><circle class="val" cx="50" cy="50" r="42" style="stroke-dasharray:${RING.toFixed(2)};stroke-dashoffset:${(RING * (1 - n / 100)).toFixed(2)}"/></svg>
      <div class="n"><b>${n}</b><small>of 100</small></div></div>`;
  }
  function drawAts() {
    const a = state.ats;
    const r = state.resume;
    // Badges in the tab and the toolbar.
    const n = a ? a.score : null;
    $('#tab-score').hidden = n == null; $('#tab-score').textContent = n == null ? '' : n;
    $('#ats-pill').hidden = !a || a.mode !== 'match'; $('#ats-pill-n').textContent = n == null ? '–' : n;
    $('#hl-wrap').hidden = !a || a.mode !== 'match' || !window.CSS || !CSS.highlights;
    if (atsPane.hidden) return;
    if (!a) { atsPane.innerHTML = '<div class="ats-loading"><span></span><span></span><span></span> Checking your resume…</div>'; return; }

    if (a.mode === 'format') {
      atsPane.innerHTML = `<div class="ats-body">
        <div class="ats-score">${ring(a.score, 'Format check')}<div class="ats-verdict"><h3>Format check</h3><p>How easily an applicant tracking system can read this resume. Add the job you're applying for to see how well it matches.</p></div></div>
        <ul class="ats-checks">${a.checks.map((c) => `<li class="${c.ok ? '' : 'no'}">${esc(c.text)}</li>`).join('')}</ul>
        <button class="btn primary" id="ats-add-jd" type="button">Paste a job description</button>
      </div>`;
      $('#ats-add-jd').addEventListener('click', () => { jdOpen(true); jdInput.focus(); });
      return;
    }

    const delta = atsBefore != null && a.score !== atsBefore ? a.score - atsBefore : null;
    const missReq = a.misses.filter((m) => m.required);
    const missOpt = a.misses.filter((m) => !m.required);
    atsPane.innerHTML = `<div class="ats-body">
      <div class="ats-score">${ring(a.score, 'ATS match')}
        <div class="ats-verdict"><h3>${verdictOf(a.score)}</h3>
          <p>${a.found} of ${a.totalKeywords} job keywords found${a.requiredMissing ? `, ${a.requiredMissing} required ${a.requiredMissing === 1 ? 'one' : 'ones'} missing` : ', every required one included'}.</p>
          ${delta != null ? `<span class="ats-delta${delta < 0 ? ' down' : ''}">${delta > 0 ? '+' : ''}${delta} after the last fix</span>` : ''}
        </div></div>
      <div class="ats-parts">${a.parts.map((p) => `<div class="ats-part"><span>${esc(p.label)}</span><b>${p.score} / ${p.max}</b><div class="bar"><i class="${p.score === p.max ? 'full' : ''}" style="width:${(p.score / p.max) * 100}%"></i></div></div>`).join('')}</div>
      <div class="ats-kw"><h4><span>In your resume</span><span>${a.hits.length}</span></h4>
        <div class="ats-chips">${a.hits.map((h) => `<span class="kchip hit${a.stuffed.some((x) => x.term === h.term) ? ' stuffed' : ''}" title="Mentioned ${h.count} time${h.count === 1 ? '' : 's'}">${tick}${esc(h.term)}</span>`).join('') || '<span class="ats-none">None yet</span>'}</div></div>
      ${a.misses.length ? `<div class="ats-kw"><h4><span>Missing from your resume</span><span>${a.misses.length}</span></h4>
        <div class="ats-chips">${missReq.map((m) => `<span class="kchip miss">${esc(m.term)} · required</span>`).join('')}${missOpt.map((m) => `<span class="kchip miss opt">${esc(m.term)}</span>`).join('')}</div>
        <p class="ats-note">Add these only if you have really used them. The assistant won't add them for you.</p></div>` : ''}
      ${a.fixes.length ? `<div class="ats-fixes">${a.fixes.map((f, i) => `<div class="ats-fix"><span class="dot" aria-hidden="true"></span><div><b>${esc(f.title)}</b><p>${esc(f.detail)}</p></div>${f.message && state.llm ? `<button class="btn" type="button" data-fix="${i}">Fix</button>` : ''}</div>`).join('')}</div>` : ''}
      ${state.llm ? `<div class="ats-cta"><button class="btn primary" id="ats-tailor" type="button">Tailor to this job</button><span>Uses about 3 to 8 credits</span></div>` : '<p class="ats-note">Fixes need the AI, which is not available right now.</p>'}
      <p class="ats-foot">${a.keywordsBy === 'ai' ? 'Job keywords read by the AI.' : `Job keywords found with built-in rules.${state.llm && !(state.ai && state.ai.credits <= 0) ? ' <button class="link" id="ats-upgrade" type="button">Read them with the AI (1 or 2 credits)</button>' : ''}`} The score is a guide to how keyword-matching systems read your resume, not a promise from any employer.</p>
    </div>`;
    atsPane.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => atsSend(a.fixes[Number(b.dataset.fix)].message, b)));
    const t = $('#ats-tailor'); if (t) t.addEventListener('click', () => atsSend('Tailor my resume to this job description.', t));
    const u = $('#ats-upgrade'); if (u) u.addEventListener('click', () => { u.disabled = true; refreshAts({ upgrade: true }); });
  }
  async function atsSend(message, btn) {
    if (sending) return;
    atsBefore = state.ats ? state.ats.score : null;
    btn.disabled = true; btn.textContent = 'Working…';
    atsPane.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    await send(message);
    // send() re-scores when it finishes; the delta shows on the next draw.
    if (!sending) drawAts();
  }

  // Mark the job's keywords on the page without touching the editable text (CSS Custom Highlight API).
  function kwRe(term) {
    const raw = String(term).trim();
    if (!raw) return null;
    const exact = raw.replace(/[^A-Za-z0-9]/g, '').length <= 2;
    let t = exact ? raw : raw.toLowerCase();
    const plural = /[a-z]{3,}s$/.test(t) && !/(ss|us|is)$/.test(t);
    if (plural) t = t.slice(0, -1);
    const body = t.split(/[\s.\-/]+/).filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s.\\-/]*');
    return new RegExp(`(?<![A-Za-z0-9+#])${body}${plural ? 's?' : ''}(?![A-Za-z0-9+#])`, exact ? 'g' : 'gi');
  }
  function highlightKeywords() {
    if (!window.CSS || !CSS.highlights) return;
    CSS.highlights.delete('ats-hit');
    const a = state.ats;
    if (!$('#hl').checked || !a || a.mode !== 'match' || !a.hits.length) return;
    const byTerm = new Map((a.keywords || []).map((k) => [k.term, k]));
    const res = a.hits.flatMap((h) => [h.term, ...((byTerm.get(h.term) || {}).aliases || [])]).map(kwRe).filter(Boolean);
    const ranges = [];
    const walk = document.createTreeWalker($('#paper'), NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.nodeValue;
      for (const re of res) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const range = new Range(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length); ranges.push(range);
          if (!m[0].length) re.lastIndex++;
        }
      }
    }
    if (ranges.length) CSS.highlights.set('ats-hit', new Highlight(...ranges));
  }
  $('#hl').addEventListener('change', () => { try { localStorage.setItem('resumely.hl', $('#hl').checked ? '1' : '0'); } catch (e) {} highlightKeywords(); });
  try { $('#hl').checked = localStorage.getItem('resumely.hl') !== '0'; } catch (e) { $('#hl').checked = true; }

  /* toast */
  let tt;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => { el.hidden = true; }, 3200); }

  $('#foot-year').textContent = new Date().getFullYear();

  /* boot */
  (async function boot() {
    try {
      const me = await api('GET', '/api/me');
      state.me = me.user; state.googleClientId = me.googleClientId; state.ai = me.ai; renderAccount();
      const [sample, health] = await Promise.all([api('GET', '/api/sample'), api('GET', '/api/health')]);
      state.sample = sample; state.llm = Boolean(health.llm); renderAccount();
      if (state.me.signedIn) {
        await refreshList();
        const id = remembered();
        const pick = state.list.find((r) => r.id === id) || state.list[0];
        if (pick) await openResume(pick.id).catch(() => remember(null));
      }
    } catch (e) { toast(`Could not reach the server: ${e.message}`); }
    route();
  })();
})();
