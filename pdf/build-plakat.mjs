#!/usr/bin/env node
// Laver public/plakat.pdf (A4) ud fra pdf/plakat.html. Kræver Playwright (som build-pdf.mjs).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // FONTS_CSS: lokal kopi af Google Fonts-css'en, hvis maskinen ikke kan hente fra nettet.
  if (process.env.FONTS_CSS) await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ path: process.env.FONTS_CSS, contentType: 'text/css' }));
  await page.goto(pathToFileURL(path.join(here, 'plakat.html')).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: path.join(here, '..', 'public', 'plakat.pdf'), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  console.log('Gemt public/plakat.pdf');
} finally {
  await browser.close();
}
