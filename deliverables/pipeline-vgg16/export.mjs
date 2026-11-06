// Exporta pipeline.html a PNG (2x) y SVG con texto real, y verifica desbordes.
// Uso: node export.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(join(here, 'pipeline.html')).href;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const fontsOk = await page.evaluate(() => [
  document.fonts.check('16px "Source Sans 3"'),
  document.fonts.check('700 16px "Source Sans 3"'),
  document.fonts.check('600 42px "Source Serif 4"'),
]);

// Verificación de desbordes y tamaño mínimo de texto
const report = await page.evaluate(() => {
  const issues = [];
  for (const el of document.querySelectorAll('.card, .box, .model, .branch, .slide')) {
    if (el.scrollHeight > el.clientHeight + 0.5 || el.scrollWidth > el.clientWidth + 0.5) {
      issues.push(`overflow ${el.className}: ${el.scrollHeight}/${el.clientHeight} h, ${el.scrollWidth}/${el.clientWidth} w :: ${el.textContent.trim().slice(0, 40)}`);
    }
  }
  // Ningún hijo se sale del rectángulo de su tarjeta
  for (const box of document.querySelectorAll('.card, .box')) {
    const b = box.getBoundingClientRect();
    for (const ch of box.querySelectorAll('*')) {
      const r = ch.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > b.right - 1 || r.bottom > b.bottom - 1 || r.left < b.left || r.top < b.top) {
        issues.push(`child outside ${box.querySelector('h2')?.textContent}: ${ch.tagName}.${ch.className} ${ch.textContent.trim().slice(0, 30)}`);
      }
    }
  }
  const sizes = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    if (!n.textContent.trim()) continue;
    const fs = parseFloat(getComputedStyle(n.parentElement).fontSize);
    sizes.add(fs);
  }
  return { issues, sizes: [...sizes].sort((a, b) => a - b) };
});

await page.screenshot({ path: join(here, 'pipeline.png'), clip: { x: 0, y: 0, width: 1920, height: 1080 } });

// ---------- SVG ----------
const svg = await page.evaluate(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const out = [];
  const px = (v) => Math.round(v * 100) / 100;
  const isTransparent = (c) => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);

  // Línea base por fuente: offset desde el borde superior del rect de un rango
  const baseCache = new Map();
  function baselineRatio(family, weight, size) {
    const key = `${family}|${weight}|${size}`;
    if (baseCache.has(key)) return baseCache.get(key);
    const s = document.createElement('span');
    s.style.cssText = `font-family:${family};font-weight:${weight};font-size:${size}px;line-height:normal;position:absolute;left:0;top:0;white-space:nowrap`;
    s.textContent = 'Hg';
    const m = document.createElement('i');
    m.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    s.appendChild(m);
    document.body.appendChild(s);
    const rng = document.createRange();
    rng.selectNodeContents(s.firstChild);
    const top = rng.getBoundingClientRect().top;
    const base = m.getBoundingClientRect().top;
    s.remove();
    const v = base - top;
    baseCache.set(key, v);
    return v;
  }

  // 1) Cajas (fondos y bordes) en orden de documento
  for (const el of document.querySelectorAll('.slide *')) {
    if (el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const bg = cs.backgroundColor;
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs[`border${s}Width`]) || 0);
    const bc = ['Top', 'Right', 'Bottom', 'Left'].map((s) => cs[`border${s}Color`]);
    const uniform = bw.every((w) => w === bw[0]) && bw[0] > 0 && bc.every((c) => c === bc[0]);
    const rx = parseFloat(cs.borderTopLeftRadius) || 0;
    if (!isTransparent(bg) || uniform) {
      const sw = uniform ? bw[0] : 0;
      const attrs = [
        `x="${px(r.left + sw / 2)}"`, `y="${px(r.top + sw / 2)}"`,
        `width="${px(r.width - sw)}"`, `height="${px(r.height - sw)}"`,
      ];
      if (rx) attrs.push(`rx="${px(Math.max(rx - sw / 2, 0))}"`);
      attrs.push(`fill="${isTransparent(bg) ? 'none' : bg}"`);
      if (uniform) attrs.push(`stroke="${bc[0]}"`, `stroke-width="${sw}"`);
      out.push(`<rect ${attrs.join(' ')}/>`);
    }
    if (!uniform) {
      if (bw[0] > 0) out.push(`<rect x="${px(r.left)}" y="${px(r.top)}" width="${px(r.width)}" height="${px(bw[0])}" fill="${bc[0]}"/>`);
      if (bw[2] > 0) out.push(`<rect x="${px(r.left)}" y="${px(r.bottom - bw[2])}" width="${px(r.width)}" height="${px(bw[2])}" fill="${bc[2]}"/>`);
    }
  }

  // 2) Flechas (SVG en línea)
  for (const s of document.querySelectorAll('.slide svg')) {
    const r = s.getBoundingClientRect();
    out.push(`<g transform="translate(${px(r.left)} ${px(r.top)})">${s.innerHTML.trim()}</g>`);
  }

  // 3) Texto por línea renderizada
  const walker = document.createTreeWalker(document.querySelector('.slide'), NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    if (!text.trim()) continue;
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    const upper = cs.textTransform === 'uppercase';
    const family = cs.fontFamily;
    const weight = cs.fontWeight;
    const size = parseFloat(cs.fontSize);
    const base = baselineRatio(family, weight, size);
    // palabras con su rect
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      const rng = document.createRange();
      rng.setStart(node, m.index);
      rng.setEnd(node, m.index + m[0].length);
      const rects = rng.getClientRects();
      if (!rects.length) continue;
      words.push({ start: m.index, end: m.index + m[0].length, r: rects[0] });
    }
    // agrupar por línea
    const lines = [];
    for (const w of words) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - w.r.top) < 2) { last.end = w.end; }
      else lines.push({ top: w.r.top, x: w.r.left, start: w.start, end: w.end });
    }
    for (const l of lines) {
      let t = text.slice(l.start, l.end).replace(/\s+/g, ' ');
      if (upper) t = t.toUpperCase();
      const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
      const famAttr = family.replace(/"/g, "'");
      out.push(`<text x="${px(l.x)}" y="${px(l.top + base)}" font-family="${esc(famAttr)}" font-size="${size}" font-weight="${weight}" fill="${cs.color}"${ls ? ` letter-spacing="${px(ls)}"` : ''}>${esc(t)}</text>`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<defs><style>@import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&amp;family=Source+Serif+4:opsz,wght@8..60,600&amp;display=block');</style></defs>
<rect width="1920" height="1080" fill="#FFFFFF"/>
${out.join('\n')}
</svg>
`;
});
writeFileSync(join(here, 'pipeline.svg'), svg);

// Render del SVG para comparar con el PNG
const p2 = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p2.goto(pathToFileURL(join(here, 'pipeline.svg')).href, { waitUntil: 'networkidle' });
await p2.waitForTimeout(500);
await p2.screenshot({ path: join(process.env.SVG_CHECK_DIR || here, 'svg-check.png') });

await browser.close();
console.log(JSON.stringify({ fontsOk, ...report }, null, 2));
