/**
 * Gemini Live Translator - Background Service Worker
 * ------------------------------------------------------------------
 * 负责：默认配置初始化 / 旧配置迁移 / 内容脚本注入保障 / 配置状态查询。
 * 实时会话与音频处理全部在 content.js 中完成（避免 MV3 Service Worker 休眠干扰）。
 */

const DEFAULT_CONFIG = {
  apiHost: 'https://generativelanguage.googleapis.com',
  apiKey: '',
  model: 'models/gemini-3.5-live-translate-preview',
  sourceLang: '自动识别 (Auto Detect)',
  targetLang: '中文普通话 (Chinese)',
  forcedDomain: 'GENERAL',
  displayMode: 'bilingual',
  fontSize: 17,
  opacity: 0.65,
  blur: 3,
  audioMode: 'video',
  audioFrameStyle: 'mediaChunks',
  protocolMode: 'native',
  responseModality: 'AUDIO'
};

const EXTENSION_VERSION = '1.0.5';

function sanitizeErrorMessage(err) {
  if (err === null || err === undefined) return '';
  const msg = typeof err === 'string' ? err : (err.message || String(err));
  return msg.replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***');
}

function migrateConfig(stored) {
  const merged = Object.assign({}, DEFAULT_CONFIG, stored || {});
  // 剔除早已下线的 2.0 时代模型，回落到官方推荐同传模型
  if (typeof merged.model === 'string' && /gemini-1\.[05]|gemini-2\.0-flash-exp/i.test(merged.model)) {
    merged.model = DEFAULT_CONFIG.model;
  }
  // 数值类字段兜底
  if (typeof merged.fontSize !== 'number') merged.fontSize = DEFAULT_CONFIG.fontSize;
  if (typeof merged.opacity !== 'number') merged.opacity = DEFAULT_CONFIG.opacity;
  if (typeof merged.blur !== 'number') merged.blur = DEFAULT_CONFIG.blur;
  return merged;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['geminiLiveConfig'], (res) => {
    const merged = migrateConfig(res.geminiLiveConfig);
    chrome.storage.local.set({ geminiLiveConfig: merged });
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['geminiLiveConfig'], (res) => {
    if (!res.geminiLiveConfig) {
      chrome.storage.local.set({ geminiLiveConfig: DEFAULT_CONFIG });
    }
  });
});

function isConfigReady(cfg) {
  if (!cfg) return false;
  const host = String(cfg.apiHost || '').trim();
  const key = String(cfg.apiKey || '').trim();
  const isOfficial = !host || host.includes('generativelanguage.googleapis.com');
  if (isOfficial) return key.length > 0;
  return host.length > 0;
}

function getStoredConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['geminiLiveConfig'], (res) => {
      resolve(migrateConfig(res.geminiLiveConfig));
    });
  });
}

async function ensureContentScriptInjected(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
    if (res && res.status === 'PONG') return true;
  } catch (e) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise((r) => setTimeout(r, 120));
      return true;
    } catch (err) {
      console.warn('[Gemini Live] Cannot inject script into tab:', sanitizeErrorMessage(err));
      return false;
    }
  }
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.action === 'ENSURE_INJECTED' && msg.tabId) {
    ensureContentScriptInjected(msg.tabId).then((success) => sendResponse({ success }));
    return true;
  }
  if (msg.action === 'GET_CONFIG_STATUS') {
    getStoredConfig().then((cfg) => sendResponse({ ready: isConfigReady(cfg), config: cfg, version: EXTENSION_VERSION }));
    return true;
  }
  if (msg.action === 'GET_VERSION') {
    sendResponse({ version: EXTENSION_VERSION });
    return false;
  }
});
