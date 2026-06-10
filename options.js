const editor = document.querySelector('#siteEditor');
const addSite = document.querySelector('#addSite');
const save = document.querySelector('#save');
const run = document.querySelector('#run');
const statusText = document.querySelector('#status');

let sites = [];

addSite.addEventListener('click', () => {
  sites.push(createSite());
  render();
});

save.addEventListener('click', async () => {
  await saveSites();
  showStatus('Saved');
});

run.addEventListener('click', async () => {
  await saveSites();
  showStatus('Checking...');
  const response = await chrome.runtime.sendMessage({ type: 'RUN_CHECKS' });
  showStatus(response?.ok ? 'Check finished' : `Check failed: ${response?.error || 'unknown error'}`);
});

async function load() {
  const stored = await chrome.storage.local.get({ sites: [] });
  sites = Array.isArray(stored.sites) ? stored.sites : [];
  render();
}

function render() {
  if (!sites.length) {
    editor.innerHTML = '<div class="empty wide">No sites yet. Click Add site.</div>';
    return;
  }

  editor.innerHTML = sites.map((site, index) => `
    <article class="editor-card" data-index="${index}">
      <div class="editor-head">
        <strong>${escapeHtml(site.name || `Site ${index + 1}`)}</strong>
        <label class="toggle"><input type="checkbox" data-field="enabled" ${site.enabled ? 'checked' : ''}>Enabled</label>
        <button class="danger-button" data-action="delete">Delete</button>
      </div>

      <label>Name<input data-field="name" value="${escapeAttr(site.name)}" placeholder="vip.lcodex"></label>
      <label>Login origin<input data-field="origin" value="${escapeAttr(site.origin)}" placeholder="https://vip.lcodex.cn"></label>
      <label>Dashboard / key page URL<input data-field="scanUrl" value="${escapeAttr(site.scanUrl)}" placeholder="URL of the page that shows key groups/rates after login"></label>
      <label>Check URL<input data-field="checkUrl" value="${escapeAttr(site.checkUrl)}" placeholder="Optional in keyword scan mode"></label>

      <div class="grid-3">
        <label>Request mode
          <select data-field="requestMode">
            <option value="scan" ${site.requestMode === 'scan' || !site.requestMode ? 'selected' : ''}>Page keyword scan</option>
            <option value="page" ${site.requestMode === 'page' ? 'selected' : ''}>Logged-in tab API</option>
            <option value="background" ${site.requestMode === 'background' ? 'selected' : ''}>Extension background</option>
          </select>
        </label>
        <label>Method
          <select data-field="method">
            <option value="GET" ${site.method === 'GET' ? 'selected' : ''}>GET</option>
            <option value="POST" ${site.method === 'POST' ? 'selected' : ''}>POST</option>
          </select>
        </label>
        <label>Parser
          <select data-field="parserType">
            <option value="json" ${site.parserType !== 'regex' ? 'selected' : ''}>JSON</option>
            <option value="regex" ${site.parserType === 'regex' ? 'selected' : ''}>Text regex</option>
          </select>
        </label>
      </div>

      <div class="grid-2">
        <label class="toggle field-toggle"><input type="checkbox" data-field="autoDiscoverKeyPage" ${site.autoDiscoverKeyPage !== false ? 'checked' : ''}>Auto discover key page</label>
        <label>Max discover pages<input data-field="maxDiscoverPages" value="${escapeAttr(site.maxDiscoverPages || '5')}" placeholder="5"></label>
      </div>

      <label>POST body<textarea data-field="body" rows="3" placeholder='{"page":1}'>${escapeHtml(site.body)}</textarea></label>

      <div class="grid-3">
        <label>JSON list path<input data-field="jsonListPath" value="${escapeAttr(site.jsonListPath)}" placeholder="data.groups or leave blank for auto"></label>
        <label>Group field<input data-field="jsonGroupPath" value="${escapeAttr(site.jsonGroupPath)}" placeholder="name"></label>
        <label>Rate field<input data-field="jsonRatePath" value="${escapeAttr(site.jsonRatePath)}" placeholder="rate"></label>
      </div>

      <div class="grid-3">
        <label>Token source
          <select data-field="tokenSource">
            <option value="none" ${site.tokenSource === 'none' ? 'selected' : ''}>None / cookie only</option>
            <option value="localStorage" ${site.tokenSource === 'localStorage' ? 'selected' : ''}>localStorage</option>
            <option value="sessionStorage" ${site.tokenSource === 'sessionStorage' ? 'selected' : ''}>sessionStorage</option>
          </select>
        </label>
        <label>Token key<input data-field="tokenKey" value="${escapeAttr(site.tokenKey)}" placeholder="token"></label>
        <label>Token JSON path<input data-field="tokenJsonPath" value="${escapeAttr(site.tokenJsonPath)}" placeholder="access_token"></label>
      </div>

      <div class="grid-2">
        <label>Auth header<input data-field="authHeaderName" value="${escapeAttr(site.authHeaderName)}" placeholder="Authorization"></label>
        <label>Auth template<input data-field="authHeaderTemplate" value="${escapeAttr(site.authHeaderTemplate)}" placeholder="Bearer {{token}}"></label>
      </div>

      <label>Text regex<input data-field="regex" value="${escapeAttr(site.regex)}" placeholder="([^\\n]+?)\\s*(?:rate|ratio|multiplier)\\s*[:=]\\s*([0-9.]+)"></label>
      <label>Max scan results<input data-field="maxScanResults" value="${escapeAttr(site.maxScanResults)}" placeholder="50"></label>
    </article>
  `).join('');

  for (const card of editor.querySelectorAll('.editor-card')) {
    const index = Number(card.dataset.index);
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      sites.splice(index, 1);
      render();
    });

    for (const input of card.querySelectorAll('[data-field]')) {
      input.addEventListener('input', () => updateSite(index, input));
      input.addEventListener('change', () => updateSite(index, input));
    }
  }
}

function updateSite(index, input) {
  const field = input.dataset.field;
  if (input.type === 'checkbox') {
    sites[index][field] = input.checked;
  } else {
    sites[index][field] = input.value;
  }
}

async function saveSites() {
  sites = sites.map((site) => ({
    ...site,
    id: site.id || crypto.randomUUID(),
    enabled: Boolean(site.enabled),
    requestMode: site.requestMode || 'scan',
    method: site.method || 'GET',
    parserType: site.parserType || 'json',
    autoDiscoverKeyPage: site.autoDiscoverKeyPage !== false,
    maxDiscoverPages: site.maxDiscoverPages || '5',
    maxScanResults: site.maxScanResults || '50',
    tokenSource: site.tokenSource || 'none',
    authHeaderName: site.authHeaderName || 'Authorization',
    authHeaderTemplate: site.authHeaderTemplate || 'Bearer {{token}}'
  }));
  await chrome.storage.local.set({ sites });
}

function createSite() {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    name: 'vip.lcodex',
    origin: 'https://vip.lcodex.cn',
    scanUrl: '',
    checkUrl: '',
    requestMode: 'scan',
    method: 'GET',
    body: '',
    parserType: 'json',
    jsonListPath: '',
    jsonGroupPath: '',
    jsonRatePath: '',
    jsonKeyPath: '',
    regex: '',
    tokenSource: 'none',
    tokenKey: '',
    tokenJsonPath: '',
    authHeaderName: 'Authorization',
    authHeaderTemplate: 'Bearer {{token}}',
    autoDiscoverKeyPage: true,
    maxDiscoverPages: '5',
    maxScanResults: '50'
  };
}

function showStatus(message) {
  statusText.textContent = message;
  setTimeout(() => {
    if (statusText.textContent === message) {
      statusText.textContent = '';
    }
  }, 3000);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

load();
