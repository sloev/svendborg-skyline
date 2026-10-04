// Where the API (the Cloudflare Worker) lives.
// Empty = same origin (the worker serves the site itself, e.g. `npm run dev`).
// The GitHub Pages workflow overwrites this file with the repository variable WORKER_URL.
window.SILO_CONFIG = { apiBase: '' };
