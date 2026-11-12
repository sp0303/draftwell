// Renders a resume to PDF with headless Chromium, using the exact same
// templates and CSS the browser preview uses.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Templates = require('../public/js/templates.js');

const resumeCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'resume.css'), 'utf8');

let browserPromise;
function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function html(data, theme, accent) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${Templates.FONTS_URL}">
<style>${resumeCss}</style>
<style>@page{size:A4;margin:0}html,body{margin:0;background:#fff}.sheet{position:relative!important;transform:none!important}</style>
</head><body>${Templates.render(data, theme, accent)}</body></html>`;
}

async function renderPdf(data, theme, accent) {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html(data, theme, accent), { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserPromise) (await browserPromise).close();
  browserPromise = null;
}

module.exports = { renderPdf, closeBrowser };
