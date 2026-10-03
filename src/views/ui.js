// UI kit for the server-rendered pages: design tokens, layout and small components.
// Plain template literals, no build step. Every value from outside goes through esc().
import { config } from '../config.js';

export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------- icons (24px stroke icons, lucide style) ----------

const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bad: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  migrate: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  landmark: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="m12 2 8 5H4z"/>',
  card: '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- styles ----------

export const css = `
:root {
  color-scheme: light;
  --bg: #f6f7f9; --surface: #fff; --surface-2: #f1f3f6; --fg: #0f172a; --muted: #5b6474; --line: #e3e6eb; --line-strong: #cdd2da;
  --accent: #4f46e5; --accent-hover: #4338ca; --accent-fg: #fff; --accent-soft: #eef2ff;
  --ok: #15803d; --ok-soft: #ecfdf3; --warn: #b45309; --warn-soft: #fffbeb; --bad: #b91c1c; --bad-soft: #fef2f2; --info: #1d4ed8; --info-soft: #eff6ff;
  --saml: #0f766e; --saml-soft: #e6f6f4; --oidc: #7c3aed; --oidc-soft: #f3efff; --legacy: #9a3412; --legacy-soft: #fff1e6;
  --shadow: 0 1px 2px rgb(15 23 42 / .05), 0 1px 3px rgb(15 23 42 / .06);
  --radius: 10px; --mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0b0d12; --surface: #12151c; --surface-2: #191d26; --fg: #e6e8ee; --muted: #9aa3b2; --line: #242a35; --line-strong: #353d4b;
    --accent: #818cf8; --accent-hover: #a5b4fc; --accent-fg: #0b0d12; --accent-soft: #1e1b4b;
    --ok: #4ade80; --ok-soft: #062b16; --warn: #fbbf24; --warn-soft: #2a1d05; --bad: #f87171; --bad-soft: #2c1010; --info: #93c5fd; --info-soft: #0c1a33;
    --saml: #2dd4bf; --saml-soft: #06302c; --oidc: #c4b5fd; --oidc-soft: #231640; --legacy: #fdba74; --legacy-soft: #2e1607;
    --shadow: none;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); text-underline-offset: 2px; }
a:hover { color: var(--accent-hover); }
code, pre, kbd { font-family: var(--mono); font-size: 12.5px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.icon { width: 16px; height: 16px; flex: none; }
.skip { position: absolute; left: -999px; top: 8px; z-index: 10; background: var(--surface); padding: 8px 12px; border-radius: 8px; }
.skip:focus { left: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* shell */
.shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 20px; padding: 20px 14px; border-right: 1px solid var(--line); background: var(--surface); }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 8px; color: var(--fg); text-decoration: none; }
.brand:hover { color: var(--fg); }
.logo { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font-weight: 700; font-size: 12px; letter-spacing: .02em; }
.brand strong { display: block; font-size: 14px; line-height: 1.2; }
.brand small { display: block; color: var(--muted); font-size: 12px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-label { padding: 12px 10px 4px; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; color: var(--muted); text-decoration: none; font-weight: 500; white-space: nowrap; }
.nav a:hover { background: var(--surface-2); color: var(--fg); }
.nav a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); }
.nav .dot { margin-left: auto; }
.sidebar-foot { margin-top: auto; padding: 0 10px; color: var(--muted); font-size: 12px; }
.sidebar-foot code { display: block; margin-top: 2px; color: var(--fg); word-break: break-all; }
.content { min-width: 0; }
.topbar { display: flex; justify-content: flex-end; align-items: center; gap: 12px; min-height: 56px; padding: 10px 32px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 5; }
main { max-width: 980px; margin: 0 auto; padding: 28px 32px 80px; }
@media (max-width: 900px) {
  .shell { display: block; }
  .sidebar { position: static; height: auto; flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--line); }
  .nav { flex-direction: row; overflow-x: auto; width: 100%; margin: 0 -4px; padding-bottom: 2px; }
  .nav-label, .sidebar-foot { display: none; }
  .topbar { padding: 8px 16px; position: static; }
  main { padding: 20px 16px 64px; }
}

/* session chip */
.chip { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--fg); text-decoration: none; font-size: 13px; max-width: 100%; }
.chip.empty { padding: 5px 12px; color: var(--muted); }
.chip span.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.avatar { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 600; font-size: 11px; }
.avatar.lg { width: 52px; height: 52px; font-size: 18px; }

/* type */
.page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; margin-bottom: 24px; }
.page-head h1 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0; font-size: 24px; line-height: 1.25; letter-spacing: -.01em; }
.page-head p { margin: 6px 0 0; color: var(--muted); max-width: 64ch; }
h2 { font-size: 16px; margin: 0; letter-spacing: -.005em; }
h3 { font-size: 14px; margin: 0; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.stack { display: grid; gap: 16px; }
.stack-lg { display: grid; gap: 24px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 16px; }

/* card */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); scroll-margin-top: 72px; }
.card-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 0; }
.card-head > div { flex: 1; min-width: 0; }
.card-head h2 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.card-head p { margin: 4px 0 0; color: var(--muted); overflow-wrap: anywhere; }
.card-body { padding: 16px 20px 20px; }
.card-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--surface-2); border-radius: 0 0 var(--radius) var(--radius); }
.step { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 12.5px; margin-top: -1px; }
.proto-icon { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 9px; }
.proto-icon .icon { width: 18px; height: 18px; }
.proto-icon.saml { background: var(--saml-soft); color: var(--saml); }
.proto-icon.oidc { background: var(--oidc-soft); color: var(--oidc); }
.proto-icon.legacy { background: var(--legacy-soft); color: var(--legacy); }

/* badges */
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; border: 1px solid transparent; font-size: 12px; font-weight: 500; line-height: 20px; white-space: nowrap; background: var(--surface-2); color: var(--muted); }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.bad { background: var(--bad-soft); color: var(--bad); }
.badge.saml { background: var(--saml-soft); color: var(--saml); }
.badge.oidc { background: var(--oidc-soft); color: var(--oidc); }
.badge.legacy { background: var(--legacy-soft); color: var(--legacy); }
.badge.outline { background: transparent; border-color: var(--line-strong); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line-strong); flex: none; }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }

/* buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 7px 14px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--fg); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; white-space: nowrap; transition: background .12s, border-color .12s; }
.btn:hover { background: var(--surface-2); color: var(--fg); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }
.btn.ghost:hover { background: var(--surface-2); color: var(--fg); }
.btn.danger { color: var(--bad); }
.btn.danger:hover { background: var(--bad-soft); border-color: var(--bad); }
.btn.sm { min-height: 30px; padding: 4px 10px; font-size: 13px; }
.btn.lg { min-height: 42px; padding: 9px 18px; font-size: 15px; }
.btn.block { width: 100%; }
.icon-btn { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.icon-btn:hover { background: var(--surface-2); color: var(--fg); border-color: var(--line); }
.icon-btn.done { color: var(--ok); }
form.inline { display: inline; margin: 0; }

/* alerts */
.alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--radius); border: 1px solid; background: var(--surface); }
.alert > .icon { margin-top: 2px; width: 18px; height: 18px; }
.alert > div { flex: 1; min-width: 0; }
.alert strong { display: block; font-weight: 600; }
.alert ul { margin: 4px 0 0; padding-left: 18px; color: var(--fg); }
.alert li { overflow-wrap: anywhere; }
.alert p { margin: 2px 0 0; color: var(--fg); }
.alert.ok { border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: var(--ok-soft); color: var(--ok); }
.alert.warn { border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: var(--warn-soft); color: var(--warn); }
.alert.bad { border-color: color-mix(in srgb, var(--bad) 35%, transparent); background: var(--bad-soft); color: var(--bad); }
.alert.info { border-color: color-mix(in srgb, var(--info) 30%, transparent); background: var(--info-soft); color: var(--info); }
.flash { margin-bottom: 20px; }

/* key-value lists */
.kv { display: grid; margin: 0; }
.kv > div { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); gap: 4px 16px; padding: 9px 0; border-top: 1px solid var(--line); }
.kv > div:first-child { border-top: 0; padding-top: 0; }
.kv > div:last-child { padding-bottom: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.kv dd small { display: block; color: var(--muted); }
@media (max-width: 600px) { .kv > div { grid-template-columns: 1fr; } }
.value { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
.value code { flex: 1; min-width: 0; padding: 3px 0; overflow-wrap: anywhere; }
.none { color: var(--muted); }

/* forms */
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
legend { float: left; width: 100%; padding: 0; margin-bottom: 4px; font-weight: 600; font-size: 14px; }
legend + * { clear: both; }
.fieldset + .fieldset { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 20px; }
.fieldset > p { margin: 0 0 14px; color: var(--muted); }
.fields { display: grid; gap: 16px; }
.field label { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; font-weight: 500; }
.field .opt { color: var(--muted); font-weight: 400; font-size: 12px; }
.input, textarea.input, select.input { display: block; width: 100%; min-height: 36px; padding: 7px 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--fg); font: inherit; transition: border-color .12s, box-shadow .12s; }
.input::placeholder { color: color-mix(in srgb, var(--muted) 75%, transparent); }
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.input.mono, textarea.input { font-family: var(--mono); font-size: 12.5px; }
textarea.input { min-height: 96px; resize: vertical; line-height: 1.5; }
select.input { width: auto; padding-right: 28px; }
.input-group { display: flex; gap: 6px; }
.input-group .input { flex: 1; }
.hint { margin: 6px 0 0; color: var(--muted); font-size: 12.5px; }
.error { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0 0; color: var(--bad); font-size: 12.5px; font-weight: 500; }
.error .icon { width: 14px; height: 14px; margin-top: 2px; }
.field.invalid .input { border-color: var(--bad); }
.field.invalid .input:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad) 22%, transparent); }
.switch-row { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.switch-row:hover { background: var(--surface-2); }
.switch-row strong { display: block; font-weight: 500; }
.switch-row .hint { margin-top: 2px; }
input.switch { appearance: none; flex: none; position: relative; width: 34px; height: 20px; margin: 1px 0 0; border-radius: 999px; background: var(--line-strong); cursor: pointer; transition: background .15s; }
input.switch::before { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .25); transition: transform .15s; }
input.switch:checked { background: var(--accent); }
input.switch:checked::before { transform: translateX(14px); }
.switches { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 8px; }

/* tabs */
.tablist { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--line); padding: 0 12px; }
.tablist [role="tab"] { display: inline-flex; align-items: center; gap: 6px; padding: 12px 10px 10px; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none; color: var(--muted); font: inherit; font-weight: 500; cursor: pointer; white-space: nowrap; }
.tablist [role="tab"]:hover { color: var(--fg); }
.tablist [role="tab"][aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
.tablist .count { padding: 0 6px; border-radius: 999px; background: var(--surface-2); font-size: 11.5px; }
.tabs:not(.js) .tablist { display: none; }
.tabs.js .panel-title { display: none; }
.tabs:not(.js) [role="tabpanel"] + [role="tabpanel"] { border-top: 1px solid var(--line); }
.panel-title { margin-bottom: 12px; }
[role="tabpanel"] { padding: 18px 20px 20px; }
[role="tabpanel"][hidden] { display: none; }

/* code */
.code { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.code + .code { margin-top: 12px; }
.code-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 4px 4px 12px; background: var(--surface-2); border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12.5px; font-weight: 500; }
.code pre { margin: 0; padding: 12px; max-height: 420px; overflow: auto; background: var(--surface); white-space: pre-wrap; word-break: break-all; }

/* tables */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 12.5px; background: var(--surface-2); white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td code { overflow-wrap: anywhere; }

/* migration */
.flow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin: 0; padding: 0; list-style: none; counter-reset: flow; }
.flow li { position: relative; padding: 0 12px 0 0; }
.flow li::before { counter-increment: flow; content: counter(flow); display: grid; place-items: center; width: 26px; height: 26px; margin-bottom: 8px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 12.5px; }
.flow li::after { content: ""; position: absolute; top: 13px; left: 34px; right: 8px; height: 1px; background: var(--line-strong); }
.flow li:last-child::after { display: none; }
.flow strong { display: block; }
.flow span { display: block; color: var(--muted); font-size: 12.5px; }
@media (max-width: 700px) { .flow { grid-template-columns: 1fr; gap: 14px; } .flow li::after { display: none; } }
.login-who { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.login-who code { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.spinner { width: 28px; height: 28px; border: 3px solid var(--accent-soft); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }

/* misc */
.empty { display: grid; justify-items: center; gap: 8px; padding: 32px 16px; text-align: center; color: var(--muted); }
.empty .icon { width: 28px; height: 28px; }
.empty strong { color: var(--fg); }
.identity { display: flex; align-items: center; gap: 16px; }
.identity h2 { font-size: 18px; overflow-wrap: anywhere; }
.identity p { margin: 2px 0 0; color: var(--muted); overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.divider { height: 1px; background: var(--line); margin: 16px 0; border: 0; }
details.more > summary { cursor: pointer; color: var(--accent); font-weight: 500; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary::before { content: "+ "; }
details.more[open] > summary::before { content: "− "; }
details.more[open] > summary { margin-bottom: 12px; }
.checklist { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.checklist li { display: grid; grid-template-columns: 200px 1fr; gap: 4px 16px; padding: 10px 0; border-top: 1px solid var(--line); }
.checklist li:first-child { border-top: 0; padding-top: 0; }
.checklist li > span { color: var(--muted); }
@media (max-width: 600px) { .checklist li { grid-template-columns: 1fr; } }

/* admin console */
.topbar .console { display: inline-flex; align-items: center; gap: 8px; margin-right: auto; color: var(--muted); font-size: 13px; font-weight: 500; }
.topbar .console .icon { color: var(--accent); }
@media (max-width: 700px) { .topbar .console { display: none; } }
.sidebar-foot .warn-note { display: flex; gap: 6px; margin-top: 12px; color: var(--warn); }
.sidebar-foot .warn-note .icon { width: 14px; height: 14px; margin-top: 2px; }
.nav a .ext { margin-left: auto; width: 13px; height: 13px; opacity: .6; }
.setup-list { margin: 0; padding: 0; list-style: none; }
.setup-list li { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; gap: 4px 14px; align-items: center; padding: 14px 0; border-top: 1px solid var(--line); }
.setup-list li:first-child { border-top: 0; padding-top: 0; }
.setup-list li:last-child { padding-bottom: 0; }
.setup-list strong { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.setup-list p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
@media (max-width: 600px) { .setup-list li { grid-template-columns: 36px minmax(0, 1fr); } .setup-list li > .btn { grid-column: 2; justify-self: start; } }
`;

// ---------- client script: copy, tabs, confirm, relative times, show secret ----------

export const script = `
(() => {
  document.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); } catch { return; }
      const label = copy.getAttribute('aria-label');
      copy.classList.add('done');
      copy.setAttribute('aria-label', 'Copied');
      setTimeout(() => { copy.classList.remove('done'); copy.setAttribute('aria-label', label); }, 1500);
      return;
    }
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) {
      const input = document.getElementById(reveal.dataset.reveal);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', String(show));
      return;
    }
    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) dismiss.closest('.alert').remove();
  });

  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  for (const tabs of document.querySelectorAll('[data-tabs]')) {
    const list = tabs.querySelectorAll('[role="tab"]');
    const select = (tab, focus) => {
      for (const t of list) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
      if (focus) tab.focus();
    };
    tabs.classList.add('js');
    const fromHash = [...list].find((t) => '#' + t.dataset.hash === location.hash);
    select(fromHash || list[0]);
    if (fromHash) tabs.closest('details')?.setAttribute('open', '');
    if (fromHash) tabs.scrollIntoView({ block: 'start' });
    list.forEach((t, i) => {
      t.addEventListener('click', () => { select(t); history.replaceState(null, '', '#' + t.dataset.hash); });
      t.addEventListener('keydown', (e) => {
        const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
        if (n === undefined) return;
        e.preventDefault();
        select(list[(n + list.length) % list.length], true);
      });
    });
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const relative = () => {
    for (const el of document.querySelectorAll('time[data-relative]')) {
      const s = (new Date(el.dateTime) - Date.now()) / 1000;
      const [unit, size] = units.find(([, size]) => Math.abs(s) >= size) || units.at(-1);
      el.textContent = Math.abs(s) < 10 ? 'just now' : rtf.format(Math.round(s / size), unit);
      el.title = new Date(el.dateTime).toLocaleString();
    }
  };
  relative();
  setInterval(relative, 30000);
})();
`;

// ---------- layout ----------

// The admin console. The customer-facing pages (bank theme) are in bank.js and customer.js.
const NAV = [
  { href: '/admin', label: 'Overview', icon: 'home' },
  { group: 'Sign-in protocols' },
  { href: '/admin/saml', label: 'SAML 2.0', icon: 'shield', section: 'saml' },
  { href: '/admin/oidc', label: 'OpenID Connect', icon: 'globe', section: 'oidc' },
  { group: 'User migration' },
  { href: '/admin/migrate', label: 'Migration setup', icon: 'migrate', section: 'migration' },
  { group: 'App' },
  { href: '/admin/certs', label: 'Certificates', icon: 'key' },
  { href: '/admin/users', label: 'Local profiles', icon: 'users' },
  { group: 'Customer site' },
  { href: '/', label: 'Bank sign-in', icon: 'landmark', customer: true },
  { href: '/legacy', label: 'Legacy sign-in', icon: 'lock', customer: true },
];

export const initials = (name) => String(name || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  .slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export const displayName = (user) => {
  if (user.protocol === 'legacy') return user.name || user.username;
  return user.protocol === 'oidc' ? user.name || user.username || user.email || user.subject : user.nameID;
};

export const protocolBadge = (protocol) => ({
  oidc: '<span class="badge oidc">OIDC</span>',
  legacy: '<span class="badge legacy">Legacy</span>',
}[protocol] ?? '<span class="badge saml">SAML</span>');

function sessionChip(user) {
  if (!user) return '<span class="chip empty">Not signed in</span>';
  const name = displayName(user);
  return `<a class="chip" href="/" title="Signed in as ${esc(name)}">
    <span class="avatar">${esc(initials(name))}</span><span class="name">${esc(name)}</span>${protocolBadge(user.protocol)}</a>`;
}

export function layout({ title, path = '/', user, ready = {}, flash, body }) {
  const nav = NAV.map((item) => {
    if (item.group) return `<div class="nav-label">${item.group}</div>`;
    const current = item.href === path ? ' aria-current="page"' : '';
    const status = item.section && item.section in ready
      ? `<span class="dot ${ready[item.section] ? 'ok' : 'warn'}" title="${ready[item.section] ? 'Set up' : 'Not set up'}"></span>
         <span class="sr-only">${ready[item.section] ? '(set up)' : '(not set up)'}</span>`
      : '';
    const ext = item.customer ? `${icon('external', 'ext')}<span class="sr-only">(customer site)</span>` : '';
    return `<a href="${item.href}"${current}>${icon(item.icon)}${item.label}${status}${ext}</a>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Admin · Test SP</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f46e5"/><text x="16" y="21" font-family="system-ui" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">SP</text></svg>')}">
<style>${css}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="sidebar">
    <a class="brand" href="/admin"><span class="logo">SP</span><span><strong>Admin console</strong><small>Test SP for CloakTail</small></span></a>
    <nav class="nav" aria-label="Admin">${nav}</nav>
    <div class="sidebar-foot">Running at<code>${esc(config.baseUrl)}</code>
      <span class="warn-note">${icon('warn')}<span>No admin sign-in: run on localhost or a trusted network.</span></span></div>
  </aside>
  <div class="content">
    <header class="topbar"><span class="console">${icon('sliders')}Admin console: settings customers never see</span>
      <a class="btn sm" href="/">${icon('landmark')}Customer site</a>${sessionChip(user)}</header>
    <main id="main">
      ${flash ? flashAlert(flash) : ''}
      ${body}
    </main>
  </div>
</div>
<script>${script}</script>
</body>
</html>`;
}

// ---------- components ----------

export function alert(kind, title, notes = [], { dismissible = false, cls = '' } = {}) {
  const role = kind === 'bad' || kind === 'warn' ? 'alert' : 'status';
  const body = notes.length === 1
    ? `<p>${notes[0]}</p>`
    : notes.length ? `<ul>${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : '';
  return `<div class="alert ${kind} ${cls}" role="${role}">${icon(kind === 'info' ? 'info' : kind)}
    <div><strong>${title}</strong>${body}</div>
    ${dismissible ? `<button type="button" class="icon-btn" data-dismiss aria-label="Dismiss">${icon('x')}</button>` : ''}</div>`;
}

export const flashAlert = (flash) => alert(esc(flash.kind), esc(flash.message), (flash.notes ?? []).map(esc), { dismissible: true, cls: 'flash' });

export const pageHead = (title, description, actions = '') => `
  <div class="page-head"><div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div>${actions ? `<div class="row">${actions}</div>` : ''}</div>`;

export function card({ id, step, iconHtml, title, description, body = '', foot = '', bodyClass = 'card-body' }) {
  const lead = step ? `<span class="step" aria-hidden="true">${step}</span>` : iconHtml ?? '';
  const head = title ? `<div class="card-head">${lead}<div><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div></div>` : '';
  return `<section class="card"${id ? ` id="${id}"` : ''}>${head}${body ? `<div class="${bodyClass}">${body}</div>` : ''}${foot ? `<div class="card-foot">${foot}</div>` : ''}</section>`;
}

export const badge = (text, tone = '') => `<span class="badge ${tone}">${text}</span>`;
export const statusBadge = (ok, yes = 'Set up', no = 'Not set up') =>
  `<span class="badge ${ok ? 'ok' : 'warn'}"><span class="dot ${ok ? 'ok' : 'warn'}"></span>${ok ? yes : no}</span>`;

export const none = (text = 'Not set') => `<span class="none">${text}</span>`;
export const code = (v) => (v ? `<code>${esc(v)}</code>` : none());

export const copyButton = (value, label = 'Copy') =>
  `<button type="button" class="icon-btn" data-copy="${esc(value)}" aria-label="${esc(label)}" title="Copy">${icon('copy')}</button>`;

// A technical value with a copy button.
export const copyable = (value, label) => (value
  ? `<span class="value"><code>${esc(value)}</code>${copyButton(value, `Copy ${label ?? ''}`.trim())}</span>`
  : none());

export const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

export const time = (iso, { relative = true } = {}) => (iso
  ? `<time datetime="${esc(iso)}"${relative ? ' data-relative' : ''}>${esc(new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</time>`
  : none());

export function codeBlock(label, content, { copy = true } = {}) {
  return `<div class="code"><div class="code-head"><span>${label}</span>${copy && content ? copyButton(content, `Copy ${label}`) : ''}</div>
    <pre><code>${content ? esc(content) : '<span class="none">Empty</span>'}</code></pre></div>`;
}

export function tabs(id, items) {
  const list = items.filter(Boolean);
  return `<div class="tabs" data-tabs>
    <div class="tablist" role="tablist" aria-label="${esc(id)}">${list.map((t, i) => `<button type="button" role="tab" id="tab-${t.id}" data-hash="${t.id}" aria-controls="panel-${t.id}" aria-selected="${i === 0}"${i ? ' tabindex="-1"' : ''}>${t.label}${t.count != null ? `<span class="count">${t.count}</span>` : ''}</button>`).join('')}</div>
    ${list.map((t) => `<section role="tabpanel" id="panel-${t.id}" aria-labelledby="tab-${t.id}" tabindex="0"><h3 class="panel-title">${t.label}</h3>${t.content}</section>`).join('')}
  </div>`;
}

export const emptyState = (iconName, title, text, action = '') =>
  `<div class="empty">${icon(iconName)}<strong>${title}</strong>${text ? `<span>${text}</span>` : ''}${action}</div>`;

// ---------- form controls ----------

// Settings arrive as booleans, or as raw form input ("on" / absent) when re-showing a rejected form.
export const isOn = (v) => v === true || v === 'on' || v === 'true';

export function field({ name, label, value = '', type = 'text', hint, error, required, optional, placeholder, mono, textarea, list, extra = '', after = '' }) {
  const id = `f-${name}`;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  const attrs = `id="${id}" name="${name}" class="input${mono ? ' mono' : ''}"${required ? ' required' : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${describedBy ? ` aria-describedby="${describedBy}"` : ''}${error ? ' aria-invalid="true"' : ''}${list ? ` list="${list}"` : ''} ${extra}`;
  const control = textarea
    ? `<textarea ${attrs}>${esc(value)}</textarea>`
    : `<input type="${type}" ${attrs} value="${esc(value)}" spellcheck="false" autocomplete="off">`;
  return `<div class="field${error ? ' invalid' : ''}">
    <label for="${id}">${label}${optional ? '<span class="opt">Optional</span>' : ''}</label>
    ${after ? `<div class="input-group">${control}${after}</div>` : control}
    ${hint ? `<p class="hint" id="${id}-hint">${hint}</p>` : ''}
    ${error ? `<p class="error" id="${id}-error">${icon('bad')}<span>${esc(error)}</span></p>` : ''}
  </div>`;
}

export const toggle = (name, label, checked, hint) => `
  <label class="switch-row"><input type="checkbox" class="switch" role="switch" name="${name}"${isOn(checked) ? ' checked' : ''}>
    <span><strong>${label}</strong>${hint ? `<span class="hint">${hint}</span>` : ''}</span></label>`;

export const options = (values, selected, suffix) =>
  values.map((v) => `<option value="${v}"${v === selected ? ' selected' : ''}>${v}${suffix}</option>`).join('');

// ---------- formatting ----------

// Simple indenter for display; Keycloak emits XML on one line.
export function prettyXml(xml) {
  if (!xml) return '';
  let depth = 0;
  return xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(depth - 1, 0);
      const out = '  '.repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth += 1;
      return out;
    })
    .join('\n');
}
