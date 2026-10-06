// The customer's documents page, in the Acme Bank theme: upload files and list the ones uploaded.
// Two upload buttons, one per method, to compare them (see files.js):
//   proxied    the script POSTs the file to /documents/proxied, which streams it on to S3
//   presigned  the script asks /documents/presigned for URLs and PUTs the file to S3 itself:
//              one PUT for a small file, parts in parallel for a large one
// Every upload shows its time and throughput; every file, the method it came by.
import { formatBytes } from '../factory/s3/index.js';
import { bankLayout, BANK } from './bank.js';
import { esc, icon, alert, card, emptyState, time, badge } from './ui.js';

const METHODS = {
  proxied: {
    label: 'Through the app',
    button: 'Upload through the app',
    tag: 'Proxied',
    description: 'Browser → app → S3. The app streams each file on to S3 as it arrives.',
  },
  presigned: {
    label: 'Direct to S3',
    button: 'Upload direct to S3',
    tag: 'Presigned',
    description: 'Browser → S3 with presigned URLs. The app only signs and checks. Needs the bucket\'s CORS (npm run s3:setup).',
  },
};

const documentsCss = `
.methods { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.drop { position: relative; display: grid; justify-items: center; align-content: start; gap: 10px; padding: 22px 16px; border: 2px dashed var(--line-strong); border-radius: 14px; background: var(--surface-2); text-align: center; transition: border-color .15s, background .15s; }
.drop.over { border-color: var(--accent); background: var(--accent-soft); }
.drop h3 { margin: 0; font-size: 15px; }
.drop p { margin: 0; color: var(--muted); font-size: 13px; }
.drop input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; }
.drop input[type=file]:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 2px; }
.drop input[type=file]:disabled + label { opacity: .6; pointer-events: none; }
.uploads { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.uploads:empty { display: none; }
.uploads li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; }
.uploads .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.uploads .status { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; text-align: right; }
.uploads progress { grid-column: 1 / -1; width: 100%; height: 6px; }
.uploads li.failed { border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.uploads li.failed .status { color: var(--bad); }
.uploads li.done .status { color: var(--ok); }
.file-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.file-name span { overflow-wrap: anywhere; }
.file-name .icon { flex: none; color: var(--muted); }
.file-actions { display: flex; justify-content: flex-end; gap: 6px; white-space: nowrap; }
`;

// Runs in the browser. Each method uploads one file and reports progress in bytes.
const uploadScript = `
(() => {
  const form = document.getElementById('upload-form');
  if (!form) return;
  const list = document.getElementById('upload-list');
  const maxBytes = Number(form.dataset.maxBytes);
  const TAGS = JSON.parse(form.dataset.tags);
  const PARALLEL_PARTS = 4;
  const PART_RETRIES = 3;
  let active = 0;

  // Sends body with XMLHttpRequest, for upload progress. Resolves with the response.
  function send(method, url, body, headers, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      for (const [name, value] of Object.entries(headers || {})) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => resolve(xhr);
      xhr.onerror = () => reject(new Error('The connection failed.'));
      xhr.send(body);
    });
  }

  const errorOf = (xhr, fallback) => {
    try { return JSON.parse(xhr.responseText).error || fallback; } catch { return fallback; }
  };

  // ---------- proxied: one POST of the raw file to the app ----------

  async function proxied(file, onProgress, onNote) {
    const xhr = await send('POST', '/documents/proxied', file, {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-File-Type': file.type,
    }, (b) => { onProgress(b); if (b === file.size) onNote('Saving to S3…'); });
    if (xhr.status !== 201) throw new Error(errorOf(xhr, 'The upload failed (' + xhr.status + ').'));
  }

  // ---------- presigned: JSON calls to the app, bytes PUT to S3 ----------

  async function api(path, body) {
    const res = await fetch('/documents/presigned' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The server refused the request (' + res.status + ').');
    return data;
  }

  // PUTs a blob to a presigned URL. Resolves with the ETag S3 returns.
  async function put(target, blob, onProgress) {
    const xhr = await send('PUT', target.url, blob, target.headers, onProgress);
    if (xhr.status < 200 || xhr.status >= 300) throw new Error('S3 refused the file (' + xhr.status + ').');
    return xhr.getResponseHeader('ETag');
  }

  async function withRetries(attempt) {
    for (let i = 1; ; i++) {
      try { return await attempt(); } catch (err) {
        if (i >= PART_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  }

  // Parts go up PARALLEL_PARTS at a time; their URLs are asked for in batches, as needed.
  async function uploadParts(file, plan, onProgress) {
    const loaded = new Array(plan.partCount).fill(0);
    const report = () => onProgress(loaded.reduce((a, b) => a + b, 0));
    const batches = new Map();
    const urlFor = (n) => {
      const batch = Math.floor((n - 1) / plan.maxPartsPerRequest);
      if (!batches.has(batch)) {
        const first = batch * plan.maxPartsPerRequest + 1;
        const partNumbers = [];
        for (let p = first; p < first + plan.maxPartsPerRequest && p <= plan.partCount; p++) partNumbers.push(p);
        batches.set(batch, api('/' + plan.id + '/parts', { partNumbers }).then((r) => new Map(r.parts.map((p) => [p.partNumber, p]))));
      }
      return batches.get(batch).then((parts) => parts.get(n));
    };
    const done = [];
    let next = 1;
    let failed = false;
    async function worker() {
      while (!failed && next <= plan.partCount) {
        const n = next++;
        const start = (n - 1) * plan.partSize;
        const blob = file.slice(start, Math.min(start + plan.partSize, file.size));
        try {
          const part = await urlFor(n);
          const etag = await withRetries(() => put(part, blob, (b) => { loaded[n - 1] = b; report(); }));
          if (!etag) throw new Error('S3 did not return the ETag header: its CORS rule must expose it (npm run s3:setup).');
          done.push({ partNumber: n, etag });
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, plan.partCount) }, worker));
    return done;
  }

  async function presigned(file, onProgress, onNote) {
    const plan = await api('', { filename: file.name, contentType: file.type, size: file.size });
    try {
      const parts = plan.mode === 'single'
        ? (await put(plan, file, onProgress), undefined)
        : await uploadParts(file, plan, onProgress);
      onNote('Checking…');
      await api('/' + plan.id + '/complete', { parts });
    } catch (err) {
      api('/' + plan.id + '/abort').catch(() => {});
      // A PUT blocked by CORS fails without a status: say what usually causes it.
      throw err.message === 'The connection failed.' ? new Error('Could not reach S3: check the bucket\\'s CORS (npm run s3:setup).') : err;
    }
  }

  const METHODS = { proxied, presigned };

  // ---------- progress rows ----------

  const seconds = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  const rate = (bytes, ms) => (ms ? (bytes / 1048576 / (ms / 1000)).toFixed(1) : '–') + ' MB/s';

  function row(file, method) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="badge outline"></span><span class="name"></span><span class="status">Starting</span><progress max="1" value="0"></progress>';
    li.querySelector('.badge').textContent = TAGS[method];
    li.querySelector('.name').textContent = file.name;
    list.append(li);
    const status = li.querySelector('.status');
    const bar = li.querySelector('progress');
    return {
      progress(bytes) { const f = file.size ? bytes / file.size : 1; bar.value = f; status.textContent = Math.floor(f * 100) + '%'; },
      note(text) { status.textContent = text; },
      finish(text, kind) { li.className = kind; status.textContent = text; if (kind === 'done') bar.value = 1; else bar.remove(); },
    };
  }

  async function upload(file, method) {
    const r = row(file, method);
    if (file.size > maxBytes) {
      r.finish('Too large for the limit', 'failed');
      return false;
    }
    const started = performance.now();
    try {
      await METHODS[method](file, r.progress, r.note);
      const ms = performance.now() - started;
      r.finish('Uploaded in ' + seconds(ms) + ' · ' + rate(file.size, ms), 'done');
      return true;
    } catch (err) {
      r.finish(err.message, 'failed');
      return false;
    }
  }

  async function uploadAll(fileList, method, input) {
    const chosen = [...fileList];
    if (!chosen.length) return;
    active += chosen.length;
    input.disabled = true;
    const results = await Promise.all(chosen.map((f) => upload(f, method)));
    active -= chosen.length;
    input.value = '';
    input.disabled = false;
    if (!active && results.some(Boolean)) document.getElementById('reload').hidden = false;
  }

  for (const drop of form.querySelectorAll('.drop')) {
    const { method } = drop.dataset;
    const input = drop.querySelector('input[type=file]');
    input.addEventListener('change', () => uploadAll(input.files, method, input));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (!input.disabled) uploadAll(e.dataTransfer.files, method, input); });
  }
  addEventListener('beforeunload', (e) => { if (active) e.preventDefault(); });
})();
`;

function limitsText({ maxBytes, allowedTypes }) {
  return `Up to ${formatBytes(maxBytes)} per file${allowedTypes.length ? `: ${allowedTypes.map(esc).join(', ')}` : ', any type'}.`;
}

const methodPanel = (key) => {
  const m = METHODS[key];
  return `<div class="drop" data-method="${key}">
    <h3>${m.label} <span class="badge outline">${m.tag}</span></h3>
    <p>${esc(m.description)}</p>
    <input id="f-${key}" type="file" multiple>
    <label for="f-${key}" class="btn primary">${icon('upload')}${m.button}</label>
    <p>or drop files here</p>
  </div>`;
};

function uploadCard(uploads) {
  if (!uploads.enabled) {
    return card({
      iconHtml: `<span class="proto-icon accent">${icon('upload')}</span>`,
      title: 'Upload documents',
      body: `${alert('warn', 'Document uploads aren\'t available yet', ['Please try again later.'])}
        <details class="more small"><summary>Why? (for administrators)</summary>
          <p>Set <code>AWS_S3_BUCKET</code> and <code>AWS_REGION</code>, and AWS credentials, then restart. See the README.</p></details>`,
    });
  }
  const tags = Object.fromEntries(Object.entries(METHODS).map(([k, m]) => [k, m.tag]));
  return card({
    iconHtml: `<span class="proto-icon accent">${icon('upload')}</span>`,
    title: 'Upload documents',
    description: `Two ways to upload, to compare them. ${limitsText(uploads)}`,
    body: `<form id="upload-form" class="stack" onsubmit="return false" data-max-bytes="${uploads.maxBytes}" data-tags="${esc(JSON.stringify(tags))}">
        <div class="methods">${Object.keys(METHODS).map(methodPanel).join('')}</div>
        <ul class="uploads" id="upload-list" aria-live="polite"></ul>
        <p id="reload" hidden><a class="btn" href="/documents">${icon('refresh')}Show the new files below</a></p>
      </form>`,
  });
}

function filesCard(files) {
  const table = files.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Size</th><th>Method</th><th>Uploaded</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${files.map((f) => `<tr>
          <td><div class="file-name">${icon('file')}<span>${esc(f.name)}</span></div><span class="small muted">${esc(f.contentType)}</span></td>
          <td>${esc(formatBytes(f.size))}</td>
          <td>${badge(esc(METHODS[f.method]?.tag ?? f.method ?? ''), 'outline')}</td>
          <td>${time(f.uploadedAt)}</td>
          <td><div class="file-actions">
            <a class="btn sm" href="/documents/${esc(f.id)}/download">${icon('download')}Download</a>
            <form class="inline" method="post" action="/documents/${esc(f.id)}/delete" data-confirm="Delete ${esc(f.name)}? This can't be undone.">
              <button class="btn sm danger" aria-label="Delete ${esc(f.name)}">${icon('trash')}</button></form>
          </div></td></tr>`).join('')}</tbody></table></div>`
    : emptyState('file', 'No documents yet', 'Files you upload appear here.');
  return card({
    iconHtml: `<span class="proto-icon accent">${icon('file')}</span>`,
    title: 'Your documents',
    description: files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '',
    body: table,
    bodyClass: files.length ? '' : 'card-body',
  });
}

export function documentsPage(data) {
  const { files, uploads } = data;
  return bankLayout({
    ...data,
    title: 'Documents',
    head: `<style>${documentsCss}</style>`,
    body: `<div class="stack-lg">
      <a class="back-link" href="/">${icon('back')}Your accounts</a>
      <div class="greeting"><div>
        <h1 class="display">Documents</h1>
        <p>Share documents with ${BANK} securely. Only you can see them here.</p></div>
        ${uploads.enabled ? '' : badge('Uploads off', 'warn')}</div>
      ${uploadCard(uploads)}
      ${filesCard(files)}
    </div>
    ${uploads.enabled ? `<script>${uploadScript}</script>` : ''}`,
  });
}
