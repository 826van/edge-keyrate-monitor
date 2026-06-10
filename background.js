const DEFAULT_STATE = {
  sites: [],
  results: {},
  lastRunAt: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  await chrome.storage.local.set({
    sites: Array.isArray(stored.sites) ? stored.sites : [],
    results: stored.results && typeof stored.results === 'object' ? stored.results : {},
    lastRunAt: stored.lastRunAt || null
  });
  chrome.alarms.create('rate-check', { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('rate-check', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rate-check') {
    runAllChecks();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  if (message.type === 'RUN_CHECKS') {
    runAllChecks()
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (message.type === 'RUN_SITE_CHECK') {
    runOneSite(message.siteId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  return false;
});

async function runAllChecks() {
  const { sites, results } = await chrome.storage.local.get({ sites: [], results: {} });
  const nextResults = { ...results };

  for (const site of sites) {
    if (!site.enabled) {
      continue;
    }
    nextResults[site.id] = await checkSite(site);
  }

  const lastRunAt = new Date().toISOString();
  await chrome.storage.local.set({ results: nextResults, lastRunAt });
  await updateBadge(nextResults);
  return nextResults;
}

async function runOneSite(siteId) {
  const { sites, results } = await chrome.storage.local.get({ sites: [], results: {} });
  const site = sites.find((item) => item.id === siteId);
  if (!site) {
    throw new Error('Site not found.');
  }

  const result = await checkSite(site);
  const nextResults = { ...results, [site.id]: result };
  await chrome.storage.local.set({ results: nextResults, lastRunAt: new Date().toISOString() });
  await updateBadge(nextResults);
  return result;
}

async function checkSite(site) {
  const startedAt = Date.now();

  try {
    validateSite(site);
    const transport = site.requestMode || 'scan';
    const responseData = transport === 'background'
      ? await fetchFromBackground(site)
      : transport === 'page'
        ? await fetchFromLoggedInTab(site)
        : await scanFromLoggedInTab(site);

    const groups = responseData.groups || extractGroups({
      site,
      text: responseData.text || '',
      parsed: safeJson(responseData.text || '')
    });

    return {
      ok: responseData.ok && groups.length > 0,
      transport: responseData.transport,
      status: responseData.status,
      statusText: responseData.statusText,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      groups,
      error: responseData.ok ? null : `HTTP ${responseData.status} ${responseData.statusText}`,
      preview: makePreview(responseData.text || responseData.preview || '')
    };
  } catch (error) {
    return {
      ok: false,
      transport: site.requestMode || 'page',
      status: null,
      statusText: '',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      groups: [],
      error: String(error.message || error),
      preview: ''
    };
  }
}

async function fetchFromBackground(site) {
  const headers = buildHeaders(site, '');
  const response = await fetch(site.checkUrl, {
    method: site.method || 'GET',
    credentials: 'include',
    headers,
    body: buildBody(site)
  });
  return {
    transport: 'background',
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type') || '',
    text: await response.text()
  };
}

async function fetchFromLoggedInTab(site) {
  const tab = await findLoggedInTab(site);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pageFetch,
    args: [toPagePayload(site)]
  });

  const result = execution && execution.result;
  if (!result) {
    throw new Error('No result returned from logged-in tab.');
  }
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
}

async function scanFromLoggedInTab(site) {
  const tab = await findLoggedInTab(site);
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pageScan,
    args: [toScanPayload(site)]
  });

  const result = execution && execution.result;
  if (!result) {
    throw new Error('No scan result returned from logged-in tab.');
  }
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
}

async function findLoggedInTab(site) {
  const targetUrl = getTargetPageUrl(site);
  const targetOrigin = new URL(targetUrl).origin;
  const targetPath = new URL(targetUrl).pathname;
  const tabs = await chrome.tabs.query({});
  const exactMatch = tabs.find((tab) => {
    try {
      const url = new URL(tab.url);
      return tab.id && url.origin === targetOrigin && url.pathname === targetPath;
    } catch {
      return false;
    }
  });

  if (exactMatch) {
    return exactMatch;
  }

  const originMatch = tabs.find((tab) => {
    try {
      return tab.id && tab.url && new URL(tab.url).origin === targetOrigin;
    } catch {
      return false;
    }
  });

  if (originMatch && !site.scanUrl) {
    return originMatch;
  }

  await chrome.tabs.create({ url: targetUrl, active: false });
  throw new Error(`Opened ${targetUrl}. Log in and navigate to the key page, then run the check again.`);
}

function pageFetch(site) {
  const startedAt = Date.now();

  function readPath(value, path) {
    if (!path) {
      return value;
    }
    return path.split('.').reduce((current, key) => {
      if (current == null) {
        return undefined;
      }
      if (Array.isArray(current) && /^\\d+$/.test(key)) {
        return current[Number(key)];
      }
      return current[key];
    }, value);
  }

  function readStorageToken() {
    if (!site.tokenSource || site.tokenSource === 'none' || !site.tokenKey) {
      return '';
    }
    const storage = site.tokenSource === 'sessionStorage' ? window.sessionStorage : window.localStorage;
    let value = storage.getItem(site.tokenKey) || '';
    if (site.tokenJsonPath && value) {
      try {
        value = readPath(JSON.parse(value), site.tokenJsonPath) || '';
      } catch {
        return '';
      }
    }
    return String(value || '');
  }

  function makeHeaders(token) {
    const headers = {};
    if (site.acceptJson) {
      headers.Accept = 'application/json';
    }
    if (site.method === 'POST') {
      headers['Content-Type'] = site.contentType || 'application/json';
    }
    for (const pair of site.headers || []) {
      if (pair.name && pair.value) {
        headers[pair.name] = pair.value;
      }
    }
    if (token && site.authHeaderName) {
      const template = site.authHeaderTemplate || 'Bearer {{token}}';
      headers[site.authHeaderName] = template.replaceAll('{{token}}', token);
    }
    return headers;
  }

  async function run() {
    const token = readStorageToken();
    const response = await fetch(site.checkUrl, {
      method: site.method || 'GET',
      credentials: 'include',
      headers: makeHeaders(token),
      body: (site.method || 'GET') === 'GET' ? undefined : (site.body || '')
    });
    return {
      transport: 'page',
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') || '',
      text: await response.text(),
      latencyMs: Date.now() - startedAt
    };
  }

  return run().catch((error) => ({
    error: String(error.message || error),
    transport: 'page',
    latencyMs: Date.now() - startedAt
  }));
}

function pageScan(site) {
  const startedAt = Date.now();

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function pushCandidate(candidates, group, rate, source, confidence) {
    const normalizedRate = normalizeRateLocal(rate);
    const normalizedGroup = normalizeText(group)
      .replace(/^(group|rate|ratio|multiplier|倍率|分组|名称|令牌|密钥)\s*[:：=-]?\s*/i, '')
      .replace(/\s*(rate|ratio|multiplier|倍率)\s*[:：=-]?\s*[0-9.]+x?\s*$/i, '')
      .trim();

    if (normalizedRate == null) {
      return;
    }
    candidates.push({
      group: normalizedGroup || `Group ${candidates.length + 1}`,
      rate: normalizedRate,
      keyHint: '',
      rawRate: String(rate),
      source,
      confidence
    });
  }

  function normalizeRateLocal(value) {
    if (value == null) {
      return null;
    }
    const match = String(value).match(/([0-9]+(?:\.[0-9]+)?)/);
    return match ? Number(match[1]) : null;
  }

  function scanTextBlock(text, source, candidates) {
    const clean = normalizeText(text);
    if (!clean || clean.length > 2000) {
      return;
    }

    const patterns = [
      /([^,，;；|｜\n\r]{1,80}?)\s*(?:倍率|费率|rate|ratio|multiplier)\s*[:：=]?\s*([0-9]+(?:\.[0-9]+)?)\s*x?/ig,
      /(?:倍率|费率|rate|ratio|multiplier)\s*[:：=]?\s*([0-9]+(?:\.[0-9]+)?)\s*x?\s*([^,，;；|｜\n\r]{1,80})?/ig,
      /([^,，;；|｜\n\r]{1,80}?)\s+([0-9]+(?:\.[0-9]+)?)\s*x\b/ig
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(clean)) !== null) {
        if (pattern === patterns[1]) {
          pushCandidate(candidates, match[2] || source, match[1], source, 0.65);
        } else {
          pushCandidate(candidates, match[1], match[2], source, pattern === patterns[2] ? 0.45 : 0.75);
        }
      }
    }
  }

  function scanTables(candidates) {
    for (const table of document.querySelectorAll('table')) {
      const headers = Array.from(table.querySelectorAll('thead th, thead td')).map((cell) => normalizeText(cell.innerText).toLowerCase());
      const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th')).map((cell) => normalizeText(cell.innerText));
        if (cells.length < 2) {
          continue;
        }
        const lower = cells.map((cell) => cell.toLowerCase());
        let rateIndex = headers.findIndex((header) => /rate|ratio|multiplier|倍率|费率/.test(header));
        let groupIndex = headers.findIndex((header) => /group|name|分组|名称|令牌|密钥|key/.test(header));

        if (rateIndex < 0) {
          rateIndex = lower.findIndex((cell) => /(?:rate|ratio|multiplier|倍率|费率)\s*[:：=]?\s*[0-9.]+|[0-9.]+\s*x\b/i.test(cell));
        }
        if (groupIndex < 0) {
          groupIndex = lower.findIndex((cell, index) => index !== rateIndex && cell && !/^[0-9.]+\s*x?$/.test(cell));
        }
        if (rateIndex >= 0) {
          pushCandidate(candidates, cells[groupIndex] || `Row ${candidates.length + 1}`, cells[rateIndex], 'table', 0.9);
        }
      }
    }
  }

  function scanElements(candidates) {
    const selector = [
      '[class*="rate" i]',
      '[class*="ratio" i]',
      '[class*="group" i]',
      '[class*="token" i]',
      '[class*="key" i]',
      '[class*="倍率" i]',
      '[class*="分组" i]',
      '[id*="rate" i]',
      '[id*="ratio" i]',
      '[id*="group" i]',
      '[id*="token" i]',
      '[id*="key" i]'
    ].join(',');

    const elements = new Set([
      ...document.querySelectorAll(selector),
      ...document.querySelectorAll('main, section, article, div, li')
    ]);

    for (const element of elements) {
      const text = normalizeText(element.innerText || element.textContent);
      if (!text || text.length < 3 || text.length > 800) {
        continue;
      }
      if (!/(rate|ratio|multiplier|倍率|费率|group|分组|[0-9.]+\s*x\b)/i.test(text)) {
        continue;
      }
      scanTextBlock(text, element.tagName.toLowerCase(), candidates);
    }
  }

  function dedupe(candidates) {
    const byKey = new Map();
    for (const item of candidates) {
      const key = `${item.group.toLowerCase()}::${item.rate}`;
      const existing = byKey.get(key);
      if (!existing || item.confidence > existing.confidence) {
        byKey.set(key, item);
      }
    }
    return Array.from(byKey.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, site.maxScanResults || 50);
  }

  try {
    const candidates = [];
    scanTables(candidates);
    scanElements(candidates);
    scanTextBlock(document.body ? document.body.innerText : '', 'body', candidates);

    const groups = dedupe(candidates);
    return {
      transport: 'scan',
      ok: groups.length > 0,
      status: 200,
      statusText: groups.length > 0 ? 'OK' : 'No matches',
      contentType: 'text/plain',
      groups,
      preview: normalizeText(document.body ? document.body.innerText : '').slice(0, 1000),
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      error: String(error.message || error),
      transport: 'scan',
      latencyMs: Date.now() - startedAt
    };
  }
}

function validateSite(site) {
  if (!site) {
    throw new Error('Missing site config.');
  }
  if ((site.requestMode || 'scan') === 'scan') {
    if (!site.origin && !site.scanUrl) {
      throw new Error('Page keyword scan needs a login origin or dashboard page URL.');
    }
    const url = new URL(site.scanUrl || site.origin);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Only http/https origins are supported.');
    }
    return;
  }
  if (!site.checkUrl) {
    throw new Error('Missing check URL.');
  }
  const url = new URL(site.checkUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are supported.');
  }
}

function toPagePayload(site) {
  return {
    checkUrl: site.checkUrl,
    method: site.method || 'GET',
    body: site.body || '',
    acceptJson: site.acceptJson !== false,
    contentType: site.contentType || 'application/json',
    headers: Array.isArray(site.headers) ? site.headers : [],
    tokenSource: site.tokenSource || 'none',
    tokenKey: site.tokenKey || '',
    tokenJsonPath: site.tokenJsonPath || '',
    authHeaderName: site.authHeaderName || 'Authorization',
    authHeaderTemplate: site.authHeaderTemplate || 'Bearer {{token}}'
  };
}

function toScanPayload(site) {
  return {
    maxScanResults: Number(site.maxScanResults) || 50
  };
}

function getTargetOrigin(site) {
  const base = site.origin || site.scanUrl || site.checkUrl;
  return new URL(base).origin;
}

function getTargetPageUrl(site) {
  return site.scanUrl || site.origin || site.checkUrl;
}

function buildHeaders(site, token) {
  const headers = {};
  if (site.acceptJson !== false) {
    headers.Accept = 'application/json';
  }
  if (site.method === 'POST') {
    headers['Content-Type'] = site.contentType || 'application/json';
  }
  for (const pair of site.headers || []) {
    if (pair.name && pair.value) {
      headers[pair.name] = pair.value;
    }
  }
  if (token && site.authHeaderName) {
    const template = site.authHeaderTemplate || 'Bearer {{token}}';
    headers[site.authHeaderName] = template.replaceAll('{{token}}', token);
  }
  return headers;
}

function buildBody(site) {
  if ((site.method || 'GET') === 'GET') {
    return undefined;
  }
  return site.body || '';
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractGroups({ site, text, parsed }) {
  if (site.parserType === 'regex') {
    return extractGroupsFromText(site, text);
  }
  return extractGroupsFromJson(site, parsed);
}

function extractGroupsFromJson(site, parsed) {
  if (!parsed) {
    throw new Error('Response is not valid JSON. The endpoint may be returning HTML or a login page.');
  }

  const source = site.jsonListPath ? getByPath(parsed, site.jsonListPath) : findBestJsonList(parsed);
  if (Array.isArray(source)) {
    return source.map((item, index) => groupFromJsonItem(site, item, index)).filter(Boolean);
  }
  if (source && typeof source === 'object') {
    return Object.entries(source).map(([name, value], index) => groupFromObjectEntry(site, name, value, index)).filter(Boolean);
  }
  throw new Error('JSON list path did not resolve to an array or object.');
}

function groupFromJsonItem(site, item, index) {
  if (item == null) {
    return null;
  }

  if (typeof item !== 'object') {
    return {
      group: `Group ${index + 1}`,
      rate: normalizeRate(item),
      keyHint: '',
      rawRate: stringifyValue(item)
    };
  }

  const group = firstValue(item, [site.jsonGroupPath, 'name', 'group', 'group_name', 'key', 'title', 'label'])
    || `Group ${index + 1}`;
  const rateValue = firstValue(item, [site.jsonRatePath, 'rate', 'ratio', 'multiplier', '倍率', 'group_rate', 'model_rate']);
  const keyValue = firstValue(item, [site.jsonKeyPath, 'token', 'key', 'api_key', 'sk']);
  return {
    group: stringifyValue(group),
    rate: normalizeRate(rateValue),
    keyHint: maskKey(stringifyValue(keyValue)),
    rawRate: stringifyValue(rateValue)
  };
}

function groupFromObjectEntry(site, name, value, index) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = groupFromJsonItem(site, { name, ...value }, index);
    if (item) {
      item.group = item.group || name;
    }
    return item;
  }
  return {
    group: stringifyValue(name) || `Group ${index + 1}`,
    rate: normalizeRate(value),
    keyHint: '',
    rawRate: stringifyValue(value)
  };
}

function firstValue(object, paths) {
  for (const path of paths) {
    if (!path) {
      continue;
    }
    const value = getByPath(object, path);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function findBestJsonList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const preferredPaths = [
    'data.groups',
    'data.group',
    'data',
    'groups',
    'group',
    'result.groups',
    'result.data',
    'list',
    'items'
  ];
  for (const path of preferredPaths) {
    const candidate = getByPath(value, path);
    if (Array.isArray(candidate) || (candidate && typeof candidate === 'object')) {
      return candidate;
    }
  }

  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      return current;
    }
    if (current && typeof current === 'object') {
      for (const child of Object.values(current)) {
        if (child && typeof child === 'object') {
          queue.push(child);
        }
      }
    }
  }
  return null;
}

function extractGroupsFromText(site, text) {
  const pattern = site.regex || '([^\\n\\r]+?)\\s*(?:rate|ratio|multiplier)\\s*[:=]\\s*([0-9.]+)\\s*x?';
  const flags = site.regexFlags || 'gi';
  const regex = new RegExp(pattern, flags);
  const groups = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    groups.push({
      group: (match[1] || `Group ${groups.length + 1}`).trim(),
      rate: normalizeRate(match[2]),
      keyHint: maskKey(match[3] || ''),
      rawRate: match[2] || ''
    });
    if (!regex.global) {
      break;
    }
  }

  if (groups.length === 0) {
    throw new Error('No rate groups matched the parser rule.');
  }
  return groups;
}

function getByPath(value, path) {
  if (!path) {
    return value;
  }
  return path.split('.').reduce((current, key) => {
    if (current == null) {
      return undefined;
    }
    if (Array.isArray(current) && /^\\d+$/.test(key)) {
      return current[Number(key)];
    }
    return current[key];
  }, value);
}

function stringifyValue(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function normalizeRate(value) {
  if (value == null) {
    return null;
  }
  const match = String(value).match(/([0-9]+(?:\\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function maskKey(value) {
  if (!value) {
    return '';
  }
  const text = String(value);
  if (text.length <= 10) {
    return '***';
  }
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function makePreview(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 500);
}

async function updateBadge(results) {
  const values = Object.values(results || {});
  const failed = values.filter((item) => item && !item.ok).length;
  if (failed > 0) {
    await chrome.action.setBadgeText({ text: String(failed) });
    await chrome.action.setBadgeBackgroundColor({ color: '#D92D20' });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
}
