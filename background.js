/**
 * Gemini Live Translator - Background Service Worker
 * ------------------------------------------------------------------
 * 负责：默认配置初始化 / 旧配置迁移与数值校验 / 内容脚本注入保障 / 配置状态查询。
 * 实时会话与音频处理全部在 content.js 中完成（避免 MV3 Service Worker 休眠干扰）。
 */

const DEFAULT_CONFIG = {
  apiHost: 'https://generativelanguage.googleapis.com',
  apiKey: '',
  model: 'models/gemini-3.5-live-translate-preview',
  sourceLang: '自动识别 (Auto Detect)',
  targetLang: '中文普通话 (Chinese)',
  displayMode: 'bilingual',
  fontSize: 17,
  opacity: 0.65,
  blur: 3,
  audioMode: 'video',
  audioFrameStyle: 'mediaChunks',
  protocolMode: 'native',
  responseModality: 'AUDIO',
  schemaVersion: 2
};

const EXTENSION_VERSION = (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function')
  ? (chrome.runtime.getManifest().version || '1.1.0')
  : '1.1.0';

function cleanCredentialInput(val) {
  return String(val || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function sanitizeErrorMessage(err) {
  if (err === null || err === undefined) return '';
  const msg = typeof err === 'string' ? err : (err.message || String(err));
  return msg
    .replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***REDACTED***');
}

function clampNumber(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function isValidApiHost(hostRaw) {
  const h = cleanCredentialInput(hostRaw);
  if (!h) return false;
  const withoutProto = h.replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '').trim();
  return withoutProto.length > 0 && !/\s/.test(withoutProto);
}

function isPlainObject(val) {
  return !!val && typeof val === 'object' && !Array.isArray(val);
}

function isStrictFiniteNumber(val) {
  return typeof val === 'number' && Number.isFinite(val);
}

function deepEqualValues(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualValues(a[i], b[i])) return false;
    }
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqualValues(a[k], b[k])) return false;
  }
  return true;
}

function migrateConfig(stored) {
  const raw = isPlainObject(stored) ? Object.assign({}, stored) : {};
  delete raw.forcedDomain;
  const merged = Object.assign({}, DEFAULT_CONFIG, raw);

  merged.apiHost = cleanCredentialInput(merged.apiHost) || DEFAULT_CONFIG.apiHost;
  merged.apiKey = cleanCredentialInput(merged.apiKey);

  // 迁移已下线或非原生同传的旧模型至官方原生同传模型
  if (typeof merged.model !== 'string' || !merged.model.trim() || /gemini-1\.[05]|gemini-2\.|gemini-3\.1/i.test(merged.model)) {
    merged.model = DEFAULT_CONFIG.model;
  }

  // 数值与枚举类字段严格校验与边界钳制
  merged.fontSize = Math.round(clampNumber(merged.fontSize, 12, 30, DEFAULT_CONFIG.fontSize));
  merged.opacity = Number(clampNumber(merged.opacity, 0.1, 1.0, DEFAULT_CONFIG.opacity).toFixed(2));
  merged.blur = Math.round(clampNumber(merged.blur, 0, 20, DEFAULT_CONFIG.blur));

  if (!['bilingual', 'trans', 'orig'].includes(merged.displayMode)) {
    merged.displayMode = DEFAULT_CONFIG.displayMode;
  }
  if (!['video', 'mic'].includes(merged.audioMode)) {
    merged.audioMode = DEFAULT_CONFIG.audioMode;
  }
  if (merged.width !== undefined) {
    merged.width = Math.round(clampNumber(merged.width, 320, 4096, 760));
  }
  if (merged.height !== undefined) {
    merged.height = Math.round(clampNumber(merged.height, 160, 2160, 300));
  }
  if (Object.prototype.hasOwnProperty.call(merged, 'posRatio')) {
    if (!isPlainObject(merged.posRatio) || !isStrictFiniteNumber(merged.posRatio.x) || !isStrictFiniteNumber(merged.posRatio.y)) {
      delete merged.posRatio;
    } else {
      merged.posRatio = {
        x: Math.min(1, Math.max(0, merged.posRatio.x)),
        y: Math.min(1, Math.max(0, merged.posRatio.y))
      };
    }
  }
  if (merged.pos !== null && merged.pos !== undefined) {
    if (!isPlainObject(merged.pos) || !isStrictFiniteNumber(merged.pos.left) || !isStrictFiniteNumber(merged.pos.top)) {
      merged.pos = null;
    } else {
      merged.pos = {
        left: merged.pos.left,
        top: merged.pos.top
      };
    }
  }
  merged.schemaVersion = DEFAULT_CONFIG.schemaVersion;
  return merged;
}

let swStorageWriteChain = Promise.resolve();
let swPendingMutations = 0;

function runStorageMutationNow(mutator, done) {
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    done(result);
  };
  try {
    chrome.storage.local.get(['geminiLiveConfig'], (res) => {
      const getErr = chrome.runtime && chrome.runtime.lastError;
      if (getErr) {
        finish({ ok: false, error: sanitizeErrorMessage(getErr.message || String(getErr)) });
        return;
      }
      const rawExisting = isPlainObject(res && res.geminiLiveConfig) ? res.geminiLiveConfig : null;
      let next;
      try {
        next = mutator(rawExisting);
      } catch (err) {
        finish({ ok: false, error: sanitizeErrorMessage(err) });
        return;
      }
      if (isPlainObject(rawExisting) && deepEqualValues(rawExisting, next)) {
        finish({ ok: true, config: next, unchanged: true });
        return;
      }
      chrome.storage.local.set({ geminiLiveConfig: next }, () => {
        const setErr = chrome.runtime && chrome.runtime.lastError;
        if (setErr) {
          finish({ ok: false, error: sanitizeErrorMessage(setErr.message || String(setErr)) });
          return;
        }
        finish({ ok: true, config: next, unchanged: false });
      });
    });
  } catch (e) {
    finish({ ok: false, error: sanitizeErrorMessage(e) });
  }
}

function enqueueStorageMutation(mutator) {
  let resolveOuter;
  const taskPromise = new Promise((resolve) => {
    resolveOuter = resolve;
  });
  swPendingMutations++;

  const execute = () => new Promise((resolveChain) => {
    runStorageMutationNow(mutator, (result) => {
      swPendingMutations = Math.max(0, swPendingMutations - 1);
      resolveChain();
      resolveOuter(result);
    });
  });

  if (swPendingMutations === 1) {
    const donePromise = execute();
    swStorageWriteChain = swStorageWriteChain.then(() => donePromise);
  } else {
    swStorageWriteChain = swStorageWriteChain.then(execute, execute);
  }
  return taskPromise;
}

function syncStoredConfigIfNeeded() {
  return enqueueStorageMutation((rawExisting) => migrateConfig(rawExisting));
}

function patchStoredConfig(delta, deletions) {
  const safeDelta = isPlainObject(delta) ? delta : {};
  const safeDeletions = Array.isArray(deletions) ? deletions : [];
  return enqueueStorageMutation((rawExisting) => {
    const merged = Object.assign({}, rawExisting || {}, safeDelta);
    for (let i = 0; i < safeDeletions.length; i++) {
      const k = safeDeletions[i];
      if (typeof k === 'string' && k) delete merged[k];
    }
    const migrated = migrateConfig(merged);
    if (safeDeletions.indexOf('posRatio') !== -1 && !Object.prototype.hasOwnProperty.call(safeDelta, 'posRatio')) {
      delete migrated.posRatio;
    }
    return migrated;
  });
}

chrome.runtime.onInstalled.addListener(() => {
  syncStoredConfigIfNeeded();
});

chrome.runtime.onStartup.addListener(() => {
  syncStoredConfigIfNeeded();
});

function isOfficialApiHost(hostRaw) {
  const h = cleanCredentialInput(hostRaw);
  if (!h) return false;
  if (typeof URL === 'function') {
    try {
      const normalized = /^(https?|wss?):\/\//i.test(h) ? h : ('https://' + h);
      return new URL(normalized).hostname.toLowerCase() === 'generativelanguage.googleapis.com';
    } catch (e) {}
  }
  const hostWithoutProto = h.replace(/^(https?|wss?):\/\//i, '').split(/[\\/?#]/)[0];
  const hostPart = hostWithoutProto.includes('@') ? hostWithoutProto.split('@').pop() : hostWithoutProto;
  return hostPart.replace(/:\d*$/, '').toLowerCase() === 'generativelanguage.googleapis.com';
}

function isConfigReady(cfg) {
  if (!cfg) return false;
  const host = cleanCredentialInput(cfg.apiHost);
  const key = cleanCredentialInput(cfg.apiKey);
  const isOfficial = !host || isOfficialApiHost(host);
  if (isOfficial) return key.length > 0;
  return isValidApiHost(host);
}

function getStoredConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['geminiLiveConfig'], (res) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(migrateConfig(null));
          return;
        }
        resolve(migrateConfig(res && res.geminiLiveConfig));
      });
    } catch (e) {
      resolve(migrateConfig(null));
    }
  });
}

const tabTopPorts = new Map();
const tabSubframePorts = new Map();
const tabSubframes = new Map();
let activeTabCapture = null;
let pendingTabCapture = null;
let tabCaptureSeq = 0;
let tabCaptureOpChain = Promise.resolve();
let offscreenDocOpChain = Promise.resolve();
let tabStartIntentSeq = 0;
const activeTabStartIntent = new Map();

function enqueueTabCaptureOp(fn) {
  const run = tabCaptureOpChain.then(fn, fn);
  tabCaptureOpChain = run.catch(() => {});
  return run;
}

function runOffscreenDocOp(fn) {
  const run = offscreenDocOpChain.then(fn, fn);
  offscreenDocOpChain = run.catch(() => {});
  return run;
}

function sendToTopFrame(tabId, payload) {
  if (tabId === undefined || tabId === null) return;
  const topPort = tabTopPorts.get(tabId);
  if (topPort && typeof topPort.postMessage === 'function') {
    try {
      topPort.postMessage(payload);
      return;
    } catch (e) {
      tabTopPorts.delete(tabId);
    }
  }
  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    try {
      const p = chrome.tabs.sendMessage(tabId, payload, { frameId: 0 });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }
}

async function getTabMediaStreamId(tabId) {
  if (typeof chrome === 'undefined' || !chrome.tabCapture || typeof chrome.tabCapture.getMediaStreamId !== 'function') {
    throw new Error('tabCapture API unavailable');
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finishOk = (streamId) => {
      if (settled) return;
      settled = true;
      if (!streamId) reject(new Error('Empty streamId from tabCapture'));
      else resolve(streamId);
    };
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err || 'tabCapture failed')));
    };
    try {
      const maybePromise = chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        const lastErr = chrome.runtime && chrome.runtime.lastError;
        if (lastErr) {
          finishErr(new Error(lastErr.message || String(lastErr)));
          return;
        }
        finishOk(streamId);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(finishOk, finishErr);
      }
    } catch (e) {
      finishErr(e);
    }
  });
}

async function ensureOffscreenDocument() {
  return runOffscreenDocOp(async () => {
    if (typeof chrome === 'undefined' || !chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
      throw new Error('offscreen API unavailable');
    }
    if (typeof chrome.offscreen.hasDocument === 'function') {
      try {
        if (await chrome.offscreen.hasDocument()) return;
      } catch (e) {}
    } else if (chrome.runtime && typeof chrome.runtime.getContexts === 'function') {
      try {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (Array.isArray(contexts) && contexts.length > 0) return;
      } catch (e) {}
    }
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio for live subtitle translation when direct media capture is blocked.'
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err);
      if (!/single offscreen|already exists/i.test(msg)) {
        throw err;
      }
    }
  });
}

function sendOffscreenStopCapture(targetTabId, streamId) {
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
    try {
      const payload = {
        action: 'OFFSCREEN_STOP_CAPTURE',
        targetTabId: targetTabId
      };
      if (streamId) payload.streamId = streamId;
      const p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }
}

async function closeOffscreenDocumentSafe(expectedCaptureSeq) {
  return runOffscreenDocOp(async () => {
    if (expectedCaptureSeq !== undefined && expectedCaptureSeq !== tabCaptureSeq) return;
    if (activeTabCapture || pendingTabCapture) return;
    if (typeof chrome !== 'undefined' && chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') {
      activeOffscreenPort = null;
      try {
        await chrome.offscreen.closeDocument();
      } catch (e) {}
    }
  });
}

async function stopTabCaptureInternal(expectedTabId) {
  const hasExpected = expectedTabId !== undefined && expectedTabId !== null;
  if (hasExpected) {
    activeTabStartIntent.delete(expectedTabId);
  }
  const matchesActive = !!(activeTabCapture && (!hasExpected || activeTabCapture.tabId === expectedTabId));
  const matchesPending = !!(pendingTabCapture && (!hasExpected || pendingTabCapture.tabId === expectedTabId));
  if (hasExpected && !matchesActive && !matchesPending) return;

  const stopSeq = ++tabCaptureSeq;
  const prevActive = matchesActive ? activeTabCapture : null;
  const prevPending = matchesPending ? pendingTabCapture : null;
  if (matchesActive || !hasExpected) activeTabCapture = null;
  if (matchesPending || !hasExpected) pendingTabCapture = null;

  const targetTabId = (prevActive && prevActive.tabId !== undefined)
    ? prevActive.tabId
    : ((prevPending && prevPending.tabId !== undefined) ? prevPending.tabId : expectedTabId);
  const streamId = (prevActive && prevActive.streamId)
    ? prevActive.streamId
    : ((prevPending && prevPending.streamId) ? prevPending.streamId : undefined);

  sendOffscreenStopCapture(targetTabId, streamId);
  if (!hasExpected) {
    const preempted = new Map();
    if (prevActive && prevActive.tabId !== undefined && prevActive.tabId !== null) {
      preempted.set(prevActive.tabId, prevActive.streamId);
    }
    if (prevPending && prevPending.tabId !== undefined && prevPending.tabId !== null && !preempted.has(prevPending.tabId)) {
      preempted.set(prevPending.tabId, prevPending.streamId);
    }
    preempted.forEach((pStreamId, pTabId) => {
      const payload = { action: 'OFFSCREEN_STOPPED', targetTabId: pTabId };
      if (pStreamId) payload.streamId = pStreamId;
      sendToTopFrame(pTabId, payload);
    });
  }
  await closeOffscreenDocumentSafe(stopSeq);
}

async function startTabCaptureForTabImpl(tabId, intentId) {
  if (activeTabStartIntent.get(tabId) !== intentId) {
    return { ok: false, code: 'TAB_CAPTURE_CANCELLED', error: 'Tab capture cancelled' };
  }
  if ((activeTabCapture && activeTabCapture.tabId !== tabId) || (pendingTabCapture && pendingTabCapture.tabId !== tabId)) {
    await stopTabCaptureInternal();
  }
  if (activeTabStartIntent.get(tabId) !== intentId) {
    return { ok: false, code: 'TAB_CAPTURE_CANCELLED', error: 'Tab capture cancelled' };
  }
  const seq = ++tabCaptureSeq;
  pendingTabCapture = { tabId, seq, streamId: null };
  const isCancelled = () => (
    seq !== tabCaptureSeq ||
    !pendingTabCapture ||
    pendingTabCapture.seq !== seq ||
    pendingTabCapture.tabId !== tabId
  );

  let streamId;
  try {
    streamId = await getTabMediaStreamId(tabId);
  } catch (err) {
    if (pendingTabCapture && pendingTabCapture.seq === seq) pendingTabCapture = null;
    return { ok: false, code: 'TAB_CAPTURE_UNAVAILABLE', error: sanitizeErrorMessage(err) };
  }
  if (isCancelled()) {
    return { ok: false, code: 'TAB_CAPTURE_CANCELLED', error: 'Tab capture cancelled' };
  }
  if (pendingTabCapture && pendingTabCapture.seq === seq) {
    pendingTabCapture.streamId = streamId;
  }

  try {
    await ensureOffscreenDocument();
  } catch (err) {
    if (pendingTabCapture && pendingTabCapture.seq === seq) pendingTabCapture = null;
    return { ok: false, code: 'OFFSCREEN_UNAVAILABLE', error: sanitizeErrorMessage(err) };
  }
  if (isCancelled()) {
    sendOffscreenStopCapture(tabId, streamId);
    if (!activeTabCapture && !pendingTabCapture) await closeOffscreenDocumentSafe(tabCaptureSeq);
    return { ok: false, code: 'TAB_CAPTURE_CANCELLED', error: 'Tab capture cancelled' };
  }

  try {
    const resp = await new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
      try {
        const p = chrome.runtime.sendMessage(
          { action: 'OFFSCREEN_START_CAPTURE', targetTabId: tabId, streamId },
          (r) => {
            const lastErr = chrome.runtime && chrome.runtime.lastError;
            if (lastErr) done({ ok: false, error: lastErr.message || String(lastErr) });
            else done(r);
          }
        );
        if (p && typeof p.then === 'function') {
          p.then(done, (e) => done({ ok: false, error: sanitizeErrorMessage(e) }));
        }
      } catch (e) {
        done({ ok: false, error: sanitizeErrorMessage(e) });
      }
    });
    if (isCancelled()) {
      sendOffscreenStopCapture(tabId, streamId);
      if (!activeTabCapture && !pendingTabCapture) await closeOffscreenDocumentSafe(tabCaptureSeq);
      return { ok: false, code: 'TAB_CAPTURE_CANCELLED', error: 'Tab capture cancelled' };
    }
    if (!resp || resp.ok !== true) {
      if (pendingTabCapture && pendingTabCapture.seq === seq) pendingTabCapture = null;
      if (!activeTabCapture && !pendingTabCapture) await closeOffscreenDocumentSafe(seq);
      return { ok: false, code: 'OFFSCREEN_CAPTURE_FAILED', error: (resp && resp.error) ? resp.error : 'Offscreen capture failed' };
    }
    pendingTabCapture = null;
    activeTabCapture = { tabId, streamId, seq };
    return { ok: true };
  } catch (err) {
    if (pendingTabCapture && pendingTabCapture.seq === seq) pendingTabCapture = null;
    if (!activeTabCapture && !pendingTabCapture) await closeOffscreenDocumentSafe(seq);
    return { ok: false, code: 'OFFSCREEN_CAPTURE_FAILED', error: sanitizeErrorMessage(err) };
  }
}

async function startTabCaptureForTab(tabId) {
  if (tabId === undefined || tabId === null) {
    return { ok: false, code: 'TAB_CAPTURE_UNAVAILABLE', error: 'Missing target tabId' };
  }
  const intentId = ++tabStartIntentSeq;
  activeTabStartIntent.set(tabId, intentId);
  return enqueueTabCaptureOp(() => startTabCaptureForTabImpl(tabId, intentId));
}

async function pingTopFrame(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'PING' }, { frameId: 0 });
    return !!(res && res.status === 'PONG');
  } catch (e) {
    return false;
  }
}

async function ensureSubframesInjected(tabId) {
  if (!tabId || typeof chrome === 'undefined' || !chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    return false;
  }
  try {
    const probeResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => !!(window.__geminiLiveIsAlive && window.__geminiLiveIsAlive())
    });
    if (!Array.isArray(probeResults)) return true;
    const missingFrameIds = [];
    for (let i = 0; i < probeResults.length; i++) {
      const r = probeResults[i];
      if (r && typeof r.frameId === 'number' && r.frameId !== 0 && !r.result) {
        missingFrameIds.push(r.frameId);
      }
    }
    if (missingFrameIds.length > 0) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: missingFrameIds },
          files: ['spa_hook.js'],
          world: 'MAIN'
        });
      } catch (spaErr) {}
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: missingFrameIds },
        files: ['content.js']
      });
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureContentScriptInjected(tabId) {
  if (await pingTopFrame(tabId)) {
    ensureSubframesInjected(tabId).catch(() => {});
    return true;
  }
  try {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['spa_hook.js'], world: 'MAIN' });
    } catch (spaErr) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['spa_hook.js'], world: 'MAIN' });
      } catch (e2) {}
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    } catch (allErr) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    }
    await new Promise((r) => setTimeout(r, 120));
    return await pingTopFrame(tabId);
  } catch (err) {
    console.warn('[Gemini Live] Cannot inject script into tab:', sanitizeErrorMessage(err));
    return false;
  }
}

function clearTabState(tabId) {
  if (tabId === undefined || tabId === null) return;
  tabTopPorts.delete(tabId);
  tabSubframePorts.delete(tabId);
  tabSubframes.delete(tabId);
  activeTabStartIntent.delete(tabId);
  if ((activeTabCapture && activeTabCapture.tabId === tabId) || (pendingTabCapture && pendingTabCapture.tabId === tabId)) {
    stopTabCaptureInternal(tabId).catch(() => {});
  }
}

let activeOffscreenPort = null;

function handleOffscreenStopped(targetTabId, streamId) {
  const matchActive = activeTabCapture &&
    (targetTabId === undefined || targetTabId === null || activeTabCapture.tabId === targetTabId) &&
    (!streamId || activeTabCapture.streamId === streamId);
  const matchPending = pendingTabCapture &&
    (targetTabId === undefined || targetTabId === null || pendingTabCapture.tabId === targetTabId) &&
    (!streamId || pendingTabCapture.streamId === streamId);
  if (matchActive) activeTabCapture = null;
  if (matchPending) {
    tabCaptureSeq++;
    pendingTabCapture = null;
  }
  if (!activeTabCapture && !pendingTabCapture) {
    closeOffscreenDocumentSafe(tabCaptureSeq).catch(() => {});
  }
}

function isStaleOffscreenStreamMessage(msg) {
  if (!msg || !msg.streamId) return false;
  if (pendingTabCapture && pendingTabCapture.tabId === msg.targetTabId && !pendingTabCapture.streamId) {
    return true;
  }
  const expectedStreamId =
    (pendingTabCapture && pendingTabCapture.tabId === msg.targetTabId && pendingTabCapture.streamId) ||
    (activeTabCapture && activeTabCapture.tabId === msg.targetTabId && activeTabCapture.streamId) ||
    null;
  return !!(expectedStreamId && expectedStreamId !== msg.streamId);
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  if (chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
    chrome.tabs.onRemoved.addListener((tabId) => clearTabState(tabId));
  }
  if (chrome.tabs.onUpdated && typeof chrome.tabs.onUpdated.addListener === 'function') {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo && changeInfo.status === 'loading') {
        clearTabState(tabId);
      }
    });
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect && typeof chrome.runtime.onConnect.addListener === 'function') {
  chrome.runtime.onConnect.addListener((port) => {
    if (!port) return;
    if (port.name === 'glt-top-relay') {
      const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
      if (tabId === null || tabId === undefined) return;
      tabTopPorts.set(tabId, port);
      port.onDisconnect.addListener(() => {
        if (tabTopPorts.get(tabId) === port) tabTopPorts.delete(tabId);
      });
      return;
    }
    if (port.name === 'glt-subframe-audio') {
      const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
      const frameId = port.sender ? port.sender.frameId : null;
      if (tabId === null || tabId === undefined || frameId === null || frameId === undefined) return;
      if (!tabSubframePorts.has(tabId)) tabSubframePorts.set(tabId, new Map());
      tabSubframePorts.get(tabId).set(frameId, port);
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        const cmd = msg.type || msg.action;
        if (cmd === 'SUBFRAME_AUDIO_CHUNK' || cmd === 'SUBFRAME_MEDIA_STATE' || cmd === 'SUBFRAME_CORS_SILENCE' || cmd === 'SUBFRAME_CAPTURE_ERROR') {
          sendToTopFrame(tabId, Object.assign({}, msg, { action: cmd, frameId }));
        }
      });
      port.onDisconnect.addListener(() => {
        const subPorts = tabSubframePorts.get(tabId);
        if (!subPorts || subPorts.get(frameId) !== port) return;
        subPorts.delete(frameId);
        if (subPorts.size === 0) tabSubframePorts.delete(tabId);
        const reports = tabSubframes.get(tabId);
        if (reports) {
          reports.delete(frameId);
          if (reports.size === 0) tabSubframes.delete(tabId);
        }
        sendToTopFrame(tabId, { action: 'SUBFRAME_DISCONNECTED', frameId });
      });
      return;
    }
    if (port.name === 'glt-offscreen') {
      activeOffscreenPort = port;
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        const cmd = msg.type || msg.action;
        if (cmd === 'OFFSCREEN_AUDIO_CHUNK' || cmd === 'OFFSCREEN_STOPPED') {
          if (isStaleOffscreenStreamMessage(msg)) {
            return;
          }
          if (cmd === 'OFFSCREEN_STOPPED') handleOffscreenStopped(msg.targetTabId, msg.streamId);
          sendToTopFrame(msg.targetTabId, Object.assign({}, msg, { action: cmd }));
        }
      });
      port.onDisconnect.addListener(() => {
        if (activeOffscreenPort !== port) return;
        activeOffscreenPort = null;
        const staleActive = activeTabCapture ? Object.assign({}, activeTabCapture) : null;
        const stalePending = pendingTabCapture ? Object.assign({}, pendingTabCapture) : null;
        if (staleActive) {
          handleOffscreenStopped(staleActive.tabId, staleActive.streamId);
          sendToTopFrame(staleActive.tabId, {
            action: 'OFFSCREEN_STOPPED',
            targetTabId: staleActive.tabId,
            streamId: staleActive.streamId
          });
        } else if (stalePending) {
          handleOffscreenStopped(stalePending.tabId, stalePending.streamId);
          sendToTopFrame(stalePending.tabId, {
            action: 'OFFSCREEN_STOPPED',
            targetTabId: stalePending.tabId,
            streamId: stalePending.streamId
          });
        }
      });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const cmd = msg.action || msg.type;
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  const senderFrameId = sender && typeof sender.frameId === 'number' ? sender.frameId : null;

  if (cmd === 'ENSURE_INJECTED' && msg.tabId) {
    ensureContentScriptInjected(msg.tabId).then((success) => sendResponse({ ok: success, success }));
    return true;
  }
  if (cmd === 'ENSURE_SUBFRAMES_INJECTED') {
    const targetTabId = msg.tabId || senderTabId;
    ensureSubframesInjected(targetTabId).then((ok) => {
      try { sendResponse({ ok }); } catch (e) {}
    });
    return true;
  }
  if (cmd === 'GET_CONFIG_STATUS') {
    getStoredConfig().then((cfg) => sendResponse({ ready: isConfigReady(cfg), config: cfg, version: EXTENSION_VERSION }));
    return true;
  }
  if (cmd === 'PATCH_CONFIG') {
    patchStoredConfig(msg.delta, msg.deletions).then((result) => {
      try { sendResponse(result); } catch (e) {}
    });
    return true;
  }
  if (cmd === 'GET_VERSION') {
    sendResponse({ version: EXTENSION_VERSION });
    return false;
  }
  if (cmd === 'SUBFRAME_MEDIA_REPORT' && senderTabId !== null && senderFrameId !== null && senderFrameId !== 0) {
    if (!tabSubframes.has(senderTabId)) tabSubframes.set(senderTabId, new Map());
    const report = Object.assign({ frameId: senderFrameId }, msg.report || msg);
    tabSubframes.get(senderTabId).set(senderFrameId, report);
    sendToTopFrame(senderTabId, { action: 'SUBFRAME_MEDIA_UPDATE', frameId: senderFrameId, report });
    try { sendResponse({ ok: true }); } catch (e) {}
    return false;
  }
  if ((cmd === 'SUBFRAME_AUDIO_CHUNK' || cmd === 'SUBFRAME_MEDIA_STATE' || cmd === 'SUBFRAME_CORS_SILENCE' || cmd === 'SUBFRAME_CAPTURE_ERROR') && senderTabId !== null && senderFrameId !== null && senderFrameId !== 0) {
    sendToTopFrame(senderTabId, Object.assign({}, msg, { action: cmd, frameId: senderFrameId }));
    return false;
  }
  if (cmd === 'RELAY_SCAN_SUBFRAMES' && senderTabId !== null) {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      try {
        const p = chrome.tabs.sendMessage(senderTabId, { action: 'SUBFRAME_SCAN_MEDIA' });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {}
    }
    const existing = tabSubframes.get(senderTabId);
    try {
      sendResponse({ ok: true, subframes: existing ? Array.from(existing.values()) : [] });
    } catch (e) {}
    return false;
  }
  if (cmd === 'RELAY_START_SUBFRAME_CAPTURE' && senderTabId !== null && typeof msg.targetFrameId === 'number') {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      try {
        const p = chrome.tabs.sendMessage(senderTabId, { action: 'SUBFRAME_START_CAPTURE' }, { frameId: msg.targetFrameId });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {}
    }
    try { sendResponse({ ok: true }); } catch (e) {}
    return false;
  }
  if (cmd === 'RELAY_STOP_SUBFRAME_CAPTURE' && senderTabId !== null) {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      if (typeof msg.targetFrameId === 'number') {
        try {
          const p = chrome.tabs.sendMessage(senderTabId, { action: 'SUBFRAME_STOP_CAPTURE' }, { frameId: msg.targetFrameId });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) {}
      } else {
        const map = tabSubframes.get(senderTabId);
        if (map) {
          map.forEach((_, fid) => {
            try {
              const p = chrome.tabs.sendMessage(senderTabId, { action: 'SUBFRAME_STOP_CAPTURE' }, { frameId: fid });
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) {}
          });
        }
      }
    }
    try { sendResponse({ ok: true }); } catch (e) {}
    return false;
  }
  if (cmd === 'START_TAB_CAPTURE') {
    const targetTabId = msg.tabId || senderTabId;
    startTabCaptureForTab(targetTabId).then((res) => {
      try { sendResponse(res); } catch (e) {}
    });
    return true;
  }
  if (cmd === 'STOP_TAB_CAPTURE') {
    const targetTabId = msg.tabId || senderTabId;
    stopTabCaptureInternal(targetTabId).then(() => {
      try { sendResponse({ ok: true }); } catch (e) {}
    });
    return true;
  }
  if (cmd === 'OFFSCREEN_AUDIO_CHUNK' || cmd === 'OFFSCREEN_STOPPED') {
    if (isStaleOffscreenStreamMessage(msg)) {
      return false;
    }
    if (cmd === 'OFFSCREEN_STOPPED') handleOffscreenStopped(msg.targetTabId, msg.streamId);
    sendToTopFrame(msg.targetTabId, Object.assign({}, msg, { action: cmd }));
    return false;
  }
});
