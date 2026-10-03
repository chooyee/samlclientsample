// The customer-facing shell: Acme Bank, a pretend bank whose online banking signs in through
// Keycloak. Reuses the UI kit's components with a banking theme; no admin settings appear here.
import { esc, icon, css, script, flashAlert, initials, displayName } from './ui.js';

export const BANK = 'Acme Bank';

const bankCss = `
body.bank {
  --bg: #f3f5f8; --surface: #fff; --surface-2: #eef1f6; --fg: #0c1b2e; --muted: #56657a; --line: #dfe4eb; --line-strong: #c4ceda;
  --accent: #0a3a68; --accent-hover: #072c50; --accent-fg: #fff; --accent-soft: #e5edf6;
  --gold: #9a6f17; --gold-bright: #e2b65c; --gold-soft: #fbf4e3; --navy-1: #071d36; --navy-2: #0d3b69;
  --shadow: 0 1px 2px rgb(7 29 54 / .05), 0 2px 8px rgb(7 29 54 / .05);
  --radius: 12px; --serif: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 15px;
}
@media (prefers-color-scheme: dark) {
  body.bank {
    --bg: #07101b; --surface: #0d1928; --surface-2: #132238; --fg: #e7ecf2; --muted: #95a3b6; --line: #1d2e45; --line-strong: #2b4262;
    --accent: #79aee8; --accent-hover: #9cc5f1; --accent-fg: #061220; --accent-soft: #10253f;
    --gold: #e2b65c; --gold-soft: #241c0c; --shadow: none;
  }
}
.bank-wrap { width: 100%; max-width: 1120px; margin: 0 auto; padding-left: 24px; padding-right: 24px; }
@media (max-width: 600px) { .bank-wrap { padding-left: 16px; padding-right: 16px; } }
.display { font-family: var(--serif); font-weight: 700; letter-spacing: -.005em; }

/* demo notice, header, footer */
.demo-bar { background: var(--gold-soft); border-bottom: 1px solid color-mix(in srgb, var(--gold) 30%, transparent); font-size: 13px; }
.demo-bar .bank-wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; padding-top: 8px; padding-bottom: 8px; }
.demo-bar p { display: flex; gap: 8px; align-items: flex-start; margin: 0; }
.demo-bar p .icon { color: var(--gold); margin-top: 3px; }
.demo-bar a { display: inline-flex; align-items: center; gap: 6px; color: var(--fg); font-weight: 600; }
.bank-header { background: var(--navy-1); color: #fff; }
.bank-header .bank-wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; min-height: 68px; padding-top: 10px; padding-bottom: 10px; }
.bank-brand { display: inline-flex; align-items: center; gap: 10px; color: #fff; text-decoration: none; font-family: var(--serif); font-size: 22px; font-weight: 700; }
.bank-brand:hover { color: #fff; }
.bank-mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 9px; background: linear-gradient(135deg, #e2b65c, #a87b1f); color: var(--navy-1); }
.bank-mark .icon { width: 20px; height: 20px; }
.bank-tag { color: rgb(255 255 255 / .7); font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
.bank-user { display: flex; align-items: center; gap: 12px; }
.bank-user .who { display: flex; align-items: center; gap: 8px; color: #fff; font-weight: 500; max-width: 240px; }
.bank-user .who span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bank-user .avatar { background: rgb(255 255 255 / .14); color: #fff; }
.btn.on-dark { background: transparent; border-color: rgb(255 255 255 / .35); color: #fff; }
.btn.on-dark:hover { background: rgb(255 255 255 / .1); color: #fff; }
.bank-main { padding-top: 32px; padding-bottom: 64px; }
.bank-foot { border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
.bank-foot .bank-wrap { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; padding-top: 20px; padding-bottom: 28px; }
.bank-foot a { color: var(--muted); }
body.bank .btn { border-radius: 10px; }
body.bank .btn.lg { min-height: 48px; font-size: 15.5px; }
body.bank .btn.block { white-space: normal; text-align: center; }
body.bank .card { border-radius: 14px; }
body.bank .grid-2 > .card { display: flex; flex-direction: column; }
body.bank .grid-2 > .card > .card-body { flex: 1; }

/* landing */
.hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 28px; align-items: start; }
@media (max-width: 880px) { .hero { grid-template-columns: 1fr; } }
.hero-panel { padding: 40px; border-radius: 18px; color: #fff; background: radial-gradient(120% 90% at 100% 0%, rgb(226 182 92 / .18), transparent 55%), linear-gradient(155deg, var(--navy-2), var(--navy-1)); }
@media (max-width: 600px) { .hero-panel { padding: 28px 22px; } }
.hero-panel h1 { margin: 0 0 12px; font-size: clamp(28px, 4vw, 38px); line-height: 1.15; }
.hero-panel > p { margin: 0; max-width: 52ch; color: rgb(255 255 255 / .82); }
.hero-panel a { color: var(--gold-bright); }
.eyebrow { display: inline-block; margin-bottom: 14px; color: var(--gold-bright); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.eyebrow.dark { color: var(--gold); margin-bottom: 6px; }
.journey { display: grid; gap: 16px; margin: 30px 0 0; padding: 0; list-style: none; counter-reset: journey; }
.journey li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 14px; align-items: start; }
.journey li::before { counter-increment: journey; content: counter(journey); display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgb(255 255 255 / .28); background: rgb(255 255 255 / .1); color: var(--gold-bright); font-weight: 700; }
.journey strong { display: block; color: #fff; }
.journey span { color: rgb(255 255 255 / .72); font-size: 14px; }
.signin-card { display: grid; gap: 16px; padding: 28px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); box-shadow: 0 12px 32px rgb(7 29 54 / .08); }
@media (max-width: 600px) { .signin-card { padding: 22px 18px; } }
.signin-card h2 { font-size: 26px; }
.signin-card > p { margin: -8px 0 0; color: var(--muted); }
.choice-label { margin: 0 0 6px; color: var(--muted); font-size: 13px; font-weight: 500; }
.segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2); }
.segmented a, .segmented span { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border-radius: 8px; color: var(--muted); font-size: 13.5px; font-weight: 600; text-decoration: none; text-align: center; }
.segmented a:hover { color: var(--fg); }
.segmented a[aria-current="true"] { background: var(--surface); color: var(--accent); box-shadow: 0 1px 3px rgb(7 29 54 / .12); }
.segmented span[aria-disabled] { opacity: .55; cursor: not-allowed; }
.segmented small { font-weight: 500; }
.or { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12.5px; text-transform: uppercase; letter-spacing: .08em; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.trust { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 12px 14px; border-radius: 10px; background: var(--accent-soft); color: var(--fg); font-size: 13px; }
.trust .icon { color: var(--accent); margin-top: 2px; }
.testers { font-size: 13.5px; }
.testers ul { display: grid; gap: 6px; margin: 0; padding-left: 18px; }
.audiences { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 16px; }
.audience { display: grid; gap: 8px; align-content: start; padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.proto-icon.accent { background: var(--accent-soft); color: var(--accent); }
.proto-icon.gold { background: var(--gold-soft); color: var(--gold); }
.audience h3 { font-size: 15px; }
.audience p { margin: 0; color: var(--muted); font-size: 14px; }
.section-title { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin: 0 0 14px; }
.section-title h2 { font-size: 20px; }

/* signed in */
.greeting { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; }
.greeting h1 { margin: 0; font-size: clamp(26px, 3.5vw, 32px); line-height: 1.2; overflow-wrap: anywhere; }
.greeting p { margin: 4px 0 0; color: var(--muted); overflow-wrap: anywhere; }
.accounts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 16px; }
.account { padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow); }
.account.feature { border-color: transparent; background: linear-gradient(155deg, var(--navy-2), var(--navy-1)); color: #fff; }
.account .label { display: flex; align-items: center; gap: 8px; color: var(--muted); font-weight: 500; }
.account.feature .label { color: rgb(255 255 255 / .78); }
.account .amount { margin: 12px 0 2px; font-size: 26px; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
.account .num { color: var(--muted); font-family: var(--mono); font-size: 12.5px; }
.account.feature .num { color: rgb(255 255 255 / .65); }
.dev-panel { border: 1px dashed var(--line-strong); border-radius: 14px; background: var(--surface); scroll-margin-top: 16px; }
.dev-panel > summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 16px 20px; cursor: pointer; list-style: none; }
.dev-panel > summary::-webkit-details-marker { display: none; }
.dev-panel > summary .icon { color: var(--muted); }
.dev-panel > summary strong { font-weight: 600; }
.dev-panel > summary .chev { margin-left: auto; transform: rotate(180deg); transition: transform .15s; }
.dev-panel[open] > summary .chev { transform: rotate(270deg); }
.dev-panel > .dev-body { display: grid; gap: 16px; padding: 0 20px 20px; }

/* narrow pages: legacy sign-in, hand-off */
.narrow { display: grid; gap: 16px; width: 100%; max-width: 480px; margin: 0 auto; }
.back-link { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-weight: 500; text-decoration: none; }
.demo-creds { padding: 16px 18px; border: 1px dashed color-mix(in srgb, var(--gold) 55%, transparent); border-radius: 12px; background: var(--gold-soft); font-size: 13.5px; }
.demo-creds strong { display: block; margin-bottom: 6px; }
.demo-creds .row { margin-top: 8px; }
.handoff { justify-items: center; text-align: center; }
.handoff h1 { margin: 0; font-size: 24px; }
.handoff p { margin: 0; color: var(--muted); }
`;

const favicon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#071d36"/><text x="16" y="22" font-family="Georgia,serif" font-size="17" font-weight="700" fill="#e2b65c" text-anchor="middle">A</text></svg>')}`;

function userMenu(user) {
  if (!user) return `<span class="bank-tag">Online Banking</span>`;
  const name = displayName(user);
  return `<div class="bank-user">
    <span class="who" title="Signed in as ${esc(name)}"><span class="avatar">${esc(initials(name))}</span><span>${esc(name)}</span></span>
    <form class="inline" method="post" action="/logout"><button class="btn sm on-dark">${icon('logout')}Sign out</button></form></div>`;
}

export function bankLayout({ title, user, flash, body, head = '', showUser = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${BANK}</title>
<link rel="icon" href="${favicon}">
<style>${css}${bankCss}</style>${head}
</head>
<body class="bank">
<a class="skip" href="#main">Skip to content</a>
<div class="demo-bar" role="note"><div class="bank-wrap">
  <p>${icon('info')}<span><strong>Demo bank.</strong> A test app that signs customers in through Keycloak, registered in CloakTail. No real accounts or money.</span></p>
  <a href="/admin">${icon('sliders')}Admin console</a>
</div></div>
<header class="bank-header"><div class="bank-wrap">
  <a class="bank-brand" href="/"><span class="bank-mark">${icon('landmark')}</span>${BANK}</a>
  ${showUser ? userMenu(user) : ''}
</div></header>
<main id="main" class="bank-wrap bank-main">
  ${flash ? flashAlert(flash) : ''}
  ${body}
</main>
<footer class="bank-foot"><div class="bank-wrap">
  <span>${BANK} is fictional: a test service provider for CloakTail.</span>
  <span><a href="/legacy">Legacy sign-in</a> · <a href="/admin">Admin console</a></span>
</div></footer>
<script>${script}</script>
</body>
</html>`;
}
