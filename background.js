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
    const response = await fetch(site.checkUrl, {
      method: site.method || 'GET',
      credentials: 'include',
      headers: buildHeaders(site),
      body: buildBody(site)
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    const parsed = contentType.includes('application/json') ? safeJson(text) : null;
    const groups = extractGroups({ site, text, parsed });

    return {
      ok: response.ok && groups.length > 0,
      status: response.status,
      statusText: response.statusText,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      groups,
      error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      statusText: '',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      groups: [],
      error: String(error.message || error)
    };
  }
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

function buildHeaders(site) {
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
  if (site.parserType === 'json') {
    return extractGroupsFromJson(site, parsed);
  }
  return extractGroupsFromText(site, text);
}

function extractGroupsFromJson(site, parsed) {
  if (!parsed) {
    throw new Error('Response is not valid JSON.');
  }

  const list = getByPath(parsed, site.jsonListPath || '');
  if (!Array.isArray(list)) {
    throw new Error('JSON list path did not resolve to an array.');
  }

  const groupPath = site.jsonGroupPath || 'group';
  const ratePath = site.jsonRatePath || 'rate';
  const keyPath = site.jsonKeyPath || '';

  return list.map((item, index) => {
    const group = stringifyValue(getByPath(item, groupPath)) || `Group ${index + 1}`;
    const rateValue = getByPath(item, ratePath);
    const keyValue = keyPath ? getByPath(item, keyPath) : '';
    return {
      group,
      rate: normalizeRate(rateValue),
      keyHint: maskKey(stringifyValue(keyValue)),
      rawRate: stringifyValue(rateValue)
    };
  }).filter((item) => item.rate !== null || item.group);
}

function extractGroupsFromText(site, text) {
  const pattern = site.regex || '([^\\n\\r]+?)\\s*(?:倍率|rate|ratio|multiplier)\\s*[:：=]\\s*([0-9.]+)\\s*x?';
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
