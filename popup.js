const content = document.querySelector('#content');
const summary = document.querySelector('#summary');
const refresh = document.querySelector('#refresh');
const openOptions = document.querySelector('#openOptions');

refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  summary.textContent = 'Checking...';
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
    summary.textContent = 'No sites yet';
    content.innerHTML = `
      <section class="empty">
        <strong>Add a relay site first</strong>
        <span>Open settings, choose Page keyword scan, then keep the dashboard tab open.</span>
      </section>
    `;
    return;
  }

  const okCount = sites.filter((site) => results[site.id]?.ok).length;
  summary.textContent = `${okCount}/${sites.length} OK${lastRunAt ? ` - ${formatTime(lastRunAt)}` : ''}`;

  content.innerHTML = sites.map((site) => {
    const result = results[site.id];
    const status = result?.ok ? 'ok' : 'bad';
    const groups = result?.groups || [];
    return `
      <article class="site-card ${status}">
        <div class="site-head">
          <div>
            <h2>${escapeHtml(site.name || site.origin || 'Unnamed site')}</h2>
            <span>${escapeHtml(result?.transport || site.requestMode || 'scan')} - ${escapeHtml(site.origin || shortUrl(site.checkUrl))}</span>
          </div>
          <button class="small-button" data-site-id="${site.id}">Check</button>
        </div>
        ${result ? renderResult(result, groups) : '<p class="muted">Not checked yet</p>'}
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
      <div class="error">${escapeHtml(result.error || 'Check failed')}</div>
      <p class="muted">HTTP ${escapeHtml(result.status || '-')} - ${escapeHtml(result.latencyMs || 0)}ms</p>
      ${renderScanMeta(result)}
      ${result.preview ? `<details><summary>Response preview</summary><pre>${escapeHtml(result.preview)}</pre></details>` : ''}
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
    <p class="muted">HTTP ${escapeHtml(result.status)} - ${escapeHtml(result.latencyMs)}ms</p>
    ${renderScanMeta(result)}
  `;
}

function renderScanMeta(result) {
  const rows = [];
  if (result.discoveredUrl) {
    rows.push(`<div>Scanned: <span title="${escapeAttr(result.discoveredUrl)}">${escapeHtml(shortUrl(result.discoveredUrl))}</span></div>`);
  }
  if (Array.isArray(result.triedUrls) && result.triedUrls.length) {
    rows.push(`
      <details>
        <summary>Tried ${result.triedUrls.length} discovered page(s)</summary>
        <ul>${result.triedUrls.map((url) => `<li title="${escapeAttr(url)}">${escapeHtml(shortUrl(url))}</li>`).join('')}</ul>
      </details>
    `);
  }
  if (Array.isArray(result.discoverErrors) && result.discoverErrors.length) {
    rows.push(`
      <details>
        <summary>Discovery errors</summary>
        <ul>${result.discoverErrors.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </details>
    `);
  }
  return rows.length ? `<div class="scan-meta">${rows.join('')}</div>` : '';
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

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

render();
