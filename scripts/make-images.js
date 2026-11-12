// Renders the site's icons and social-share image into public/ with headless Chromium.
// Run after changing the brand: node scripts/make-images.js
const path = require('path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'public');
const MARK = (size, radius) => `<div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:#b8562f;display:grid;place-items:center">
  <svg width="${size * 0.56}" height="${size * 0.56}" viewBox="0 0 16 16" fill="none"><path d="M4 2.5h5.5L12 5v8.5H4z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 8h4M6 10.5h3" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg></div>`;
const page = (body, w, h) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,600;0,8..60,700;1,8..60,600&family=Space+Grotesk:wght@600;700&display=block">
<style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}*{box-sizing:border-box}</style></head><body>${body}</body></html>`;

const OG = `<div style="width:1200px;height:630px;background:#f7f6f2;color:#1d1c1a;font-family:Inter,sans-serif;display:grid;grid-template-columns:1.25fr 1fr;gap:48px;align-items:center;padding:64px 72px">
  <div>
    <div style="display:flex;align-items:center;gap:14px;font-family:'Source Serif 4',serif;font-weight:700;font-size:34px">${MARK(52, 13)}Resumely</div>
    <div style="font-family:'Source Serif 4',serif;font-weight:600;font-size:60px;line-height:1.05;letter-spacing:-.015em;margin-top:40px">100 job applications.<br>100 resumes.<br><span style="color:#b8562f;font-style:italic">Made easy.</span></div>
    <div style="font-size:24px;color:#6b6862;margin-top:26px;line-height:1.4">Tailor your resume to every job with AI.<br>ATS match score included.</div>
  </div>
  <div style="background:#fff;border:1px solid #e3e0d7;border-radius:22px;padding:30px;box-shadow:0 2px 4px rgba(40,30,20,.06),0 18px 40px rgba(40,30,20,.12)">
    <div style="display:flex;gap:20px;align-items:center">
      <div style="position:relative;width:120px;height:120px">
        <svg width="120" height="120" viewBox="0 0 100 100" style="transform:rotate(-90deg)"><circle cx="50" cy="50" r="42" fill="none" stroke="#efede6" stroke-width="9"/><circle cx="50" cy="50" r="42" fill="none" stroke="#b8562f" stroke-width="9" stroke-linecap="round" stroke-dasharray="263.89" stroke-dashoffset="47.5"/></svg>
        <div style="position:absolute;inset:0;display:grid;place-content:center;text-align:center;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:40px;line-height:1">82<div style="font-family:Inter;font-weight:400;font-size:13px;color:#6b6862;margin-top:4px">of 100</div></div>
      </div>
      <div><div style="font-size:15px;color:#6b6862">ATS match</div><div style="font-family:'Source Serif 4',serif;font-weight:600;font-size:28px">Strong match</div>
        <div style="display:inline-block;margin-top:8px;font-size:14px;font-weight:600;color:#2f6b4f;background:#e1efe7;padding:4px 10px;border-radius:999px">68 → 82 after tailoring</div></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:24px">
      ${['React', 'TypeScript', 'Design systems', 'REST APIs'].map((k) => `<span style="font-size:15px;padding:5px 12px;border-radius:999px;color:#2f6b4f;background:#e1efe7">✓ ${k}</span>`).join('')}
      ${['GraphQL', 'Next.js'].map((k) => `<span style="font-size:15px;padding:5px 12px;border-radius:999px;color:#6b6862;background:#efede6">${k}</span>`).join('')}
    </div>
  </div>
</div>`;

(async () => {
  const browser = await chromium.launch();
  const shot = async (html, w, h, file, omitBackground = false) => {
    const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.setContent(page(html, w, h), { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(OUT, file), omitBackground });
    await p.close();
    console.log('wrote', file);
  };
  await shot(OG, 1200, 630, 'og.png');
  await shot(MARK(180, 40), 180, 180, 'apple-touch-icon.png', true);
  await shot(MARK(192, 42), 192, 192, 'icon-192.png', true);
  await shot(MARK(512, 112), 512, 512, 'icon-512.png', true);
  await shot(MARK(32, 7), 32, 32, 'favicon-32.png', true);
  await browser.close();
})();
