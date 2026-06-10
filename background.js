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
    const transport = site.requestMode || 'page';
    const responseData = transport === 'background'
      ? await fetchFromBackground(site)
      : await fetchFromLoggedInTab(site);

    const parsed = responseData.contentType.includes('application/json')
      ? safeJson(responseData.text)
      : safeJson(responseData.text);
    const groups = extractGroups({ site, text: responseData.text, parsed });

    return {
      ok: responseData.ok && groups.length > 0,
      transport: responseData.transport,
      status: responseData.status,
      statusText: responseData.statusText,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      groups,
      error: responseData.ok ? null : `HTTP ${responseData.status} ${responseData.statusText}`,
      preview: makePreview(responseData.text)
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

async function findLoggedInTab(site) {
  const targetOrigin = getTargetOrigin(site);
  const tabs = await chrome.tabs.query({});
  const matched = tabs.find((tab) => {
    try {
      return tab.id && tab.url && new URL(tab.url).origin === targetOrigin;
    } catch {
      return false;
    }
  });

  if (!matched) {
    throw new Error(`Open and log in to ${targetOrigin} in a normal tab first, then run the check again.`);
  }
  return matched;
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

function validateSite(site) {
  if (!site || !site.checkUrl) {
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

function getTargetOrigin(site) {
  const base = site.origin || site.checkUrl;
  return new URL(base).origin;
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
