#!/usr/bin/env node
// Ende-til-ende-test: uploader et testbillede gennem den rigtige hjemmeside i en headless browser,
// venter på omkodningen, tjekker visning, delelink og forhåndsbillede, og sletter så testbidraget.
//
// Testbidrag genkendes af workeren på et token afledt af ADMIN_TOKEN: de springer Turnstile over
// og vises aldrig offentligt. Repoet er offentligt, så der logges kun id'er og resultater.
//
//   SITE_URL     https://sloev.github.io/svendborg-skyline/
//   WORKER_URL   https://silo-arkiv.<subdomæne>.workers.dev
//   ADMIN_TOKEN  samme som workerens
//   WAIT_MINUTES hvor længe der ventes på omkodning (standard 20)

import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';

const SITE = must('SITE_URL');
const WORKER = must('WORKER_URL').replace(/\/+$/, '');
const ADMIN = must('ADMIN_TOKEN');
const WAIT_MS = Number(process.env.WAIT_MINUTES || 20) * 60_000;
const E2E = createHash('sha256').update(`e2e:${ADMIN}`).digest('hex');
const marker = `Automatisk test ${new Date().toISOString()} ${randomUUID().slice(0, 8)} – siloerne set fra kajen.`;

let browser;
let subId = null;
let failed = false;
const step = (name) => console.log(`\n▶ ${name}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(`Fejlede: ${msg}`);
  ok(msg);
}

try {
  browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'da-DK', viewport: { width: 1280, height: 900 } });
  // Testflaget gør at siden ikke venter på Turnstile; tokenet sendes kun til workeren.
  await context.addInitScript(() => (window.SILO_E2E = true));
  await context.route(`${WORKER}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-e2e-token': E2E } }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  step('Hjemmesiden');
  await page.goto(`${SITE}?lang=da`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('select[name=relation]').options.length > 1, null, { timeout: 30_000 });
  check((await page.textContent('h1')).includes('Siloerne'), 'siden indlæses på dansk');
  await page.selectOption('#lang', 'en');
  check((await page.textContent('h1')).includes('The silos'), 'sprogvælgeren skifter til engelsk');
  await page.selectOption('#lang', 'de');
  check((await page.textContent('h1')).includes('Die Silos'), 'sprogvælgeren skifter til tysk');
  await page.selectOption('#lang', 'da');

  step('Upload gennem formularen');
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1000;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1600, 1000);
    grad.addColorStop(0, '#14324a');
    grad.addColorStop(1, '#1d8a74');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1600, 1000);
    g.fillStyle = '#fff';
    g.font = 'bold 120px sans-serif';
    g.fillText('E2E-TEST', 420, 540);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  await page.click('#new-item');
  await page.setInputFiles('#file', { name: 'e2e-test.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
  await page.waitForSelector('.step[data-step="2"]:not([hidden])');
  check((await page.textContent('#picked')).includes('Billede'), 'filtypen genkendes som billede');
  check(await page.isVisible('[data-field="place"]'), 'billeder får feltet "Hvorfra er det set?"');
  await page.fill('input[name=title]', 'Automatisk test');
  await page.fill('textarea[name=story]', marker);
  await page.click('.step[data-step="2"] [data-next]');
  await page.waitForSelector('.step[data-step="3"]:not([hidden])');
  await page.fill('input[name=credit]', 'Automatisk test (GitHub Actions)');
  await page.check('input[name=showCredit]');
  await page.check('input[name=consent]');
  await page.waitForTimeout(5500); // formularen skal have været åben i mindst 5 sekunder
  const created = page.waitForResponse((r) => r.url() === `${WORKER}/api/submissions` && r.request().method() === 'POST');
  await page.click('#submit');
  const res = await created;
  const body = await res.json();
  check(res.status() === 200 && body.id, `bidraget oprettes (${res.status()}${body.code ? ` ${body.code}` : ''})`);
  subId = body.id;
  console.log(`  id: ${subId}`);
  check(await page.isVisible('#new-item'), 'formularen lukker, og "Nyt bidrag" vises igen');
  await page.waitForSelector('.upload-item.done', { timeout: 180_000 });
  ok('filen er uploadet og står som sendt i listen');
  await page.click('#new-item');
  check((await page.inputValue('input[name=credit]')) === 'Automatisk test (GitHub Actions)', 'krediteringen huskes til næste bidrag');
  await page.click('[data-cancel]');

  step('Skjult for offentligheden');
  const pub = await fetch(`${WORKER}/api/contributions/${subId}`);
  check(pub.status === 404, 'testbidraget kan ikke ses uden testtoken');

  step('Omkodning');
  const started = Date.now();
  let contribution;
  for (;;) {
    const r = await fetch(`${WORKER}/api/contributions/${subId}`, { headers: { 'x-e2e-token': E2E } });
    contribution = await r.json();
    if (contribution.items && contribution.items.length === 1 && !contribution.processing) break;
    if (Date.now() - started > WAIT_MS) throw new Error('Fejlede: filen blev ikke omkodet i tide (kører "Behandl uploads"?)');
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const item = contribution.items[0];
  check(item.kind === 'image' && item.width === 1600 && item.height === 1000, `billedet er omkodet (${item.width}×${item.height}) på ${Math.round((Date.now() - started) / 1000)} s`);
  check(contribution.credit === 'Automatisk test (GitHub Actions)', 'krediteringen vises offentligt som valgt');
  for (const [name, url, type] of [['fuld størrelse', item.full, 'image/jpeg'], ['skærmversion', item.src, 'image/jpeg'], ['miniature', item.thumb, 'image/jpeg']]) {
    const m = await fetch(url);
    check(m.ok && m.headers.get('content-type') === type, `${name} kan hentes`);
  }

  step('Visning på siden');
  // Som når nogen åbner et delt link: en helt ny side direkte på bidraget.
  const view = await context.newPage();
  view.on('pageerror', (e) => pageErrors.push(e.message));
  await view.goto(`${SITE}?lang=da#bidrag/${subId}`, { waitUntil: 'domcontentloaded' });
  await view.waitForSelector('#viewer[open] #viewer-media img', { timeout: 30_000 });
  await view.waitForFunction(() => document.querySelector('#viewer-media img').naturalWidth > 0, null, { timeout: 30_000 });
  check(true, 'billedet vises i fremviseren');
  check((await view.textContent('#viewer-meta')).includes('Automatisk test (GitHub Actions)'), 'krediteringen vises');
  const fb = await view.getAttribute('#viewer-sharebar .facebook', 'href');
  check(fb && decodeURIComponent(fb).includes(`/s/${subId}`), 'delelinks peger på forhåndsvisningssiden');

  step('Delelink og forhåndsvisning');
  const share = await fetch(`${WORKER}/s/${subId}`, { headers: { 'x-e2e-token': E2E }, redirect: 'manual' });
  const html = await share.text();
  const og = (p) => (html.match(new RegExp(`<meta property="${p}" content="([^"]+)"`)) || [])[1];
  check(share.status === 200 && og('og:title') === 'Automatisk test', 'delesiden har og:title');
  check(og('og:image') && og('og:image').endsWith(`/media/${item.id}/og.jpg`), 'delesiden har eget forhåndsbillede');
  const ogImg = await fetch(og('og:image'));
  check(ogImg.ok && ogImg.headers.get('content-type') === 'image/jpeg', 'forhåndsbilledet kan hentes');
  check(html.includes('name="twitter:card" content="summary_large_image"'), 'delesiden har Twitter/X-kort');
  const shareAnon = await fetch(`${WORKER}/s/${subId}`, { redirect: 'manual' });
  check(shareAnon.status === 302, 'delesiden for et testbidrag er skjult for offentligheden');

  step('Sikkerhed');
  const noOrigin = await fetch(`${WORKER}/api/submissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(noOrigin.status === 403, 'indsendelse uden hjemmesidens Origin afvises');
  const evil = await fetch(`${WORKER}/api/submissions`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  check(evil.status === 403, 'indsendelse fra fremmed side afvises');
  const root = await fetch(`${WORKER}/`, { redirect: 'manual' });
  check([301, 302].includes(root.status), 'workeren viser ikke selv hjemmesiden');
  check(pageErrors.length === 0, `ingen JavaScript-fejl på siden${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
} catch (err) {
  failed = true;
  console.error(`\n✗ ${err.message}`);
} finally {
  if (subId) {
    step('Oprydning');
    const del = await fetch(`${WORKER}/api/admin/submissions/${subId}`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } });
    const gone = await fetch(`${WORKER}/api/contributions/${subId}`, { headers: { 'x-e2e-token': E2E } });
    if (del.ok && gone.status === 404) ok('testbidraget og alle dets filer er slettet');
    else {
      failed = true;
      console.error(`  ✗ kunne ikke slette testbidraget (${del.status})`);
    }
  }
  if (browser) await browser.close();
}
console.log(failed ? '\nTesten FEJLEDE' : '\nAlt virker ✓');
process.exit(failed ? 1 : 0);

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} skal være sat`);
    process.exit(2);
  }
  return v;
}
