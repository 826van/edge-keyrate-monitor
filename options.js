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
  showStatus('已保存');
});

run.addEventListener('click', async () => {
  await saveSites();
  showStatus('正在检测...');
  const response = await chrome.runtime.sendMessage({ type: 'RUN_CHECKS' });
  showStatus(response?.ok ? '检测完成' : `检测失败：${response?.error || '未知错误'}`);
});

async function load() {
  const stored = await chrome.storage.local.get({ sites: [] });
  sites = Array.isArray(stored.sites) ? stored.sites : [];
  render();
}

function render() {
  if (!sites.length) {
    editor.innerHTML = '<div class="empty wide">还没有站点，点右上角添加。</div>';
    return;
  }

  editor.innerHTML = sites.map((site, index) => `
    <article class="editor-card" data-index="${index}">
      <div class="editor-head">
        <strong>${escapeHtml(site.name || `站点 ${index + 1}`)}</strong>
        <label class="toggle"><input type="checkbox" data-field="enabled" ${site.enabled ? 'checked' : ''}>启用</label>
        <button class="danger-button" data-action="delete">删除</button>
      </div>

      <label>名称<input data-field="name" value="${escapeAttr(site.name)}" placeholder="例如 钧澈"></label>
      <label>检测地址<input data-field="checkUrl" value="${escapeAttr(site.checkUrl)}" placeholder="https://example.com/api/..."></label>
      <label>站点首页<input data-field="origin" value="${escapeAttr(site.origin)}" placeholder="https://example.com"></label>

      <div class="grid-2">
        <label>请求方法
          <select data-field="method">
            <option value="GET" ${site.method === 'GET' ? 'selected' : ''}>GET</option>
            <option value="POST" ${site.method === 'POST' ? 'selected' : ''}>POST</option>
          </select>
        </label>
        <label>解析方式
          <select data-field="parserType">
            <option value="json" ${site.parserType === 'json' ? 'selected' : ''}>JSON</option>
            <option value="regex" ${site.parserType === 'regex' ? 'selected' : ''}>网页/文本正则</option>
          </select>
        </label>
      </div>

      <label>POST Body<textarea data-field="body" rows="3" placeholder='{"page":1}'>${escapeHtml(site.body)}</textarea></label>

      <div class="grid-3">
        <label>JSON 列表路径<input data-field="jsonListPath" value="${escapeAttr(site.jsonListPath)}" placeholder="data.groups"></label>
        <label>分组字段<input data-field="jsonGroupPath" value="${escapeAttr(site.jsonGroupPath)}" placeholder="name"></label>
        <label>倍率字段<input data-field="jsonRatePath" value="${escapeAttr(site.jsonRatePath)}" placeholder="rate"></label>
      </div>

      <label>文本正则<input data-field="regex" value="${escapeAttr(site.regex)}" placeholder="([^\\n]+?)\\s*倍率[:：=]\\s*([0-9.]+)"></label>
    </article>
  `).join('');

  for (const card of editor.querySelectorAll('.editor-card')) {
    const index = Number(card.dataset.index);
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      sites.splice(index, 1);
      render();
    });

    for (const input of card.querySelectorAll('[data-field]')) {
      input.addEventListener('input', () => {
        updateSite(index, input);
      });
      input.addEventListener('change', () => {
        updateSite(index, input);
      });
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
  const normalized = sites.map((site) => ({
    ...site,
    id: site.id || crypto.randomUUID(),
    enabled: Boolean(site.enabled),
    method: site.method || 'GET',
    parserType: site.parserType || 'json'
  }));
  sites = normalized;
  await chrome.storage.local.set({ sites });
}

function createSite() {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    name: '',
    origin: '',
    checkUrl: '',
    method: 'GET',
    body: '',
    parserType: 'json',
    jsonListPath: 'data',
    jsonGroupPath: 'group',
    jsonRatePath: 'rate',
    jsonKeyPath: '',
    regex: ''
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
