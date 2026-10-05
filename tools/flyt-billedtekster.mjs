#!/usr/bin/env node
// Flytter billedtekster fra bidragets historie ud på de enkelte filer, så hver tekst står ved sit
// billede. Gælder bidrag med flere filer, hvor historien har en punktliste (eller, for Finn
// Johannessens billeder, ét afsnit pr. billede) med præcis lige så mange punkter som filer.
// Punkterne fjernes fra historien; resten (indledning, kilde) bliver stående.
// Bidrag, der ikke passer, røres ikke og skrives ud til gennemsyn.
//
// Miljø: WORKER_URL, ADMIN_TOKEN, DRY=1 (vis kun, hvad der ville ske),
//        FINNJ=<sti til captions.json> (valgfri: billedtekst pr. billedfil fra finn-j.dk-siderne,
//        { "<filnavn>": { "caption": "…" } }; bruges i stedet for punktlisten, når alle filer findes)

import { readFileSync } from 'node:fs';

const WORKER = must('WORKER_URL').replace(/\/+$/, '');
const auth = { authorization: `Bearer ${must('ADMIN_TOKEN')}` };

const subs = [];
let before = '';
for (;;) {
  const res = await fetch(`${WORKER}/api/admin/submissions?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`, { headers: auth });
  if (!res.ok) throw new Error(`liste: ${res.status}`);
  const data = await res.json();
  subs.push(...data.submissions);
  if (!data.next) break;
  before = data.next;
}

const plain = (x) => x.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[\s(])\*([^*]+)\*/g, '$1$2').replace(/\s+/g, ' ').trim();

// "**14** (FJ 1985): Ærøfærgernes leje." → "Ærøfærgernes leje. (FJ 1985)"
function finnBullet(line) {
  const m = line.match(/^\*\*\d+[a-z]?\*\*\s*(?:\((.*?)\):|:)?\s*(.*)$/);
  if (!m) return plain(line);
  let [, paren = '', text] = m;
  text = plain(text) === '–' ? '' : plain(text);
  paren = plain(paren).replace(/^SLUT$/i, '');
  if (!paren) return text;
  if (/^(FJ\b|ca\.|\d)/i.test(paren) || paren.length < 30) return text ? `${text} (${paren})` : paren;
  return `${paren}${/[.!?]$/.test(paren) ? '' : '.'} ${text}`.trim();
}

const finnj = process.env.FINNJ ? JSON.parse(readFileSync(process.env.FINNJ, 'utf8')) : {};

const done = [];
const skipped = [];
for (const s of subs) {
  if (s.status === 'uploading' || s.is_test || s.items.length < 2) continue;
  if (s.items.some((i) => i.caption)) continue; // allerede gjort
  const story = String(s.story || '');
  const lines = story.split('\n');
  let start = lines.findIndex((l) => /^- /.test(l));
  let captions = null;
  let rest = null;
  const sorted = s.items.slice().sort((a, b) => a.position - b.position);
  const cut = story.indexOf('*Fra Finn Johannessens');
  if (cut > -1 && sorted.every((it) => finnj[it.original_name])) {
    // Præcise billedtekster fra finn-j.dk; listen/afsnittene i historien er så overflødige.
    captions = sorted.map((it) => finnj[it.original_name].caption || '');
    rest = (start > -1 && start < cut ? lines.slice(0, start).join('\n') + '\n\n' : '') + story.slice(cut);
  } else if (start > -1) {
    let end = start;
    while (end < lines.length && /^- /.test(lines[end])) end++;
    const bullets = lines.slice(start, end).map((l) => l.slice(2).trim());
    // Punktlisten under "**Kilde**" er kilder, ikke billedtekster.
    const isSource = /^\*\*Kilde\*\*/.test(lines[start - 1] || '') || /^\*\*Kilde\*\*/.test(lines[start - 2] || '');
    if (!isSource && bullets.length === s.items.length) {
      captions = bullets.map((b) => (/^\*\*\d+[a-z]?\*\*/.test(b) ? finnBullet(b) : plain(b)));
      const head = lines.slice(0, start);
      // "… med hans egne billedtekster:" → slut med punktum, når listen er væk.
      for (let k = head.length - 1; k >= 0; k--) {
        if (!head[k].trim()) continue;
        head[k] = head[k].replace(/:\s*$/, '.');
        break;
      }
      rest = [...head, ...lines.slice(end)].join('\n');
    }
  }
  if (!captions && cut > -1) {
    // Finn Johannessens enkeltsider: ét afsnit pr. billede før kildenoten.
    const paras = story.slice(0, cut).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paras.length === s.items.length) {
      captions = paras.map(plain);
      rest = story.slice(cut);
    }
  }
  if (!captions) {
    skipped.push(`${s.status.padEnd(9)} ${s.items.length} filer · ${s.title}`);
    continue;
  }
  rest = rest.replace(/\n{3,}/g, '\n\n').trim();
  const byId = Object.fromEntries(sorted.map((it, n) => [it.id, captions[n].slice(0, 600)]));
  done.push({ s, byId, rest });
}

for (const { s, byId, rest } of done) {
  console.log(`\n✓ ${s.title}`);
  for (const [n, c] of Object.values(byId).entries()) console.log(`   ${n + 1}. ${c.slice(0, 110)}`);
  if (process.env.DRY) continue;
  const res = await fetch(`${WORKER}/api/admin/submissions/${s.id}/meta`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ captions: byId, story: rest }),
  });
  if (!res.ok) throw new Error(`${s.title}: ${res.status}`);
}
console.log(`\n${done.length} bidrag fik billedtekster pr. fil. Ikke rørt (gennemse i admin):`);
for (const x of skipped) console.log(`  – ${x}`);

function must(k) {
  if (!process.env[k]) throw new Error(`mangler ${k}`);
  return process.env[k];
}
