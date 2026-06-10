const content = document.querySelector('#content');
const summary = document.querySelector('#summary');
const refresh = document.querySelector('#refresh');
const openOptions = document.querySelector('#openOptions');

refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  summary.textContent = '正在检测...';
  await chrome.runtime.sendMessage({ type: 'RUN_CHECKS' });
  await render();
  refresh.disabled = false;
});

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function render() {
  const { sites, results, lastRunAt } = await chrome.storage.local.get({
    sites: [],
    results: {},
    lastRunAt: null
  });

  if (!sites.length) {
    summary.textContent = '还没有站点';
    content.innerHTML = `
      <section class="empty">
        <strong>先添加一个中转站</strong>
        <span>在设置页填后台接口或页面地址，再配置倍率解析规则。</span>
      </section>
    `;
    return;
  }

  const okCount = sites.filter((site) => results[site.id]?.ok).length;
  summary.textContent = `${okCount}/${sites.length} 正常${lastRunAt ? ` · ${formatTime(lastRunAt)}` : ''}`;

  content.innerHTML = sites.map((site) => {
    const result = results[site.id];
    const status = result?.ok ? 'ok' : 'bad';
    const groups = result?.groups || [];
    return `
      <article class="site-card ${status}">
        <div class="site-head">
          <div>
            <h2>${escapeHtml(site.name || site.origin || '未命名站点')}</h2>
            <span>${escapeHtml(site.origin || shortUrl(site.checkUrl))}</span>
          </div>
          <button class="small-button" data-site-id="${site.id}">检测</button>
        </div>
        ${result ? renderResult(result, groups) : '<p class="muted">还未检测</p>'}
      </article>
    `;
  }).join('');

  for (const button of content.querySelectorAll('[data-site-id]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      await chrome.runtime.sendMessage({ type: 'RUN_SITE_CHECK', siteId: button.dataset.siteId });
      await render();
    });
  }
}

function renderResult(result, groups) {
  if (!result.ok) {
    return `
      <div class="error">${escapeHtml(result.error || '检测失败')}</div>
      <p class="muted">HTTP ${escapeHtml(result.status || '-')} · ${escapeHtml(result.latencyMs || 0)}ms</p>
    `;
  }

  return `
    <div class="group-list">
      ${groups.map((item) => `
        <div class="group-row">
          <span>${escapeHtml(item.group)}</span>
          <strong>${item.rate == null ? '-' : `${item.rate}x`}</strong>
        </div>
      `).join('')}
    </div>
    <p class="muted">HTTP ${escapeHtml(result.status)} · ${escapeHtml(result.latencyMs)}ms</p>
  `;
}

function shortUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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

render();
