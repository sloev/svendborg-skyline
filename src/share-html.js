// Delesiden for ét bidrag: Open Graph- og Twitter-tags, så links får et pænt kort på Facebook,
// Messenger, X, LinkedIn, Slack osv. Mennesker sendes videre til bidraget på hjemmesiden.
// Bruges af workeren (/s/<id>) og af tools/delesider.mjs, der lægger statiske delesider på
// hjemmesiden (havn.skifting.net/s/<id>/), når den udgives.

// Historier gemmes som simpel Markdown (fed, kursiv, overskrifter, lister, links). Uden tegnene:
export function plainText(md) {
  return String(md || '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(?!\s)(.+?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^([-*•]|\d+[.)])\s+/gm, '');
}

export function truncate(str, max) {
  str = String(str || '').replace(/\s+/g, ' ').trim();
  return str.length > max ? `${str.slice(0, max - 1).trimEnd()}…` : str;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// p: { title, story, credit (kun hvis den må vises), kinds: ['image', …] for de færdige filer,
//      image, video (absolutte adresser), target (bidraget på hjemmesiden), shareUrl (denne side) }
export function shareHtml(p) {
  const counts = p.kinds.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  const what = [
    counts.image && `${counts.image} ${counts.image === 1 ? 'billede' : 'billeder'}`,
    counts.video && `${counts.video} ${counts.video === 1 ? 'video' : 'videoer'}`,
    counts.audio && `${counts.audio} lydoptagelse${counts.audio === 1 ? '' : 'r'}`,
  ].filter(Boolean).join(', ');
  const story = plainText(p.story);
  const title = p.title || (story ? truncate(story, 70) : 'Et bidrag om siloerne');
  const desc = truncate(
    [story, what && `(${what})`, p.credit ? `– ${p.credit}` : ''].filter(Boolean).join(' ') ||
      'Billeder, videoer og historier om siloerne på Østre Kaj i Svendborg.',
    200,
  );
  const e = escapeHtml;
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} – Siloerne på Østre Kaj</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${e(p.target)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Siloerne på Østre Kaj">
<meta property="og:locale" content="da_DK">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:url" content="${e(p.shareUrl)}">
<meta property="og:image" content="${e(p.image)}">
<meta property="og:image:alt" content="${e(title)}">
${p.video ? `<meta property="og:video" content="${e(p.video)}">\n<meta property="og:video:type" content="video/mp4">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(desc)}">
<meta name="twitter:image" content="${e(p.image)}">
<meta http-equiv="refresh" content="0; url=${e(p.target)}">
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f5f1ea;color:#14324a;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}a{color:#1d8a74}</style>
</head>
<body><p><a href="${e(p.target)}">Se bidraget om siloerne på Østre Kaj →</a></p></body>
</html>
`;
}
