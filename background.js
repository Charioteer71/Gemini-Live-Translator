/**
 * Gemini Live Translator - Background Service Worker (Release Edition)
 */

const DEFAULT_CONFIG = {
  apiHost: 'https://generativelanguage.googleapis.com',
  apiKey: '',
  model: 'models/gemini-3.5-live-translate-preview',
  sourceLang: '自动识别 (Auto Detect)',
  targetLang: '中文普通话 (Chinese)',
  forcedDomain: 'auto',
  fontSize: 17,
  opacity: 0.65,
  blur: 3,
  audioMode: 'video'
};

function sanitizeErrorMessage(err) {
  if (err === null || err === undefined) return '';
  const msg = typeof err === 'string' ? err : (err.message || String(err));
  return msg.replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***');
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['geminiLiveConfig'], (res) => {
    if (!res.geminiLiveConfig) {
      chrome.storage.local.set({ geminiLiveConfig: DEFAULT_CONFIG });
    } else {
      // Merge new defaults if missing
      const merged = { ...DEFAULT_CONFIG, ...res.geminiLiveConfig };
      chrome.storage.local.set({ geminiLiveConfig: merged });
    }
  });
});

function isConfigReady(cfg) {
  if (!cfg) return false;
  const host = (cfg.apiHost || '').trim();
  const key = (cfg.apiKey || '').trim();
  const isOfficial = !host || host.includes('generativelanguage.googleapis.com');
  if (isOfficial) {
    return key.length > 0;
  }
  return host.length > 0;
}

function getStoredConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['geminiLiveConfig'], (res) => {
      resolve(res.geminiLiveConfig || DEFAULT_CONFIG);
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
      await new Promise(r => setTimeout(r, 120));
      return true;
    } catch (err) {
      console.warn('[Gemini Live] Cannot inject script into tab:', sanitizeErrorMessage(err));
      return false;
    }
  }
  return true;
}

let offscreenCreating = null;
async function ensureOffscreenDocument() {
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    if (await chrome.offscreen.hasDocument()) return true;
  }
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  if (typeof chrome.runtime?.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return true;
  }
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio for translation'
    }).finally(() => {
      offscreenCreating = null;
    });
  }
  await offscreenCreating;
  return true;
}

// In Manifest V3 with "default_popup": "popup.html", toolbar icon clicks open popup.html directly.
// The service worker handles background coordination and message routing.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ENSURE_INJECTED' && msg.tabId) {
    ensureContentScriptInjected(msg.tabId).then((success) => {
      sendResponse({ success });
    });
    return true; // Keep message channel open for async response
  } else if (msg.action === 'GET_CONFIG_STATUS') {
    getStoredConfig().then((cfg) => {
      sendResponse({ ready: isConfigReady(cfg), config: cfg });
    });
    return true;
  } else if (msg.action === 'START_TAB_CAPTURE') {
    const tabId = (sender.tab && sender.tab.id) ? sender.tab.id : msg.tabId;
    if (!tabId) {
      sendResponse({ success: false, error: '未找到活动标签页' });
      return false;
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      try {
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
          action: 'OFFSCREEN_START_CAPTURE',
          streamId,
          tabId
        });
        sendResponse({ success: true, streamId });
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    });
    return true;
  } else if (msg.action === 'STOP_TAB_CAPTURE') {
    const tabId = (sender.tab && sender.tab.id) ? sender.tab.id : msg.tabId;
    chrome.runtime.sendMessage({
      action: 'OFFSCREEN_STOP_CAPTURE',
      tabId
    }).catch(() => {});
    sendResponse({ success: true });
    return false;
  } else if (msg.type === 'TAB_AUDIO_PCM_CHUNK' || msg.type === 'TAB_AUDIO_VOLUME' || msg.type === 'TAB_AUDIO_READY' || msg.type === 'TAB_AUDIO_ERROR') {
    // Route offscreen capture messages to the specific tab content script
    if (msg.tabId) {
      chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
    }
    return false;
  }
});

