/**
 * Gemini Live Translator - Chrome Extension Content Script (v2 Engine)
 * ---------------------------------------------------------------------
 * 实时双语同传字幕引擎（原生 Gemini 3.5 Live Translate 协议）
 *
 * 架构：
 *   1) 会话状态机（CONNECTING / READY / STREAMING / RECONNECTING / STOPPED）
 *      - 握手超时按网关实测放宽到 30s，网络离线感知自动挂起与恢复即连
 *      - 指数退避重连（上限 8s），区分致命鉴权错误与网关瞬态异常
 *      - 看门狗：有声音但长时间无转写 / 原文流动但译文停滞 / 服务端静默 → 主动重建会话
 *      - 9 分钟预防性「无缝轮转」与服务端 goAway 提前交接，字幕不断档
 *   2) 音频引擎：智能活跃 <video> 评分选择（含 captureStream 兜底）/ 麦克风 → AudioContext →
 *      跨块连续相位线性插值重采样到 16kHz/16bit/单声道 → 精确 100ms 分块 → Base64 → realtimeInput
 *   3) 字幕引擎：inputTranscription（原文）+ outputTranscription（译文）
 *      双语时间轴对齐合并 → 句末/分句标点与静音边界断句 → Shadow DOM 零重排渲染
 *   4) 浮窗 UI：响应式顶栏/固定高底栏防跳动/ResizeObserver 尺寸持久化/全屏自适应挂载
 */

(function () {
  'use strict';

  const isTopFrame = (() => {
    try {
      if (typeof window === 'undefined' || !window.top) return true;
      return (window.self || window) === window.top;
    } catch (e) {
      return false;
    }
  })();

  function isSameOriginWithParent() {
    if (isTopFrame) return false;
    try {
      const selfWin = (typeof window !== 'undefined' && window.self) ? window.self : window;
      if (!window.parent || window.parent === selfWin) return false;
      return !!(window.parent.document);
    } catch (e) {
      return false;
    }
  }

  // 若页面存在旧实例（例如扩展热重载或重复注入），先通知旧实例优雅释放 WebSocket/音频/定时器并移除旧节点
  try {
    document.dispatchEvent(new CustomEvent('gemini-live-translator-teardown'));
    if (isTopFrame) {
      const stale = document.getElementById('gemini-live-translator-host');
      if (stale) stale.remove();
    }
  } catch (e) {}
  window.__geminiLiveTranslatorLoaded = true;
  window.__geminiLiveIsAlive = () => !isDestroyed && isExtensionContextValid();

  // ========================================================================
  // 0. 常量与默认配置
  // ========================================================================

  const DEFAULT_CONFIG = {
    apiHost: 'https://generativelanguage.googleapis.com',
    apiKey: '',
    model: 'models/gemini-3.5-live-translate-preview',
    sourceLang: '自动识别 (Auto Detect)',
    targetLang: '中文普通话 (Chinese)',
    displayMode: 'bilingual', // 'bilingual' | 'trans' | 'orig'
    fontSize: 17,
    opacity: 0.65,
    blur: 3,
    audioMode: 'video', // 'video' | 'mic'
    audioFrameStyle: 'mediaChunks', // 'mediaChunks'（实测连续同传）| 'audio'（官方文档字段，实测稀疏）
    protocolMode: 'native', // 'native'（官方 translationConfig，实测连续+实时）| 'legacy'（兼容对照载荷）
    responseModality: 'AUDIO', // 原生同传模型：AUDIO（官方推荐，实测低延迟）| TEXT（仅字幕）
    width: 760,
    height: 300,
    pos: null,
    schemaVersion: 2
  };

  const MODEL_TRANSLATE = 'models/gemini-3.5-live-translate-preview';
  const EXTENSION_VERSION = (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function')
    ? (chrome.runtime.getManifest().version || '1.1.0')
    : '1.1.0';

  // 握手/重连/轮转参数（依据网关实测 0.5s~13.5s 握手波动放宽）
  const CONNECT_TIMEOUT_MS = 30000;
  const SERVER_SILENCE_RECONNECT_MS = 60000;
  const NO_TRANSCRIPTION_RECONNECT_MS = 18000;
  const NO_TRANSLATION_RECONNECT_MS = 20000;
  const SESSION_ROTATE_MS = 9 * 60 * 1000;
  const STANDBY_RETRY_MS = 60 * 1000;
  const STANDBY_URGENT_RETRY_MS = 1500;
  const STANDBY_URGENT_FRESH_MS = 15000;
  const ROTATION_DRAIN_MS = 1800;
  const MAX_RECONNECT_FAILURES = 8;
  const HEALTHY_SESSION_MIN_MS = 5000;
  const CONFIG_LOAD_TIMEOUT_MS = 3000;
  const PAUSE_FLUSH_CHUNKS = 3;
  const AUDIO_CHUNK_SAMPLES = 1600; // 100ms @16kHz
  const AUDIO_MAX_QUEUE_CHUNKS = 30; // 握手期间最多缓存 3s 音频
  const SUBTITLE_MAX_HISTORY = 80;
  const SUBTITLE_SCROLLED_UP_CAP = 160;

  let config = Object.assign({}, DEFAULT_CONFIG);
  let isDestroyed = false;
  const hadValidExtensionContext = isExtensionContextValid();
  let isContextInvalidated = false;

  // ========================================================================
  // 1. 通用工具
  // ========================================================================

  function isExtensionContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function cleanInputString(val) {
    return String(val || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  }

  function isValidApiHost(hostRaw) {
    const h = cleanInputString(hostRaw);
    if (!h) return false;
    const withoutProto = h.replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '').trim();
    return withoutProto.length > 0 && !/\s/.test(withoutProto);
  }

  function clampNumber(val, min, max, fallback) {
    const num = Number(val);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  /**
   * 脱敏：从任意错误信息 / URL 中抹掉 API Key。
   */
  function sanitizeErrorMessage(err) {
    if (err === null || err === undefined) return '';
    const msg = typeof err === 'string' ? err : (err.message || String(err));
    return msg
      .replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***REDACTED***');
  }

  function sanitizeUrl(url) {
    if (!url) return '';
    return String(url)
      .replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***REDACTED***');
  }

  function now() {
    return Date.now();
  }

  /**
   * 解析 Protobuf Duration（如 "59s"、"30.5s" 或纯数值秒）。
   */
  function parseDurationSeconds(val) {
    if (typeof val === 'number') return Number.isFinite(val) ? Math.max(0, val) : 0;
    if (typeof val === 'string') {
      const parsed = parseFloat(val.trim().replace(/s$/i, ''));
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }
    return 0;
  }

  /**
   * 指数退避 + 抖动：600ms,1.2s,2.4s,4.8s,8s（上限 8s，±20% 抖动）。
   * 常量内联以便单测可独立求值。
   */
  function calculateBackoffDelay(attempt) {
    const base = 600 * Math.pow(2, Math.max(0, attempt));
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(Math.round(base * jitter), 8000);
  }

  function isOfficialApiHost(hostRaw) {
    const h = cleanInputString(hostRaw);
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

  /**
   * 判断错误是否为「不可恢复的配置错误」。
   * 注意：走自定义网关时，网关注入的 Key 由服务端轮换，1008/404/429/440x 视作瞬态可重试；
   * 仅明确 Key 无效、1007/INVALID_ARGUMENT 或官方直连端点致命错误才终止重连。
   */
  function isTerminalError(code, reasonOrMessage, apiHost) {
    const str = String(reasonOrMessage || '');
    const rawHost = String(apiHost || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    let parsedHostname = '';
    if (rawHost) {
      if (typeof URL === 'function') {
        try {
          const normalizedUrl = /^(https?|wss?):\/\//i.test(rawHost) ? rawHost : ('https://' + rawHost);
          parsedHostname = new URL(normalizedUrl).hostname.toLowerCase();
        } catch (e) {}
      }
      if (!parsedHostname) {
        const hostWithoutProto = rawHost.replace(/^(https?|wss?):\/\//i, '').split(/[\\/?#]/)[0];
        const hostPart = hostWithoutProto.includes('@') ? hostWithoutProto.split('@').pop() : hostWithoutProto;
        parsedHostname = hostPart.replace(/:\d*$/, '').toLowerCase();
      }
    }
    const isOfficial = parsedHostname === 'generativelanguage.googleapis.com';
    const numCode = (code !== null && code !== undefined && typeof code !== 'boolean' && (typeof code !== 'string' || code.trim() !== ''))
      ? Number(code)
      : NaN;

    if (/API key not valid|API_KEY_INVALID|API key expired|CONSUMER_INVALID/i.test(str)) return true;
    if (numCode === 1007 || /INVALID_ARGUMENT|Invalid JSON payload received|Cannot find field/i.test(str)) return true;
    if (numCode === 400 && /INVALID_ARGUMENT|Invalid JSON payload|unknown name|unsupported/i.test(str)) return true;
    if (numCode === 401 || numCode === 403) {
      if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(str)) return true;
    }

    if (isOfficial) {
      if (numCode === 1008 || numCode === 404 || numCode === 429) return true;
      if (numCode === 400 || numCode === 401 || numCode === 403 || numCode === 4400 || numCode === 4401 || numCode === 4403) return true;
      if (/NOT_FOUND|Requested entity was not found|is not found for API version|RESOURCE_EXHAUSTED|Quota exceeded|BILLING_DISABLED|PERMISSION_DENIED|UNAUTHENTICATED/i.test(str)) {
        return true;
      }
    }
    return false;
  }

  function formatTerminalErrorMessage(code, reasonOrMessage) {
    const numCode = (code !== null && code !== undefined && typeof code !== 'boolean' && (typeof code !== 'string' || code.trim() !== ''))
      ? Number(code)
      : NaN;
    const clean = sanitizeErrorMessage(reasonOrMessage || `code ${code}`).slice(0, 100);
    if (numCode === 429 || /RESOURCE_EXHAUSTED|Quota exceeded|BILLING_DISABLED/i.test(clean)) {
      return `配额或计费受限 (${clean})，请检查 API 配额或更换代理节点`;
    }
    if (numCode === 404 || /NOT_FOUND|Requested entity was not found|is not found for API version/i.test(clean)) {
      return `模型或端点不可用 (${clean})，请在设置中确认模型名称`;
    }
    if (numCode === 1007 || numCode === 400 || /INVALID_ARGUMENT|Invalid JSON payload|Cannot find field/i.test(clean)) {
      return `请求参数或协议无效 (${clean})，请检查模型与协议设置`;
    }
    if (numCode === 1008) {
      return `策略或权限拒绝 (${clean})，请检查 API Key 与模型权限`;
    }
    return `鉴权失败: ${clean}`;
  }

  function detectLanguageFromText(text) {
    if (!text || typeof text !== 'string') return 'auto';
    let kanaCount = 0;
    let hangulCount = 0;
    let latinCount = 0;
    let cjkCount = 0;
    const len = text.length;

    for (let i = 0; i < len; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x3040 && code <= 0x30FF) {
        kanaCount++;
        if (kanaCount >= 2) return 'ja';
      } else if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF) || (code >= 0x3130 && code <= 0x318F)) {
        hangulCount++;
        if (hangulCount >= 2) return 'ko';
      } else if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
        cjkCount++;
      } else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        latinCount++;
      }
    }

    if (kanaCount > 0) return 'ja';
    if (hangulCount > 0) return 'ko';
    if (latinCount > 8 && latinCount > cjkCount * 1.2) return 'en';
    if (cjkCount === 0 && latinCount >= 6) return 'en';
    if (cjkCount > 5) return 'zh';
    return 'auto';
  }

  const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;'
  };
  const HTML_ESCAPE_REGEX = /[&<>"'`]/g;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const s = typeof str === 'string' ? str : String(str);
    if (!HTML_ESCAPE_REGEX.test(s)) return s;
    return s.replace(HTML_ESCAPE_REGEX, (ch) => HTML_ESCAPE_MAP[ch]);
  }

  /**
   * 目标语言 → BCP-47 语言码（官方 Live Translate 使用 zh-Hans / zh-Hant 等）
   */
  function getBcp47LanguageCode(targetLang) {
    const t = String(targetLang || '').toLowerCase();
    if (t.includes('中文') || t.includes('chinese') || t.includes('zh')) {
      if (t.includes('繁體') || t.includes('繁体') || t.includes('traditional') || t.includes('zh-tw') || t.includes('zh-hant')) return 'zh-Hant';
      return 'zh-Hans';
    }
    const map = [
      [/(日语|日語|japanese|日本語|\bja\b)/, 'ja'],
      [/(英语|english|\ben\b)/, 'en'],
      [/(韩语|韓語|korean|한국어|\bko\b)/, 'ko'],
      [/(西班|spanish|\bes\b)/, 'es'],
      [/(法語|法语|french|\bfr\b)/, 'fr'],
      [/(德語|德语|german|\bde\b)/, 'de'],
      [/(俄語|俄语|russian|\bru\b)/, 'ru'],
      [/(葡萄牙|portuguese|\bpt\b)/, 'pt-BR'],
      [/(義大利|意大利|italian|\bit\b)/, 'it'],
      [/(越南|vietnamese|\bvi\b)/, 'vi'],
      [/(泰語|泰语|thai|\bth\b)/, 'th'],
      [/(印尼|indonesian|\bid\b)/, 'id'],
      [/(阿拉伯|arabic|\bar\b)/, 'ar'],
      [/(印地|hindi|\bhi\b)/, 'hi'],
      [/(土耳其|turkish|\btr\b)/, 'tr']
    ];
    for (let i = 0; i < map.length; i++) {
      if (map[i][0].test(t)) return map[i][1];
    }
    return 'zh-Hans';
  }

  function isLiveTranslateModel(model) {
    return typeof model === 'string' && /live-translate/i.test(model);
  }

  function normalizeModelName(model) {
    let s = String(model || '').trim() || MODEL_TRANSLATE;
    s = s.replace(/^models\//i, '');
    return 'models/' + s;
  }

  function isPlainObject(val) {
    return !!val && typeof val === 'object' && !Array.isArray(val);
  }

  function isStrictFiniteNumber(val) {
    return typeof val === 'number' && Number.isFinite(val);
  }

  function deepEqualConfig(a, b) {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqualConfig(a[i], b[i])) return false;
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
      if (!deepEqualConfig(a[k], b[k])) return false;
    }
    return true;
  }

  function sanitizeConfigObject(rawCfg) {
    const next = Object.assign({}, DEFAULT_CONFIG, isPlainObject(rawCfg) ? rawCfg : {});
    delete next.forcedDomain;
    next.apiHost = cleanInputString(next.apiHost) || DEFAULT_CONFIG.apiHost;
    next.apiKey = cleanInputString(next.apiKey);
    if (!next.model || /gemini-1\.[05]|gemini-2\.|gemini-3\.1/i.test(String(next.model))) {
      next.model = DEFAULT_CONFIG.model;
    }
    next.fontSize = Math.round(clampNumber(next.fontSize, 12, 30, DEFAULT_CONFIG.fontSize));
    next.opacity = Number(clampNumber(next.opacity, 0.1, 1.0, DEFAULT_CONFIG.opacity).toFixed(2));
    next.blur = Math.round(clampNumber(next.blur, 0, 20, DEFAULT_CONFIG.blur));
    if (!['bilingual', 'trans', 'orig'].includes(next.displayMode)) {
      next.displayMode = DEFAULT_CONFIG.displayMode;
    }
    if (!['video', 'mic'].includes(next.audioMode)) {
      next.audioMode = DEFAULT_CONFIG.audioMode;
    }
    if (next.width !== undefined) next.width = Math.round(clampNumber(next.width, 320, 4096, DEFAULT_CONFIG.width));
    if (next.height !== undefined) next.height = Math.round(clampNumber(next.height, 160, 2160, DEFAULT_CONFIG.height));
    if (Object.prototype.hasOwnProperty.call(next, 'posRatio')) {
      if (!isPlainObject(next.posRatio) || !isStrictFiniteNumber(next.posRatio.x) || !isStrictFiniteNumber(next.posRatio.y)) {
        delete next.posRatio;
      } else {
        next.posRatio = {
          x: Math.min(1, Math.max(0, next.posRatio.x)),
          y: Math.min(1, Math.max(0, next.posRatio.y))
        };
      }
    }
    if (next.pos !== null && next.pos !== undefined) {
      if (!isPlainObject(next.pos) || !isStrictFiniteNumber(next.pos.left) || !isStrictFiniteNumber(next.pos.top)) {
        next.pos = null;
      } else {
        next.pos = {
          left: next.pos.left,
          top: next.pos.top
        };
      }
    }
    next.schemaVersion = DEFAULT_CONFIG.schemaVersion;
    return next;
  }

  // ========================================================================
  // 2. 运行时状态
  // ========================================================================

  let isRunning = false;          // 用户是否希望服务运行（意图）
  let overlayShowSeq = 0;
  let detectedSourceLang = 'auto';

  // 会话
  let sessionSeq = 0;
  let activeSession = null;       // 当前正在接收音频的会话
  let standbySession = null;      // 预防性轮转时正在握手的新会话
  let drainingSession = null;     // 轮转交接期等待尾音转写的旧会话
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let consecutiveFailures = 0;
  let rapidFlapFailures = 0;
  let circuitBreakerTripped = false;
  let lastErrorSummary = '';
  let watchdogTimer = null;
  let sessionStartTimer = null;
  let isNetworkOffline = false;
  const utf8Decoder = new TextDecoder('utf-8');

  // 音频
  let audioCtx = null;
  let persistentAudioCtx = null;
  let micAudioCtx = null;
  let audioSourceNode = null;
  let audioSourceKind = 'none';   // 'none' | 'video-element' | 'video-stream' | 'src-object-stream' | 'mixer' | 'mic' | 'subframe-relay' | 'tab-capture'
  let processorNode = null;
  let workletNode = null;
  const workletLoadedContexts = new WeakSet();
  const workletLoadingContexts = new WeakMap();
  let analyserNode = null;
  let mutedGainNode = null;
  let mixerBus = null;
  let mixerBusConnectedTap = null;
  const activeMixEntries = new Map();
  const observedMixCandidates = new Map();
  const observedCandidateStreams = new Map();
  let mediaReconcileDebounce = null;
  let mediaStream = null;
  let videoCaptureStream = null;
  let currentBoundVideo = null;
  let currentBoundSrcObject = null;
  let pendingBindVideo = null;
  let mediaSourceCache = new WeakMap();
  let streamSourceCache = new WeakMap();
  let audioPipelineReady = false;
  let audioInitSeq = 0;
  let audioInitInFlight = false;
  let audioChunksSent = 0;
  let lastAudioSentAt = 0;
  let lastSpeechAt = 0;
  let audioResumeTimer = null;
  let volumeLevel = 0;
  let volumeCheckInterval = null;
  let droppedAudioChunks = 0;
  let videoWaitTimer = null;
  let inlineAudioChunks = 0;
  let isVideoPaused = false;
  let silenceGateChunksRemaining = 0;
  let wasAudioInputGated = false;
  let mediaPauseStartedAt = 0;

  // Shadow DOM / iframe / CORS 静音检测 / 多帧中继 / 标签页捕获
  const observedShadowRoots = new WeakSet();
  const shadowRootPlayTargets = [];
  const observedSubDocs = new WeakSet();
  const subDocPlayTargets = [];
  const observedIframes = new WeakSet();
  const iframeLoadTargets = [];
  const CORS_SILENCE_THRESHOLD_MS = 2800;
  let zeroPcmSilentSince = 0;
  let corsSilenceDetected = false;
  let corsSilenceFallbackTried = false;
  let hasObservedAudioBlock = false;
  let lastAudioBlockMaxAbs = 1;
  let lastObservedMediaEl = null;
  let lastObservedMediaTime = -1;
  let lastMediaTimeAdvancedAt = 0;

  let topRelayPort = null;
  let subframeRelayPort = null;
  const knownSubframes = new Map();
  const failedSubframeIds = new Set();
  const subframeFailedMedia = new WeakMap();
  let topFailedMedia = new WeakMap();
  let activeSubframeId = null;
  let subframeRelayPaused = false;
  let subframeRelayMuted = false;
  let subframeCaptureActive = false;
  let tabCaptureActive = false;
  let tabCapturePending = false;
  let tabCapturePendingPromise = null;
  let tabCapturePendingPreempted = false;
  let tabCaptureFailedInSession = false;
  let tabCaptureRequestSeq = 0;
  let lastTabCaptureFallbackReason = '';
  let subframeMediaScanTimer = null;

  // 流式重采样器状态（跨 block 保持相位，避免块间漂移）
  const resampler = {
    carry: new Float32Array(2),
    carryCount: 0,
    phase: 0,
    step: 3,
    pending: new Int16Array(AUDIO_CHUNK_SAMPLES * 8),
    pendingCount: 0
  };

  // 字幕
  let currentStreamingEntry = null;
  let currentOrigBuffer = '';
  let currentTransBuffer = '';
  let committedLines = 0;
  let lastTranscriptionAt = 0;
  let lastServerMessageAt = 0;
  let silenceFlushTimer = null;
  let commitGraceTimer = null;
  let pendingCommitReason = '';

  // UI & 生命周期
  let isUserScrolledUp = false;
  let isDragging = false;
  const dragOffset = { x: 0, y: 0 };
  let isConnectingUI = false;
  let overlayResizeObserver = null;
  let resizePersistTimer = null;
  let isSyncingOverlayStyle = false;
  let syncStyleTimer = null;
  let currentStatusKind = 'idle';
  let currentStatusText = '就绪';
  let contextCheckTimer = null;
  let runtimeMessageListener = null;
  let storageChangeListener = null;
  let wasRunningBeforeHide = false;
  let origHistoryPushState = null;
  let origHistoryReplaceState = null;
  let wrappedHistoryPushState = null;
  let wrappedHistoryReplaceState = null;
  let isStartingPending = false;
  let domMediaObserver = null;
  let domCheckDebounce = null;
  let lastObservedUrl = (typeof location !== 'undefined' && location && location.href) ? String(location.href) : '';
  let navigationRef = null;
  let activePiPVideo = null;
  let activeDocPiPWindow = null;
  let docPiPRef = null;
  let docPiPPageHideTarget = null;
  let onDocPiPWindowPageHide = null;

  // ========================================================================
  // 3. 静态辅助指令（仅 protocolMode === 'legacy' 回退时使用）
  // ========================================================================

  function buildDynamicSystemPrompt() {
    return '[CRITICAL DIRECTIVE]: You are a Real-Time Simultaneous Audio Interpreter. Output ONLY natural translations of the incoming speech in the target language.';
  }

  // ========================================================================
  // 4. Shadow DOM 浮窗 UI（仅顶层页面挂载）
  // ========================================================================

  const logoUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('icons/icon48.png') : '';

  const UI_ICONS = {
    globe: '<svg class="g-sub-svg g-sub-lang-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M3.6 9h16.8M3.6 15h16.8"></path><path d="M12 3a14.5 14.5 0 0 0 0 18 14.5 14.5 0 0 0 0-18"></path></svg>',
    swapLang: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="M7 10h13l-3.5-3.5M17 14H4l3.5 3.5"></path></svg>',
    videoSource: '<svg class="g-sub-svg" viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="2.2"></rect><polygon points="10 8.2 15 10.5 10 12.8 10 8.2" fill="currentColor" stroke="none"></polygon><path d="M8 20h8M12 17v3"></path></svg>',
    micSource: '<svg class="g-sub-svg" viewBox="0 0 24 24"><rect x="9" y="2.5" width="6" height="11" rx="3"></rect><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4M8.5 21h7"></path></svg>',
    refresh: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-15.4-6.4L3 8"></path><path d="M3 3v5h5"></path><path d="M3 12a9 9 0 0 0 15.4 6.4L21 16"></path><path d="M21 21v-5h-5"></path></svg>',
    settings: '<svg class="g-sub-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    clear: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path></svg>',
    close: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"></path></svg>',
    copy: '<svg class="g-sub-svg" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    check: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg>',
    checkOption: '<svg class="g-sub-svg g-sub-select-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg>',
    chevronDown: '<svg class="g-sub-svg g-sub-select-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"></polyline></svg>',
    reset: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path></svg>',
    arrowDown: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="M12 5v14M18 13l-6 6-6-6"></path></svg>',
    waveform: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4"></path></svg>',
    spinner: '<svg class="g-sub-svg g-sub-svg-spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.55"></path></svg>',
    pauseCircle: '<svg class="g-sub-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><line x1="10" y1="9" x2="10" y2="15"></line><line x1="14" y1="9" x2="14" y2="15"></line></svg>',
    muted: '<svg class="g-sub-svg" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="22" y1="9" x2="16" y2="15"></line><line x1="16" y1="9" x2="22" y2="15"></line></svg>',
    clock: '<svg class="g-sub-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline></svg>',
    warn: '<svg class="g-sub-svg" viewBox="0 0 24 24"><path d="m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    error: '<svg class="g-sub-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6M9 9l6 6"></path></svg>',
    idle: '<svg class="g-sub-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"></circle></svg>'
  };

  let hostEl = null;
  let shadowRoot = null;
  let overlay = null;
  let btnToggle = null;
  let btnToggleIcon = null;
  let btnReconnect = null;
  let subBody = null;
  let statusText = null;
  let statusIcon = null;
  let connDot = null;
  let volFill = null;
  let scrollBottomBtn = null;
  let srcLangSelect = null;
  let tgtLangSelect = null;
  let btnAudioMode = null;
  let btnSettings = null;
  let settingsPanel = null;
  let opacitySlider = null;
  let opacityVal = null;
  let blurSlider = null;
  let blurVal = null;
  let fontSizeSlider = null;
  let fontSizeVal = null;
  let displayModeSelect = null;
  let btnCopyAll = null;
  let btnResetStyle = null;
  let btnClear = null;
  let btnClose = null;
  let header = null;

  // Custom Glassmorphic Dropdown System (replaces OS-native select popup menus)
  const customDropdowns = [];
  function closeAllCustomDropdowns(exceptDropdown = null, restoreFocus = false) {
    for (let i = 0; i < customDropdowns.length; i++) {
      const dd = customDropdowns[i];
      if (dd && dd !== exceptDropdown) {
        const wasOpen = dd.classList.contains('open');
        if (typeof dd._close === 'function') {
          dd._close(restoreFocus && wasOpen);
        } else {
          dd.classList.remove('open');
          if (dd._trigger) {
            dd._trigger.setAttribute('aria-expanded', 'false');
            if (restoreFocus && wasOpen && typeof dd._trigger.focus === 'function') {
              dd._trigger.focus();
            }
          }
        }
      }
    }
  }

  function repositionOpenCustomDropdowns() {
    if (isDestroyed || !overlay || overlay.style.display === 'none') return;
    for (let i = 0; i < customDropdowns.length; i++) {
      const dd = customDropdowns[i];
      if (dd && dd.classList.contains('open') && typeof dd._reposition === 'function') {
        dd._reposition();
      }
    }
  }

  function updateSettingsPanelBounds() {
    if (!isTopFrame || !settingsPanel || !overlay) return;
    const headerH = (header && header.offsetHeight) ? header.offsetHeight : 44;
    const overlayH = (overlay.clientHeight || overlay.offsetHeight || config.height || 300);
    const topPx = Math.min(Math.max(0, overlayH - 4), Math.max(40, headerH + 4));
    const availH = overlayH - topPx - 8;
    const maxH = availH >= 24 ? availH : Math.max(0, overlayH - topPx - 4);
    settingsPanel.style.top = topPx + 'px';
    settingsPanel.style.maxHeight = maxH + 'px';
  }

  function setSettingsPanelOpen(open, restoreFocus = false) {
    if (!settingsPanel) return;
    const nextOpen = !!open;
    settingsPanel.classList.toggle('show', nextOpen);
    if (btnSettings) {
      btnSettings.classList.toggle('active-mode', nextOpen);
      btnSettings.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    }
    if (nextOpen) {
      updateSettingsPanelBounds();
    } else {
      for (let i = 0; i < customDropdowns.length; i++) {
        const dd = customDropdowns[i];
        if (dd && dd.classList.contains('open') && typeof settingsPanel.contains === 'function' && settingsPanel.contains(dd)) {
          if (typeof dd._close === 'function') dd._close(false);
        }
      }
      if (restoreFocus && btnSettings && typeof btnSettings.focus === 'function') {
        btnSettings.focus();
      }
    }
  }

  function syncAllCustomSelects() {
    if (srcLangSelect && typeof srcLangSelect._syncUI === 'function') srcLangSelect._syncUI();
    if (tgtLangSelect && typeof tgtLangSelect._syncUI === 'function') tgtLangSelect._syncUI();
    if (displayModeSelect && typeof displayModeSelect._syncUI === 'function') displayModeSelect._syncUI();
  }

  function enhanceCustomSelect(selectEl, opts = {}) {
    if (!selectEl || !selectEl.parentNode) return null;
    const baseId = selectEl.id || ('gSubSel_' + customDropdowns.length);
    const dropdown = document.createElement('div');
    dropdown.className = 'g-sub-dropdown' +
      (opts.block ? ' g-sub-dropdown-block' : '') +
      (opts.dropUp ? ' drop-up' : '');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'g-sub-select-trigger';
    trigger.title = selectEl.title || '';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const menuEl = document.createElement('div');
    menuEl.className = 'g-sub-select-menu';
    menuEl.id = baseId + '-menu';
    menuEl.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', menuEl.id);

    const ariaLabel = (selectEl.getAttribute && selectEl.getAttribute('aria-label')) || selectEl.title || '';
    if (ariaLabel) {
      trigger.setAttribute('aria-label', ariaLabel);
      menuEl.setAttribute('aria-label', ariaLabel);
    }

    const labelSpan = document.createElement('span');
    labelSpan.className = 'g-sub-select-label';
    trigger.appendChild(labelSpan);

    const chevronWrap = document.createElement('span');
    chevronWrap.innerHTML = UI_ICONS.chevronDown;
    if (chevronWrap.firstChild) trigger.appendChild(chevronWrap.firstChild);

    dropdown.appendChild(trigger);
    dropdown.appendChild(menuEl);
    dropdown._trigger = trigger;

    selectEl.classList.add('g-sub-native-hidden');
    if (typeof selectEl.parentNode.insertBefore === 'function') {
      selectEl.parentNode.insertBefore(dropdown, selectEl.nextSibling || null);
    } else {
      selectEl.parentNode.appendChild(dropdown);
    }

    let optionButtons = [];
    let activeIndex = 0;

    const setActiveIndex = (nextIdx, shouldFocus = false) => {
      if (optionButtons.length === 0) return;
      const bounded = Math.max(0, Math.min(optionButtons.length - 1, nextIdx));
      activeIndex = bounded;
      for (let i = 0; i < optionButtons.length; i++) {
        const btn = optionButtons[i];
        const isAct = i === bounded;
        btn.classList.toggle('active', isAct);
        if (isAct) {
          menuEl.setAttribute('aria-activedescendant', btn.id);
          if (menuEl.scrollHeight > menuEl.clientHeight) {
            const optTop = btn.offsetTop || 0;
            const optH = btn.offsetHeight || 27;
            const curScroll = menuEl.scrollTop || 0;
            const viewH = menuEl.clientHeight || 0;
            if (optTop < curScroll) {
              menuEl.scrollTop = optTop;
            } else if (optTop + optH > curScroll + viewH) {
              menuEl.scrollTop = Math.max(0, optTop + optH - viewH);
            }
          }
          if (shouldFocus && typeof btn.focus === 'function') {
            btn.focus();
          }
        }
      }
    };

    const selectOptionByValue = (val, restoreFocus = false) => {
      const changed = selectEl.value !== val;
      selectEl.value = val;
      syncUI();
      closeMenu(restoreFocus);
      if (changed) {
        selectEl.dispatchEvent(new Event('change'));
      }
    };

    const syncUI = () => {
      const options = Array.from(selectEl.options || []);
      const curVal = selectEl.value;
      let activeLabel = '';

      const existing = Array.from(menuEl.children || []);
      const canReuse = existing.length === options.length && existing.every((el, idx) => el.dataset && el.dataset.value === options[idx].value);

      if (canReuse) {
        optionButtons = existing;
        options.forEach((opt, idx) => {
          const optText = opt.textContent || opt.value || '';
          const isSelected = opt.value === curVal;
          if (isSelected) activeLabel = optText;
          const itemBtn = existing[idx];
          itemBtn.classList.toggle('selected', isSelected);
          itemBtn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
          const txtSpan = itemBtn.querySelector('span');
          if (txtSpan && txtSpan.textContent !== optText) {
            txtSpan.textContent = optText;
          }
        });
      } else {
        menuEl.innerHTML = '';
        optionButtons = [];
        options.forEach((opt, idx) => {
          const optText = opt.textContent || opt.value || '';
          const isSelected = opt.value === curVal;
          if (isSelected) activeLabel = optText;

          const itemBtn = document.createElement('button');
          itemBtn.type = 'button';
          itemBtn.id = `${baseId}-opt-${idx}`;
          itemBtn.tabIndex = -1;
          itemBtn.className = 'g-sub-select-option' + (isSelected ? ' selected' : '');
          itemBtn.setAttribute('role', 'option');
          itemBtn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
          itemBtn.dataset.value = opt.value;

          const txtSpan = document.createElement('span');
          txtSpan.textContent = optText;
          itemBtn.appendChild(txtSpan);

          const chkWrap = document.createElement('span');
          chkWrap.innerHTML = UI_ICONS.checkOption;
          if (chkWrap.firstChild) itemBtn.appendChild(chkWrap.firstChild);

          itemBtn.addEventListener('click', (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            selectOptionByValue(opt.value, true);
          });

          menuEl.appendChild(itemBtn);
          optionButtons.push(itemBtn);
        });
      }

      if (!activeLabel && options.length > 0) {
        activeLabel = options[0].textContent || options[0].value || '';
      }
      labelSpan.textContent = activeLabel;
    };

    const positionMenu = () => {
      const oRect = (overlay && typeof overlay.getBoundingClientRect === 'function') ? overlay.getBoundingClientRect() : null;
      const dRect = typeof dropdown.getBoundingClientRect === 'function' ? dropdown.getBoundingClientRect() : null;
      if (!opts.block) {
        const overlayH = (oRect && oRect.height > 0 ? oRect.height : 0) || (overlay && (overlay.clientHeight || overlay.offsetHeight)) || 300;
        const headerBottom = (dRect && typeof dRect.bottom === 'number' && oRect && typeof oRect.top === 'number' && dRect.bottom > oRect.top)
          ? Math.round(dRect.bottom - oRect.top)
          : ((header && header.offsetHeight) || 44);
        const avail = Math.floor(overlayH - headerBottom - 10);
        menuEl.style.maxHeight = Math.max(0, Math.min(216, avail)) + 'px';

        const overlayW = (oRect && oRect.width > 0 ? oRect.width : 0) || (overlay && (overlay.clientWidth || overlay.offsetWidth)) || 320;
        const maxOverlayW = Math.max(80, Math.floor(overlayW - 8));
        menuEl.style.maxWidth = maxOverlayW + 'px';
        const rawW = menuEl.offsetWidth || menuEl.clientWidth || 140;
        const effectiveW = Math.min(rawW, maxOverlayW);
        const dRelLeft = (dRect && oRect) ? (dRect.left - oRect.left) : 0;
        const dRelRight = (dRect && oRect) ? (dRect.right - oRect.left) : dRelLeft;
        if (oRect && overlayW > 0 && (dRelLeft + effectiveW > overlayW - 4)) {
          if (dRelRight - effectiveW >= 4) {
            menuEl.style.left = 'auto';
            menuEl.style.right = '0';
          } else {
            const targetRelLeft = Math.max(4, Math.min(dRelLeft, overlayW - effectiveW - 4));
            menuEl.style.left = Math.round(targetRelLeft - dRelLeft) + 'px';
            menuEl.style.right = 'auto';
          }
        } else {
          menuEl.style.left = '';
          menuEl.style.right = '';
        }
      } else if (settingsPanel && typeof settingsPanel.getBoundingClientRect === 'function') {
        if (oRect && oRect.height <= 0) {
          closeMenu(false);
          return;
        }
        if (typeof dropdown.scrollIntoView === 'function') {
          try { dropdown.scrollIntoView({ block: 'nearest' }); } catch (e) {}
        }
        const curDRect = dropdown.getBoundingClientRect();
        const panelRect = settingsPanel.getBoundingClientRect();
        if (panelRect && panelRect.height > 0 && curDRect) {
          const visibleTop = Math.min(panelRect.bottom, Math.max(panelRect.top, curDRect.top));
          const visibleBottom = Math.max(panelRect.top, Math.min(panelRect.bottom, curDRect.bottom));
          const availAbove = Math.max(0, Math.floor(visibleTop - panelRect.top - 8));
          const availBelow = Math.max(0, Math.floor(panelRect.bottom - visibleBottom - 8));
          const shouldDropUp = opts.dropUp ? (availAbove >= 84 || availAbove >= availBelow) : false;
          dropdown.classList.toggle('drop-up', shouldDropUp);
          const space = Math.max(0, shouldDropUp ? availAbove : availBelow);
          const panelMaxSpace = Math.max(0, Math.floor(panelRect.height - 8));
          const inPanelMaxH = Math.min(210, panelMaxSpace, space);
          const activeEl = (shadowRoot && shadowRoot.activeElement) || (typeof document !== 'undefined' && document.activeElement) || null;
          const keepFocusEl = (activeEl && activeEl !== menuEl && typeof menuEl.contains === 'function' && menuEl.contains(activeEl)) ? activeEl : null;
          if ((panelRect.height < 80 || inPanelMaxH < 30) && oRect && oRect.height > 0) {
            if (overlay && menuEl.parentNode !== overlay && typeof overlay.appendChild === 'function') {
              overlay.appendChild(menuEl);
              menuEl.classList.add('open');
              if (keepFocusEl && typeof keepFocusEl.focus === 'function') keepFocusEl.focus();
            }
            const ovAnchorTop = Math.min(panelRect.top, visibleTop);
            const ovAvailAbove = Math.max(0, Math.floor(ovAnchorTop - oRect.top - 6));
            const ovAvailBelow = Math.max(0, Math.floor(oRect.bottom - visibleBottom - 6));
            const ovDropUp = opts.dropUp ? (ovAvailAbove >= 36 || ovAvailAbove >= ovAvailBelow) : (ovAvailBelow < 36 && ovAvailAbove > ovAvailBelow);
            dropdown.classList.toggle('drop-up', ovDropUp);
            const ovSpace = Math.max(0, ovDropUp ? ovAvailAbove : ovAvailBelow);
            const ovMaxH = Math.min(210, ovSpace);
            const overlayW = oRect.width || (overlay && (overlay.clientWidth || overlay.offsetWidth)) || 320;
            const maxOverlayW = Math.max(132, Math.floor(overlayW - 8));
            const menuW = Math.min(Math.max(132, Math.round(curDRect.width || 240)), maxOverlayW);
            const menuLeft = Math.max(Math.round(oRect.left + 4), Math.min(Math.round(oRect.right - menuW - 4), Math.round(curDRect.left)));
            menuEl.style.position = 'fixed';
            menuEl.style.left = '0px';
            menuEl.style.right = 'auto';
            menuEl.style.top = '0px';
            menuEl.style.bottom = 'auto';
            menuEl.style.width = menuW + 'px';
            menuEl.style.minWidth = '0px';
            menuEl.style.maxHeight = ovMaxH + 'px';
            const probeRect = typeof menuEl.getBoundingClientRect === 'function' ? menuEl.getBoundingClientRect() : null;
            const hasRealProbe = !!(probeRect && (probeRect.height > 0 || probeRect.left !== 0 || probeRect.top !== 0 || probeRect.bottom !== 0));
            const cbLeft = hasRealProbe ? probeRect.left : 0;
            const cbTop = hasRealProbe ? probeRect.top : 0;
            const measuredH = (hasRealProbe && probeRect.height > 0) ? probeRect.height : ovMaxH;
            const targetTop = ovDropUp
              ? Math.max(Math.round(oRect.top + 4), Math.round((ovAnchorTop - 4) - measuredH))
              : Math.min(Math.round(oRect.bottom - measuredH - 4), Math.round(visibleBottom + 4));
            menuEl.style.left = Math.round(menuLeft - cbLeft) + 'px';
            menuEl.style.top = Math.round(targetTop - cbTop) + 'px';
            if (hasRealProbe && typeof menuEl.getBoundingClientRect === 'function') {
              const afterRect = menuEl.getBoundingClientRect();
              const dy = targetTop - afterRect.top;
              const dx = menuLeft - afterRect.left;
              if (Math.abs(dy) >= 1) {
                menuEl.style.top = Math.round((parseFloat(menuEl.style.top) || 0) + dy) + 'px';
              }
              if (Math.abs(dx) >= 1) {
                menuEl.style.left = Math.round((parseFloat(menuEl.style.left) || 0) + dx) + 'px';
              }
            }
          } else {
            menuEl.classList.remove('open');
            if (menuEl.parentNode !== dropdown && typeof dropdown.appendChild === 'function') {
              dropdown.appendChild(menuEl);
              if (keepFocusEl && typeof keepFocusEl.focus === 'function') keepFocusEl.focus();
            }
            menuEl.style.position = '';
            menuEl.style.left = '';
            menuEl.style.right = '';
            menuEl.style.top = '';
            menuEl.style.bottom = '';
            menuEl.style.width = '';
            menuEl.style.minWidth = '';
            menuEl.style.maxHeight = inPanelMaxH + 'px';
          }
        }
      }
    };

    const openMenu = (initialIdx = null, shouldFocusOption = true) => {
      closeAllCustomDropdowns(dropdown, false);
      if (!opts.block && settingsPanel && settingsPanel.classList.contains('show')) {
        setSettingsPanelOpen(false, false);
      }
      syncUI();
      dropdown.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      positionMenu();
      const options = Array.from(selectEl.options || []);
      const selIdx = options.findIndex((o) => o.value === selectEl.value);
      const startIdx = initialIdx !== null ? initialIdx : (selIdx >= 0 ? selIdx : 0);
      setActiveIndex(startIdx, shouldFocusOption);
    };

    const closeMenu = (restoreFocus = false) => {
      const wasOpen = dropdown.classList.contains('open');
      if (restoreFocus && wasOpen && typeof trigger.focus === 'function') {
        trigger.focus();
      }
      dropdown.classList.remove('open');
      menuEl.classList.remove('open');
      if (menuEl.parentNode !== dropdown && typeof dropdown.appendChild === 'function') {
        dropdown.appendChild(menuEl);
      }
      trigger.setAttribute('aria-expanded', 'false');
      menuEl.style.position = '';
      menuEl.style.left = '';
      menuEl.style.right = '';
      menuEl.style.top = '';
      menuEl.style.bottom = '';
      menuEl.style.width = '';
      menuEl.style.minWidth = '';
      for (let i = 0; i < optionButtons.length; i++) {
        optionButtons[i].classList.remove('active');
      }
      if (typeof menuEl.removeAttribute === 'function') {
        menuEl.removeAttribute('aria-activedescendant');
      }
    };

    dropdown._close = closeMenu;
    dropdown._reposition = positionMenu;

    trigger.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      const willOpen = !dropdown.classList.contains('open');
      if (willOpen) {
        openMenu(null, false);
      } else {
        closeMenu(false);
      }
    });

    const handleDropdownKeyDown = (e) => {
      if (!e) return;
      const key = e.key;
      const isOpen = dropdown.classList.contains('open');
      const total = optionButtons.length;

      if (!isOpen) {
        if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          openMenu(null, true);
        } else if (key === 'Home') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          openMenu(0, true);
        } else if (key === 'End') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          openMenu(Math.max(0, total - 1), true);
        }
        return;
      }

      if (key === 'ArrowDown') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        setActiveIndex(activeIndex + 1, true);
      } else if (key === 'ArrowUp') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        setActiveIndex(activeIndex - 1, true);
      } else if (key === 'Home') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        setActiveIndex(0, true);
      } else if (key === 'End') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        setActiveIndex(Math.max(0, total - 1), true);
      } else if (key === 'Enter' || key === ' ') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        const chosenBtn = optionButtons[activeIndex];
        if (chosenBtn && chosenBtn.dataset) {
          selectOptionByValue(chosenBtn.dataset.value, true);
        } else {
          closeMenu(true);
        }
      } else if (key === 'Escape') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        closeMenu(true);
      } else if (key === 'Tab') {
        closeMenu(true);
      }
    };
    dropdown.addEventListener('keydown', handleDropdownKeyDown);
    menuEl.addEventListener('keydown', (e) => {
      if (menuEl.parentNode !== dropdown) handleDropdownKeyDown(e);
    });

    selectEl._syncUI = syncUI;
    selectEl._customDropdown = dropdown;
    customDropdowns.push(dropdown);
    syncUI();
    return dropdown;
  }

  if (isTopFrame) {
    hostEl = document.createElement('div');
    hostEl.id = 'gemini-live-translator-host';
    hostEl.style.cssText = 'all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important;';

    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('content.css') : 'content.css';
    shadowRoot.appendChild(styleLink);

    overlay = document.createElement('div');
    overlay.id = 'gemini-live-sub-overlay';
    overlay.style.display = 'none';

    overlay.innerHTML = `
      <div class="g-sub-header" id="gSubHeader">
        <div class="g-sub-brand-group">
          ${logoUrl ? `<img src="${logoUrl}" style="width: 20px; height: 20px; border-radius: 4px; object-fit: cover; vertical-align: middle;" alt="Logo" />` : ''}
          <div class="g-sub-logo">Gemini <span class="live-badge">Live</span> Translator</div>
          <button type="button" class="g-sub-toggle-btn" id="gSubToggle" title="开启/暂停实时同传字幕" aria-label="开启或暂停实时同传字幕" aria-pressed="false">
            <svg viewBox="0 0 24 24" id="gSubToggleIcon">
              <polygon points="6 4 20 12 6 20 6 4"></polygon>
            </svg>
          </button>
        </div>

        <div class="g-sub-lang-pill">
          ${UI_ICONS.globe}
          <select class="g-sub-lang-select" id="gSubSrcLang" title="识别源语言" aria-label="识别源语言">
            <option value="自动识别 (Auto Detect)" selected>自动识别</option>
            <option value="日语 (Japanese)">日语</option>
            <option value="英语 (English)">英语</option>
            <option value="韩语 (Korean)">韩语</option>
            <option value="中文 (Chinese)">中文</option>
          </select>
          <span class="g-sub-lang-arrow">${UI_ICONS.swapLang}</span>
          <select class="g-sub-lang-select" id="gSubTgtLang" title="翻译目标语言" aria-label="翻译目标语言">
            <option value="中文普通话 (Chinese)" selected>中文普通话</option>
            <option value="繁体中文 (Traditional Chinese)">繁体中文</option>
            <option value="英语 (English)">英语</option>
            <option value="日语 (Japanese)">日语</option>
            <option value="韩语 (Korean)">韩语</option>
            <option value="法语 (French)">法语</option>
            <option value="德语 (German)">德语</option>
            <option value="西班牙语 (Spanish)">西班牙语</option>
            <option value="俄语 (Russian)">俄语</option>
          </select>
        </div>

        <div class="g-sub-controls">
          <button type="button" class="g-sub-icon-btn" id="gSubAudioMode" title="音源切换: 网页视频 / 麦克风" aria-label="切换音源（网页视频或麦克风）" aria-pressed="false">${UI_ICONS.videoSource}</button>
          <button type="button" class="g-sub-icon-btn" id="gSubReconnect" title="重置并重新连接会话" aria-label="重置并重新连接会话">${UI_ICONS.refresh}</button>
          <button type="button" class="g-sub-icon-btn" id="gSubSettingsBtn" title="外观与快捷操作" aria-label="打开或关闭外观设置面板" aria-expanded="false" aria-controls="gSubSettingsPanel">${UI_ICONS.settings}</button>
          <button type="button" class="g-sub-icon-btn" id="gSubClear" title="清空当前屏幕字幕" aria-label="清空当前屏幕字幕">${UI_ICONS.clear}</button>
          <button type="button" class="g-sub-icon-btn close-btn" id="gSubClose" title="关闭字幕窗口" aria-label="关闭字幕窗口">${UI_ICONS.close}</button>
        </div>
      </div>

      <div class="g-sub-settings-panel" id="gSubSettingsPanel" role="region" aria-label="外观与快捷操作">
        <div class="g-sub-setting-row">
          <div class="g-sub-setting-label"><span>窗口不透明度</span><span id="gSubOpacityVal">65%</span></div>
          <input type="range" id="gSubOpacitySlider" min="10" max="100" value="65" class="g-sub-setting-slider" aria-label="窗口不透明度">
        </div>
        <div class="g-sub-setting-row">
          <div class="g-sub-setting-label"><span>背景毛玻璃模糊度</span><span id="gSubBlurVal">3px</span></div>
          <input type="range" id="gSubBlurSlider" min="0" max="20" value="3" class="g-sub-setting-slider" aria-label="背景毛玻璃模糊度">
        </div>
        <div class="g-sub-setting-row">
          <div class="g-sub-setting-label"><span>译文字号大小</span><span id="gSubFontSizeVal">17px</span></div>
          <input type="range" id="gSubFontSizeSlider" min="12" max="30" value="17" class="g-sub-setting-slider" aria-label="译文字号大小">
        </div>
        <div class="g-sub-setting-row">
          <div class="g-sub-setting-label"><span>字幕显示模式</span><span></span></div>
          <select class="g-sub-setting-select" id="gSubDisplayMode" aria-label="字幕显示模式">
            <option value="bilingual">双语（原文 + 译文）</option>
            <option value="trans">仅译文</option>
            <option value="orig">仅原文</option>
          </select>
        </div>
        <div class="g-sub-setting-actions">
          <button type="button" class="g-sub-action-btn" id="gSubCopyAll" title="复制当前全部字幕文本" aria-label="复制当前全部字幕文本">${UI_ICONS.copy}<span>复制字幕</span></button>
          <button type="button" class="g-sub-action-btn" id="gSubResetStyle" title="恢复默认字号、透明度与窗口尺寸" aria-label="恢复默认字号、透明度与窗口尺寸">${UI_ICONS.reset}<span>重置外观</span></button>
        </div>
      </div>

      <div class="g-sub-body" id="gSubBody" aria-live="polite">
        <div class="g-sub-entry" id="gSubInitialPrompt">
          <div class="g-sub-trans" style="font-size: 15px; color: #94a3b8; font-weight: 500;">正在监听音轨…</div>
        </div>
      </div>

      <div class="g-sub-status-bar">
        <div class="g-sub-status-left">
          <span class="g-sub-conn-dot" id="gSubConnDot"></span>
          <span class="g-sub-status-icon" id="gSubStatusIcon">${UI_ICONS.idle}</span>
          <span id="gSubStatusText" aria-live="polite">就绪</span>
          <span class="g-sub-vol-wrap" id="gSubVolWrap" title="输入音量"><span class="g-sub-vol-fill" id="gSubVolFill"></span></span>
        </div>
        <button type="button" class="g-sub-scroll-bottom-btn" id="gSubScrollBtn" aria-label="滚动回到最新字幕">${UI_ICONS.arrowDown}<span>回到最新</span></button>
      </div>
    `;

    shadowRoot.appendChild(overlay);
    if (document.body) {
      document.body.appendChild(hostEl);
    } else if (document.documentElement) {
      document.documentElement.appendChild(hostEl);
    }

    btnToggle = overlay.querySelector('#gSubToggle');
    btnToggleIcon = overlay.querySelector('#gSubToggleIcon');
    btnReconnect = overlay.querySelector('#gSubReconnect');
    subBody = overlay.querySelector('#gSubBody');
    statusText = overlay.querySelector('#gSubStatusText');
    statusIcon = overlay.querySelector('#gSubStatusIcon');
    connDot = overlay.querySelector('#gSubConnDot');
    volFill = overlay.querySelector('#gSubVolFill');
    scrollBottomBtn = overlay.querySelector('#gSubScrollBtn');
    srcLangSelect = overlay.querySelector('#gSubSrcLang');
    tgtLangSelect = overlay.querySelector('#gSubTgtLang');
    btnAudioMode = overlay.querySelector('#gSubAudioMode');
    btnSettings = overlay.querySelector('#gSubSettingsBtn');
    settingsPanel = overlay.querySelector('#gSubSettingsPanel');
    opacitySlider = overlay.querySelector('#gSubOpacitySlider');
    opacityVal = overlay.querySelector('#gSubOpacityVal');
    blurSlider = overlay.querySelector('#gSubBlurSlider');
    blurVal = overlay.querySelector('#gSubBlurVal');
    fontSizeSlider = overlay.querySelector('#gSubFontSizeSlider');
    fontSizeVal = overlay.querySelector('#gSubFontSizeVal');
    displayModeSelect = overlay.querySelector('#gSubDisplayMode');
    btnCopyAll = overlay.querySelector('#gSubCopyAll');
    btnResetStyle = overlay.querySelector('#gSubResetStyle');
    btnClear = overlay.querySelector('#gSubClear');
    btnClose = overlay.querySelector('#gSubClose');
    header = overlay.querySelector('#gSubHeader');

    enhanceCustomSelect(srcLangSelect);
    enhanceCustomSelect(tgtLangSelect);
    enhanceCustomSelect(displayModeSelect, { block: true, dropUp: true });

    // 阻断浮窗内部的键盘事件冒泡到宿主页面（防止调节控件时误触 YouTube/B站 空格暂停、方向键快进或全屏快捷键）
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const hadOpenDropdown = customDropdowns.some((dd) => dd && dd.classList.contains('open'));
        closeAllCustomDropdowns(null, hadOpenDropdown);
        if (!hadOpenDropdown && settingsPanel && settingsPanel.classList.contains('show')) {
          setSettingsPanelOpen(false, true);
        }
      }
      e.stopPropagation();
    });
    overlay.addEventListener('keyup', (e) => e.stopPropagation());
  }

  // ---- 状态条 ----------------------------------------------------------

  const STATUS_COLORS = {
    idle: '#94a3b8',
    ok: '#34d399',
    warn: '#f59e0b',
    err: '#ef4444',
    info: '#38bdf8'
  };

  function setStatus(kind, text, iconKey) {
    if (!statusText || !hostEl || isDestroyed) return;
    currentStatusKind = kind || 'idle';
    currentStatusText = text || '';
    const color = STATUS_COLORS[kind] || STATUS_COLORS.idle;
    statusText.textContent = text;
    statusText.title = text;
    statusText.style.color = color;
    if (statusIcon) {
      const defaultIconByKind = {
        idle: 'idle',
        ok: 'waveform',
        warn: 'warn',
        err: 'error',
        info: 'spinner'
      };
      const resolvedIcon = iconKey || defaultIconByKind[kind] || 'idle';
      statusIcon.innerHTML = UI_ICONS[resolvedIcon] || UI_ICONS.idle;
      statusIcon.style.color = color;
    }
    if (connDot) {
      connDot.style.background = color;
      connDot.style.boxShadow = kind === 'ok' ? '0 0 6px rgba(52,211,153,.9)' : 'none';
    }
    hostEl.dataset.gltStatus = text;
    hostEl.dataset.gltState = kind;
  }

  function setInitialPromptMessage(text) {
    if (!overlay || isDestroyed) return;
    const initPrompt = overlay.querySelector('#gSubInitialPrompt');
    if (!initPrompt) return;
    const transDiv = initPrompt.querySelector('.g-sub-trans');
    if (transDiv) transDiv.textContent = text;
  }

  function setDiagnostics(partial) {
    if (isDestroyed || !hostEl) return;
    Object.keys(partial || {}).forEach((k) => {
      hostEl.dataset['glt' + k] = String(partial[k]);
    });
  }

  function resetDetectedSourceLangBadge() {
    detectedSourceLang = 'auto';
    if (srcLangSelect) {
      const optAuto = srcLangSelect.querySelector('option[value*="自动识别"]');
      if (optAuto) optAuto.textContent = '自动识别';
      if (typeof srcLangSelect._syncUI === 'function') srcLangSelect._syncUI();
    }
  }

  // ---- 音量条 ----------------------------------------------------------

  function renderVolume(level) {
    volumeLevel = level;
    if (volFill) {
      const pct = Math.max(0, Math.min(100, Math.round(level * 3)));
      volFill.style.width = pct + '%';
      volFill.style.opacity = pct > 2 ? '1' : '0.25';
    }
  }

  // ---- 拖拽 / 缩放 / 视口 ---------------------------------------------

  function getFullscreenElement() {
    if (typeof document === 'undefined') return null;
    return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
  }

  function isNonContainerFullscreen(fsElement) {
    return !fsElement || !fsElement.tagName || /^(VIDEO|IFRAME|IMG|CANVAS|EMBED|OBJECT)$/i.test(fsElement.tagName);
  }

  function showHostInTopLayer() {
    if (!hostEl || typeof hostEl.showPopover !== 'function') return false;
    try {
      if (typeof hostEl.getAttribute !== 'function' || hostEl.getAttribute('popover') !== 'manual') {
        hostEl.setAttribute('popover', 'manual');
      }
      const isOpen = typeof hostEl.matches === 'function' ? hostEl.matches(':popover-open') : false;
      if (!isOpen) hostEl.showPopover();
      return true;
    } catch (e) {
      return false;
    }
  }

  function hideHostFromTopLayer() {
    if (!hostEl) return;
    try {
      if (typeof hostEl.hidePopover === 'function') {
        const isOpen = typeof hostEl.matches === 'function' ? hostEl.matches(':popover-open') : true;
        if (isOpen) hostEl.hidePopover();
      }
    } catch (e) {}
    try {
      if (typeof hostEl.removeAttribute === 'function') {
        hostEl.removeAttribute('popover');
      } else if (typeof hostEl.setAttribute === 'function') {
        hostEl.setAttribute('popover', '');
      }
    } catch (e) {}
  }

  function getUsableViewport() {
    const fsElement = getFullscreenElement();
    if (fsElement && typeof fsElement.getBoundingClientRect === 'function') {
      try {
        const rect = fsElement.getBoundingClientRect();
        if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0) {
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        }
      } catch (e) {}
    }
    const docEl = document.documentElement;
    const width = (docEl && docEl.clientWidth) ? docEl.clientWidth : window.innerWidth;
    const height = (docEl && docEl.clientHeight) ? docEl.clientHeight : window.innerHeight;
    return { width: Math.max(0, width), height: Math.max(0, height) };
  }

  function ensureOverlayInViewport() {
    if (isDestroyed || !overlay || overlay.style.display === 'none' || isDragging) return;
    const viewport = getUsableViewport();
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const overlayWidth = overlay.offsetWidth || config.width || 760;
    const overlayHeight = overlay.offsetHeight || config.height || 300;
    const maxLeft = Math.max(0, viewport.width - overlayWidth);
    const maxTop = Math.max(0, viewport.height - overlayHeight);

    let left, top;
    if (config.posRatio && isStrictFiniteNumber(config.posRatio.x) && isStrictFiniteNumber(config.posRatio.y)) {
      left = Math.round(config.posRatio.x * maxLeft);
      top = Math.round(config.posRatio.y * maxTop);
    } else if (config.pos && isStrictFiniteNumber(config.pos.left) && isStrictFiniteNumber(config.pos.top)) {
      left = config.pos.left;
      top = config.pos.top;
    } else {
      // 首次默认位置预留安全边距，避开视频播放器右下角控制栏
      left = Math.max(0, maxLeft - 24);
      top = Math.max(0, maxTop - 64);
    }
    left = Math.max(0, Math.min(maxLeft, left));
    top = Math.max(0, Math.min(maxTop, top));
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  }

  let resizeRafId = null;
  function onWindowResize() {
    if (!isTopFrame) return;
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(() => {
      ensureOverlayInViewport();
      if (overlay && overlay.style.display !== 'none' && settingsPanel && settingsPanel.classList.contains('show')) {
        updateSettingsPanelBounds();
      }
      repositionOpenCustomDropdowns();
      resizeRafId = null;
    });
  }

  let activeDragPointerId = null;
  let dragMode = null;
  let docPointerBound = false;

  function onDragMove(e) {
    if (!isDragging || !overlay) return;
    if (dragMode === 'pointer' && activeDragPointerId !== null && e && e.pointerId !== undefined && e.pointerId !== activeDragPointerId) {
      return;
    }
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    const viewport = getUsableViewport();
    const maxLeft = Math.max(0, viewport.width - (overlay.offsetWidth || 760));
    const maxTop = Math.max(0, viewport.height - (overlay.offsetHeight || 300));
    const left = Math.max(0, Math.min(maxLeft, e.clientX - dragOffset.x));
    const top = Math.max(0, Math.min(maxTop, e.clientY - dragOffset.y));
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
  }

  function onHeaderPointerMove(e) {
    if (!isDragging || dragMode !== 'pointer') return;
    onDragMove(e);
  }

  function onHeaderPointerUp(e) {
    if (!isDragging || dragMode !== 'pointer') return;
    if (activeDragPointerId !== null && e && e.pointerId !== undefined && e.pointerId !== activeDragPointerId) {
      return;
    }
    onDragEnd();
  }

  function onDragEnd() {
    if (!isDragging || !overlay) return;
    const prevPointerId = activeDragPointerId;
    isDragging = false;
    dragMode = null;
    activeDragPointerId = null;
    overlay.classList.remove('dragging');
    if (header && prevPointerId !== null && typeof header.releasePointerCapture === 'function') {
      try { header.releasePointerCapture(prevPointerId); } catch (err) {}
    }
    if (docPointerBound) {
      docPointerBound = false;
      document.removeEventListener('pointermove', onHeaderPointerMove);
      document.removeEventListener('pointerup', onHeaderPointerUp);
      document.removeEventListener('pointercancel', onHeaderPointerUp);
    }
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    window.removeEventListener('blur', onDragEnd);
    const viewport = getUsableViewport();
    const maxLeft = Math.max(0, viewport.width - (overlay.offsetWidth || 760));
    const maxTop = Math.max(0, viewport.height - (overlay.offsetHeight || 300));
    const currentLeft = Math.max(0, Math.min(maxLeft, parseFloat(overlay.style.left) || 0));
    const currentTop = Math.max(0, Math.min(maxTop, parseFloat(overlay.style.top) || 0));
    config.pos = { left: currentLeft, top: currentTop };
    config.posRatio = {
      x: maxLeft > 0 ? currentLeft / maxLeft : 1,
      y: maxTop > 0 ? currentTop / maxTop : 1
    };
    overlay.style.left = `${currentLeft}px`;
    overlay.style.top = `${currentTop}px`;
    saveConfig(true, ['pos', 'posRatio']);
  }

  function persistOverlayDimensions() {
    if (!overlay || overlay.style.display === 'none' || isDragging || isSyncingOverlayStyle) return;
    const w = overlay.offsetWidth;
    const h = overlay.offsetHeight;
    const viewport = getUsableViewport();
    const styleW = parseFloat(overlay.style.width);
    const styleH = parseFloat(overlay.style.height);
    const clampedW = (styleW === config.width && viewport.width > 0 && w < config.width && w >= viewport.width - 16);
    const clampedH = (styleH === config.height && viewport.height > 0 && h < config.height && h >= viewport.height - 16);
    const nextW = clampedW ? config.width : w;
    const nextH = clampedH ? config.height : h;
    const changedKeys = [];
    if (nextW >= 300 && nextW !== config.width) {
      config.width = nextW;
      changedKeys.push('width');
    }
    if (nextH >= 150 && nextH !== config.height) {
      config.height = nextH;
      changedKeys.push('height');
    }
    if (changedKeys.length > 0) {
      const curLeftRaw = parseFloat(overlay.style.left);
      const curTopRaw = parseFloat(overlay.style.top);
      if (viewport.width > 0 && viewport.height > 0 && Number.isFinite(curLeftRaw) && Number.isFinite(curTopRaw)) {
        const effW = nextW || config.width || 760;
        const effH = nextH || config.height || 300;
        const newMaxLeft = Math.max(0, viewport.width - effW);
        const newMaxTop = Math.max(0, viewport.height - effH);
        const clampedLeft = Math.max(0, Math.min(newMaxLeft, curLeftRaw));
        const clampedTop = Math.max(0, Math.min(newMaxTop, curTopRaw));
        overlay.style.left = `${clampedLeft}px`;
        overlay.style.top = `${clampedTop}px`;
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
        if (!config.pos || config.pos.left !== clampedLeft || config.pos.top !== clampedTop) {
          config.pos = { left: clampedLeft, top: clampedTop };
          changedKeys.push('pos');
        }
        if (config.posRatio) {
          config.posRatio = {
            x: newMaxLeft > 0 ? clampedLeft / newMaxLeft : 1,
            y: newMaxTop > 0 ? clampedTop / newMaxTop : 1
          };
          changedKeys.push('posRatio');
        }
      } else {
        ensureOverlayInViewport();
      }
      if (settingsPanel && settingsPanel.classList.contains('show')) {
        updateSettingsPanelBounds();
      }
      repositionOpenCustomDropdowns();
      saveConfig(false, changedKeys);
    }
  }

  if (isTopFrame) {
    window.addEventListener('resize', onWindowResize);

    header.addEventListener('pointerdown', (e) => {
      if (!e || e.isPrimary === false) return;
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target && e.target.closest && (e.target.closest('button') || e.target.closest('select') || e.target.closest('input') || e.target.closest('.g-sub-dropdown'))) return;
      isDragging = true;
      dragMode = 'pointer';
      activeDragPointerId = (e.pointerId !== undefined && e.pointerId !== null) ? e.pointerId : null;
      overlay.classList.add('dragging');
      const rect = overlay.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      if (activeDragPointerId !== null && typeof header.setPointerCapture === 'function') {
        try { header.setPointerCapture(activeDragPointerId); } catch (err) {}
      }
      const hasCapture = activeDragPointerId !== null && typeof header.hasPointerCapture === 'function' && header.hasPointerCapture(activeDragPointerId);
      if (!hasCapture) {
        docPointerBound = true;
        document.addEventListener('pointermove', onHeaderPointerMove);
        document.addEventListener('pointerup', onHeaderPointerUp);
        document.addEventListener('pointercancel', onHeaderPointerUp);
      }
      window.addEventListener('blur', onDragEnd);
    });

    header.addEventListener('pointermove', onHeaderPointerMove);
    header.addEventListener('pointerup', onHeaderPointerUp);
    header.addEventListener('pointercancel', onHeaderPointerUp);

    header.addEventListener('mousedown', (e) => {
      if (isDragging || activeDragPointerId !== null) return;
      if (e.button !== 0) return;
      if (e.target && e.target.closest && (e.target.closest('button') || e.target.closest('select') || e.target.closest('input') || e.target.closest('.g-sub-dropdown'))) return;
      closeAllCustomDropdowns();
      if (settingsPanel && settingsPanel.classList.contains('show')) setSettingsPanelOpen(false, false);
      isDragging = true;
      dragMode = 'mouse';
      overlay.classList.add('dragging');
      const rect = overlay.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
      window.addEventListener('blur', onDragEnd);
    });

    overlay.addEventListener('mouseup', (e) => {
      if (isDragging) return;
      if (e.target === header || header.contains(e.target)) return;
      persistOverlayDimensions();
    });

    // ResizeObserver 兜底：即使鼠标拖出浮窗边界外松开也能可靠保存尺寸
    if (typeof ResizeObserver === 'function') {
      overlayResizeObserver = new ResizeObserver(() => {
        if (overlay && overlay.style.display !== 'none') {
          if (settingsPanel && settingsPanel.classList.contains('show')) {
            updateSettingsPanelBounds();
          }
          repositionOpenCustomDropdowns();
        }
        if (!overlay || overlay.style.display === 'none' || isDragging || isSyncingOverlayStyle) return;
        if (resizePersistTimer) clearTimeout(resizePersistTimer);
        resizePersistTimer = setTimeout(() => {
          resizePersistTimer = null;
          persistOverlayDimensions();
        }, 220);
      });
      overlayResizeObserver.observe(overlay);
    }
  }

  function applyInitialStyles() {
    if (!overlay) return;
    isSyncingOverlayStyle = true;
    if (syncStyleTimer) {
      clearTimeout(syncStyleTimer);
      syncStyleTimer = null;
    }
    overlay.style.setProperty('--g-sub-opacity', config.opacity);
    overlay.style.setProperty('--g-sub-blur', `${config.blur}px`);
    overlay.style.setProperty('--g-sub-font-size', `${config.fontSize}px`);
    if (config.width) overlay.style.width = `${config.width}px`;
    if (config.height) overlay.style.height = `${config.height}px`;
    ensureOverlayInViewport();
    if (overlay.style.display !== 'none' && settingsPanel && settingsPanel.classList.contains('show')) {
      updateSettingsPanelBounds();
    }
    repositionOpenCustomDropdowns();
    syncStyleTimer = setTimeout(() => {
      syncStyleTimer = null;
      isSyncingOverlayStyle = false;
    }, 120);

    if (srcLangSelect && config.sourceLang) {
      const hasSrc = Array.from(srcLangSelect.options).some((o) => o.value === config.sourceLang);
      if (hasSrc) srcLangSelect.value = config.sourceLang;
    }
    if (tgtLangSelect && config.targetLang) {
      const hasTgt = Array.from(tgtLangSelect.options).some((o) => o.value === config.targetLang);
      if (hasTgt) tgtLangSelect.value = config.targetLang;
    }
    if (displayModeSelect && config.displayMode) displayModeSelect.value = config.displayMode;

    if (opacitySlider) opacitySlider.value = Math.round(config.opacity * 100);
    if (opacityVal) opacityVal.textContent = `${Math.round(config.opacity * 100)}%`;
    if (blurSlider) blurSlider.value = config.blur;
    if (blurVal) blurVal.textContent = `${config.blur}px`;
    if (fontSizeSlider) fontSizeSlider.value = config.fontSize;
    if (fontSizeVal) fontSizeVal.textContent = `${config.fontSize}px`;
    syncAllCustomSelects();
    applyDisplayMode();
  }

  function applyDisplayMode() {
    if (!overlay || !subBody) return;
    const mode = config.displayMode || 'bilingual';
    overlay.dataset.displayMode = mode;
    const entries = subBody.querySelectorAll('.g-sub-entry');
    entries.forEach((entry) => applyDisplayModeToEntry(entry));
    safeScrollToBottom();
  }

  function applyDisplayModeToEntry(entry) {
    if (!entry || !entry._origEl || !entry._transEl) return;
    const mode = config.displayMode || 'bilingual';
    const hasOrigText = !!(entry._origText && entry._origText.nodeValue && entry._origText.nodeValue.trim());
    if (mode === 'trans') {
      entry._origEl.style.display = 'none';
    } else if (mode === 'bilingual') {
      entry._origEl.style.display = (hasOrigText && !entry._echoSame) ? '' : 'none';
    } else {
      entry._origEl.style.display = hasOrigText ? '' : 'none';
    }
    entry._transEl.style.display = (mode === 'orig') ? 'none' : '';
  }

  // ---- 设置存储 --------------------------------------------------------

  let saveConfigTimer = null;
  let lastLocalPersistJson = '';
  const LOCAL_PERSIST_ECHO_TTL_MS = 5000;
  const recentLocalPersistSnapshots = [];
  const seenInFlightStorageSnapshots = [];
  const pendingSaveKeys = new Set();
  const inFlightKeyCounts = new Map();
  let storageWriteChain = Promise.resolve();
  let inFlightStorageWrites = 0;

  function pruneRecentLocalPersistSnapshots(tNow = now()) {
    for (let i = recentLocalPersistSnapshots.length - 1; i >= 0; i--) {
      if (recentLocalPersistSnapshots[i].expiresAt <= tNow) {
        recentLocalPersistSnapshots.splice(i, 1);
      }
    }
  }

  function recordLocalPersistSnapshot(persisted, rawPersisted) {
    const tNow = now();
    pruneRecentLocalPersistSnapshots(tNow);
    const json = JSON.stringify(persisted);
    const rawJson = rawPersisted ? JSON.stringify(rawPersisted) : json;
    lastLocalPersistJson = json;
    const seenIdx = seenInFlightStorageSnapshots.findIndex((snap) => deepEqualConfig(snap, persisted));
    if (seenIdx !== -1) {
      seenInFlightStorageSnapshots.splice(seenIdx, 1);
      return;
    }
    recentLocalPersistSnapshots.push({
      json,
      rawJson,
      snapshot: persisted,
      expiresAt: tNow + LOCAL_PERSIST_ECHO_TTL_MS
    });
    if (recentLocalPersistSnapshots.length > 16) {
      recentLocalPersistSnapshots.splice(0, recentLocalPersistSnapshots.length - 16);
    }
  }

  function consumeRecentLocalPersistSnapshot(serialized, sanitizedIncoming) {
    const tNow = now();
    pruneRecentLocalPersistSnapshots(tNow);
    for (let i = 0; i < recentLocalPersistSnapshots.length; i++) {
      const entry = recentLocalPersistSnapshots[i];
      if (entry.json === serialized || entry.rawJson === serialized || deepEqualConfig(entry.snapshot, sanitizedIncoming)) {
        recentLocalPersistSnapshots.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function trackInFlightKeys(keys, deltaSign) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const nextCount = (inFlightKeyCounts.get(k) || 0) + deltaSign;
      if (nextCount <= 0) inFlightKeyCounts.delete(k);
      else inFlightKeyCounts.set(k, nextCount);
    }
  }

  function flushPendingConfig() {
    if (isContextInvalidated || (hadValidExtensionContext && !isExtensionContextValid())) {
      handleContextInvalidated();
      return Promise.resolve();
    }
    if (!isExtensionContextValid() || pendingSaveKeys.size === 0) return Promise.resolve();
    const delta = {};
    const deletions = [];
    const touchedKeys = [];
    pendingSaveKeys.forEach((k) => {
      touchedKeys.push(k);
      if (Object.prototype.hasOwnProperty.call(config, k) && config[k] !== undefined) {
        delta[k] = config[k];
      } else {
        deletions.push(k);
      }
    });
    pendingSaveKeys.clear();
    if (Object.keys(delta).length === 0 && deletions.length === 0) return Promise.resolve();

    inFlightStorageWrites++;
    trackInFlightKeys(touchedKeys, 1);

    storageWriteChain = storageWriteChain.then(() => new Promise((resolve) => {
      let writeFinished = false;
      const finishWrite = () => {
        if (writeFinished) return;
        writeFinished = true;
        inFlightStorageWrites = Math.max(0, inFlightStorageWrites - 1);
        if (inFlightStorageWrites === 0) seenInFlightStorageSnapshots.length = 0;
        trackInFlightKeys(touchedKeys, -1);
        resolve();
      };

      if (isDestroyed || isContextInvalidated || !isExtensionContextValid()) {
        finishWrite();
        return;
      }

      const commitPersistedSnapshot = (rawPersisted, skipEchoRecord = false) => {
        const persisted = sanitizeConfigObject(rawPersisted);
        if (!Object.prototype.hasOwnProperty.call(rawPersisted, 'posRatio')) {
          delete persisted.posRatio;
        }
        if (!skipEchoRecord) {
          recordLocalPersistSnapshot(persisted, rawPersisted);
        }
        if (!isDestroyed && pendingSaveKeys.size === 0 && inFlightStorageWrites === 1 && !deepEqualConfig(config, persisted)) {
          applyConfigUpdate(persisted, { isFullSnapshot: true });
        }
      };

      const fallbackLocalWrite = () => {
        if (isDestroyed || isContextInvalidated || !isExtensionContextValid() || !chrome.storage || !chrome.storage.local) {
          finishWrite();
          return;
        }
        try {
          chrome.storage.local.get(['geminiLiveConfig'], (res) => {
            try {
              if (isDestroyed || (chrome.runtime && chrome.runtime.lastError)) {
                finishWrite();
                return;
              }
              const rawExisting = isPlainObject(res && res.geminiLiveConfig) ? res.geminiLiveConfig : null;
              const merged = Object.assign({}, rawExisting || {});
              Object.assign(merged, delta);
              for (let i = 0; i < deletions.length; i++) {
                delete merged[deletions[i]];
              }
              const sanitized = sanitizeConfigObject(merged);
              if (deletions.indexOf('posRatio') !== -1 && delta.posRatio === undefined) {
                delete sanitized.posRatio;
              }
              if (rawExisting && deepEqualConfig(rawExisting, sanitized)) {
                finishWrite();
                return;
              }
              const prevPersistJson = lastLocalPersistJson;
              lastLocalPersistJson = JSON.stringify(sanitized);
              chrome.storage.local.set({ geminiLiveConfig: sanitized }, () => {
                if (chrome.runtime && chrome.runtime.lastError) {
                  lastLocalPersistJson = prevPersistJson;
                  finishWrite();
                  return;
                }
                recordLocalPersistSnapshot(sanitized, sanitized);
                if (!isDestroyed && pendingSaveKeys.size === 0 && inFlightStorageWrites === 1 && !deepEqualConfig(config, sanitized)) {
                  applyConfigUpdate(sanitized, { isFullSnapshot: true });
                }
                finishWrite();
              });
            } catch (e) {
              if (hadValidExtensionContext && /invalidated/i.test(String(e))) handleContextInvalidated();
              finishWrite();
            }
          });
        } catch (e) {
          if (hadValidExtensionContext && /invalidated/i.test(String(e))) handleContextInvalidated();
          finishWrite();
        }
      };

      if (typeof chrome.runtime.sendMessage === 'function') {
        let settled = false;
        let fallbackTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          fallbackLocalWrite();
        }, 1500);
        const handlePatchResp = (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(fallbackTimer);
          const sendErr = chrome.runtime && chrome.runtime.lastError;
          if (sendErr) {
            if (hadValidExtensionContext && /invalidated/i.test(String(sendErr.message || sendErr))) {
              handleContextInvalidated();
              finishWrite();
              return;
            }
            fallbackLocalWrite();
            return;
          }
          if (!resp || !resp.ok || !isPlainObject(resp.config)) {
            fallbackLocalWrite();
            return;
          }
          commitPersistedSnapshot(resp.config, !!resp.unchanged);
          finishWrite();
        };
        try {
          const maybePromise = chrome.runtime.sendMessage({ type: 'PATCH_CONFIG', delta, deletions }, handlePatchResp);
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(handlePatchResp, () => {
              if (settled) return;
              settled = true;
              clearTimeout(fallbackTimer);
              fallbackLocalWrite();
            });
          }
          return;
        } catch (e) {
          if (!settled) {
            settled = true;
            clearTimeout(fallbackTimer);
          }
          if (hadValidExtensionContext && /invalidated/i.test(String(e))) {
            handleContextInvalidated();
            finishWrite();
            return;
          }
        }
      }

      fallbackLocalWrite();
    }));
    return storageWriteChain;
  }

  function saveConfig(immediate = false, changedKeys = null) {
    if (isContextInvalidated || (hadValidExtensionContext && !isExtensionContextValid())) {
      handleContextInvalidated();
      return;
    }
    if (Array.isArray(changedKeys)) {
      for (let i = 0; i < changedKeys.length; i++) {
        if (changedKeys[i]) pendingSaveKeys.add(changedKeys[i]);
      }
    } else if (typeof changedKeys === 'string' && changedKeys) {
      pendingSaveKeys.add(changedKeys);
    }
    if (saveConfigTimer) {
      clearTimeout(saveConfigTimer);
      saveConfigTimer = null;
    }
    const persist = () => {
      flushPendingConfig();
    };
    if (immediate) { persist(); return; }
    if (pendingSaveKeys.size === 0) return;
    saveConfigTimer = setTimeout(persist, 250);
  }

  /**
   * 统一应用配置变更（消除 storage.onChanged 与 UPDATE_CONFIG 并发到达时的竞态漏重启问题）。
   */
  function applyConfigUpdate(incomingRaw, options) {
    if (!incomingRaw || typeof incomingRaw !== 'object') return;
    const opts = options || {};
    const previous = config;
    const base = opts.isFullSnapshot ? Object.assign({}, DEFAULT_CONFIG, incomingRaw) : Object.assign({}, previous, incomingRaw);
    const next = sanitizeConfigObject(base);
    if (opts.isFullSnapshot && !Object.prototype.hasOwnProperty.call(incomingRaw, 'posRatio')) {
      delete next.posRatio;
    }
    if (deepEqualConfig(previous, next)) return;

    const nextIsNativeLive = isLiveTranslateModel(normalizeModelName(next.model)) && next.protocolMode !== 'legacy';
    const needsRestart = isRunning && (
      next.apiKey !== previous.apiKey ||
      next.apiHost !== previous.apiHost ||
      normalizeModelName(next.model) !== normalizeModelName(previous.model) ||
      getBcp47LanguageCode(next.targetLang) !== getBcp47LanguageCode(previous.targetLang) ||
      (!nextIsNativeLive && next.sourceLang !== previous.sourceLang) ||
      next.audioMode !== previous.audioMode ||
      next.audioFrameStyle !== previous.audioFrameStyle ||
      next.protocolMode !== previous.protocolMode ||
      next.responseModality !== previous.responseModality
    );

    config = next;
    if (!String(config.sourceLang || '').includes('自动识别')) {
      resetDetectedSourceLangBadge();
      setDiagnostics({ SrcLang: config.sourceLang });
    }
    applyInitialStyles();
    updateAudioModeButton();
    if (needsRestart) manualRestart('配置更新');
  }

  // ---- 滚动 ------------------------------------------------------------

  let scrollRafId = null;
  let scrollResetRafId = null;
  let viewportRafId = null;
  let isScrollPending = false;
  let isProgrammaticScrolling = false;

  function cancelPendingScroll() {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
      isScrollPending = false;
    }
    if (scrollResetRafId !== null) {
      cancelAnimationFrame(scrollResetRafId);
      scrollResetRafId = null;
      isProgrammaticScrolling = false;
    }
  }

  function scheduleEnsureOverlayInViewport() {
    if (isDestroyed) return;
    if (viewportRafId !== null) cancelAnimationFrame(viewportRafId);
    viewportRafId = requestAnimationFrame(() => {
      viewportRafId = null;
      if (!isDestroyed) {
        ensureOverlayInViewport();
        if (overlay && overlay.style.display !== 'none' && settingsPanel && settingsPanel.classList.contains('show')) {
          updateSettingsPanelBounds();
        }
        repositionOpenCustomDropdowns();
      }
    });
  }

  if (isTopFrame) {
    subBody.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) {
        const distanceFromBottom = subBody.scrollHeight - subBody.scrollTop - subBody.clientHeight;
        if (distanceFromBottom > 60) {
          isUserScrolledUp = true;
          scrollBottomBtn.style.display = 'inline-flex';
          cancelPendingScroll();
        }
      } else if (e.deltaY > 0) {
        const distanceFromBottom = subBody.scrollHeight - subBody.scrollTop - subBody.clientHeight;
        if (distanceFromBottom <= 30) {
          isUserScrolledUp = false;
          scrollBottomBtn.style.display = 'none';
        }
      }
    }, { passive: true });

    subBody.addEventListener('scroll', () => {
      if (isProgrammaticScrolling) return;
      const distanceFromBottom = subBody.scrollHeight - subBody.scrollTop - subBody.clientHeight;
      if (distanceFromBottom <= 30) {
        isUserScrolledUp = false;
        scrollBottomBtn.style.display = 'none';
      } else if (distanceFromBottom > 60) {
        isUserScrolledUp = true;
        scrollBottomBtn.style.display = 'inline-flex';
      }
    });

    scrollBottomBtn.addEventListener('click', () => {
      cancelPendingScroll();
      isUserScrolledUp = false;
      scrollBottomBtn.style.display = 'none';
      isProgrammaticScrolling = true;
      subBody.scrollTop = subBody.scrollHeight;
      if (scrollResetRafId !== null) cancelAnimationFrame(scrollResetRafId);
      scrollResetRafId = requestAnimationFrame(() => {
        scrollResetRafId = null;
        isProgrammaticScrolling = false;
      });
    });
  }

  function safeScrollToBottom() {
    if (isUserScrolledUp || isScrollPending) return;
    isScrollPending = true;
    scrollRafId = requestAnimationFrame(() => {
      isScrollPending = false;
      scrollRafId = null;
      if (!isUserScrolledUp && subBody) {
        isProgrammaticScrolling = true;
        subBody.scrollTop = subBody.scrollHeight;
        if (scrollResetRafId !== null) cancelAnimationFrame(scrollResetRafId);
        scrollResetRafId = requestAnimationFrame(() => {
          scrollResetRafId = null;
          isProgrammaticScrolling = false;
        });
      }
    });
  }

  // ---- UI 事件 ---------------------------------------------------------

  function updateAudioModeButton() {
    if (!btnAudioMode) return;
    const isVideo = config.audioMode === 'video';
    btnAudioMode.innerHTML = isVideo ? UI_ICONS.videoSource : UI_ICONS.micSource;
    btnAudioMode.classList.toggle('active-mode', !isVideo);
    btnAudioMode.setAttribute('aria-pressed', isVideo ? 'false' : 'true');
    btnAudioMode.title = isVideo
      ? '当前音源: 网页视频（点击切换为麦克风）'
      : '当前音源: 麦克风（点击切换为网页视频）';
  }

  function onDocumentPointerDown(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    const insideSelectMenu = path.some((el) => el && el.classList && el.classList.contains('g-sub-select-menu'));
    if (!path.some((el) => el && el.classList && el.classList.contains('g-sub-dropdown')) && !insideSelectMenu) {
      closeAllCustomDropdowns();
    }
    if (!settingsPanel || !settingsPanel.classList.contains('show')) return;
    if (!path.includes(settingsPanel) && !path.includes(btnSettings) && !insideSelectMenu) {
      setSettingsPanelOpen(false, false);
    }
  }

  function setActionBtnContent(btn, iconSvg, label) {
    if (!btn) return;
    btn.innerHTML = iconSvg;
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
  }

  if (isTopFrame) {
    btnReconnect.addEventListener('click', () => {
      if (!checkExtensionContextHealth()) return;
      if (isRunning) {
        manualRestart('用户手动重置会话');
      } else {
        startSubtitleService(true);
      }
    });

    btnClear.addEventListener('click', clearSubtitleBody);

    btnAudioMode.addEventListener('click', () => {
      if (!checkExtensionContextHealth()) return;
      config.audioMode = config.audioMode === 'video' ? 'mic' : 'video';
      updateAudioModeButton();
      saveConfig(true, ['audioMode']);
      if (isRunning) manualRestart('切换音源');
    });

    srcLangSelect.addEventListener('change', () => {
      if (!checkExtensionContextHealth()) return;
      config.sourceLang = srcLangSelect.value;
      if (!String(config.sourceLang || '').includes('自动识别')) {
        resetDetectedSourceLangBadge();
        setDiagnostics({ SrcLang: config.sourceLang });
      }
      saveConfig(true, ['sourceLang']);
      if (isRunning && !(isLiveTranslateModel(normalizeModelName(config.model)) && config.protocolMode !== 'legacy')) {
        manualRestart('切换源语言');
      }
    });

    tgtLangSelect.addEventListener('change', () => {
      if (!checkExtensionContextHealth()) return;
      const prevCode = getBcp47LanguageCode(config.targetLang);
      config.targetLang = tgtLangSelect.value;
      saveConfig(true, ['targetLang']);
      if (isRunning && getBcp47LanguageCode(config.targetLang) !== prevCode) {
        manualRestart('切换目标语言');
      }
    });

    btnToggle.addEventListener('click', () => {
      if (!checkExtensionContextHealth()) return;
      if (isRunning || isStartingPending) stopSubtitleService(true);
      else startSubtitleService(true);
    });

    btnClose.addEventListener('click', () => {
      overlayShowSeq++;
      wasRunningBeforeHide = false;
      overlay.style.display = 'none';
      hideHostFromTopLayer();
      closeAllCustomDropdowns();
      setSettingsPanelOpen(false, false);
      if (isRunning || isStartingPending) stopSubtitleService(true);
    });

    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllCustomDropdowns();
      const willOpen = !settingsPanel.classList.contains('show');
      setSettingsPanelOpen(willOpen, false);
    });

    document.addEventListener('pointerdown', onDocumentPointerDown, true);

    opacitySlider.addEventListener('input', () => {
      config.opacity = parseInt(opacitySlider.value, 10) / 100;
      opacityVal.textContent = `${Math.round(config.opacity * 100)}%`;
      overlay.style.setProperty('--g-sub-opacity', config.opacity);
      saveConfig(false, ['opacity']);
    });
    blurSlider.addEventListener('input', () => {
      config.blur = parseInt(blurSlider.value, 10);
      blurVal.textContent = `${config.blur}px`;
      overlay.style.setProperty('--g-sub-blur', `${config.blur}px`);
      saveConfig(false, ['blur']);
    });
    fontSizeSlider.addEventListener('input', () => {
      config.fontSize = parseInt(fontSizeSlider.value, 10);
      fontSizeVal.textContent = `${config.fontSize}px`;
      overlay.style.setProperty('--g-sub-font-size', `${config.fontSize}px`);
      saveConfig(false, ['fontSize']);
    });
    displayModeSelect.addEventListener('change', () => {
      if (!checkExtensionContextHealth()) return;
      config.displayMode = displayModeSelect.value;
      applyDisplayMode();
      saveConfig(true, ['displayMode']);
    });

    if (btnCopyAll) {
      let copyBtnTimer = null;
      btnCopyAll.addEventListener('click', async () => {
        const mode = config.displayMode || 'bilingual';
        const rows = [];
        const entries = subBody.querySelectorAll('.g-sub-entry');
        entries.forEach((entry) => {
          if (entry.id === 'gSubInitialPrompt') return;
          const orig = entry._origText ? entry._origText.nodeValue.trim() : '';
          const trans = entry._transText ? entry._transText.nodeValue.trim() : '';
          if (trans === '…' && !orig) return;
          if (mode === 'orig') {
            if (orig) rows.push(orig);
          } else if (mode === 'trans') {
            if (trans && trans !== '…') rows.push(trans);
          } else {
            if (orig && trans && trans !== '…' && !entry._echoSame) rows.push(`${orig}\n${trans}`);
            else if (trans && trans !== '…') rows.push(trans);
            else if (orig) rows.push(orig);
          }
        });

        const content = rows.join('\n\n');
        if (!content) {
          if (copyBtnTimer) clearTimeout(copyBtnTimer);
          setActionBtnContent(btnCopyAll, UI_ICONS.copy, '暂无可复制字幕');
          copyBtnTimer = setTimeout(() => { setActionBtnContent(btnCopyAll, UI_ICONS.copy, '复制字幕'); }, 1400);
          return;
        }

        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(content);
            copied = true;
          }
        } catch (e) {}

        if (!copied) {
          try {
            const ta = document.createElement('textarea');
            ta.value = content;
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            copied = document.execCommand('copy');
            ta.remove();
          } catch (e) {}
        }

        if (copyBtnTimer) clearTimeout(copyBtnTimer);
        if (copied) {
          setActionBtnContent(btnCopyAll, UI_ICONS.check, `已复制 (${rows.length} 条)`);
        } else {
          setActionBtnContent(btnCopyAll, UI_ICONS.warn, '复制失败');
        }
        copyBtnTimer = setTimeout(() => { setActionBtnContent(btnCopyAll, UI_ICONS.copy, '复制字幕'); }, 1600);
      });
    }

    if (btnResetStyle) {
      btnResetStyle.addEventListener('click', () => {
        if (!checkExtensionContextHealth()) return;
        config.opacity = DEFAULT_CONFIG.opacity;
        config.blur = DEFAULT_CONFIG.blur;
        config.fontSize = DEFAULT_CONFIG.fontSize;
        config.displayMode = DEFAULT_CONFIG.displayMode;
        config.width = DEFAULT_CONFIG.width;
        config.height = DEFAULT_CONFIG.height;
        config.pos = null;
        delete config.posRatio;
        applyInitialStyles();
        saveConfig(true, ['opacity', 'blur', 'fontSize', 'displayMode', 'width', 'height', 'pos', 'posRatio']);
      });
    }
  }

  // ---- 全屏重挂载 / 顶层 Top-Layer / 画中画适配 --------------------------

  function isHostActuallyMounted() {
    if (!hostEl) return false;
    if (hostEl.isConnected === false) return false;
    const p = hostEl.parentNode || hostEl.parentElement;
    if (!p) return false;
    if (p.childNodes) {
      try {
        return Array.prototype.indexOf.call(p.childNodes, hostEl) !== -1;
      } catch (e) {}
    }
    return true;
  }

  function ensureOverlayMounted() {
    if (!isTopFrame || isDestroyed || !hostEl) return;
    const fsElement = getFullscreenElement();
    if (fsElement) {
      if (!isNonContainerFullscreen(fsElement)) {
        if (hostEl.parentElement !== fsElement || !isHostActuallyMounted()) fsElement.appendChild(hostEl);
      } else if (!isHostActuallyMounted() || hostEl.parentElement === fsElement) {
        if (document.body) document.body.appendChild(hostEl);
        else if (document.documentElement) document.documentElement.appendChild(hostEl);
      }
      if (overlay && overlay.style.display !== 'none' && overlay.style.display !== '') {
        showHostInTopLayer();
      }
      return;
    }
    if (!isHostActuallyMounted()) {
      if (document.body) {
        document.body.appendChild(hostEl);
      } else if (document.documentElement) {
        document.documentElement.appendChild(hostEl);
      }
      if (overlay && overlay.style.display !== 'none' && overlay.style.display !== '') {
        scheduleEnsureOverlayInViewport();
      }
    }
  }

  function handleFullscreenChange() {
    if (isDestroyed || !isTopFrame || !hostEl) return;
    const fsElement = getFullscreenElement();
    const isOverlayShown = !!(overlay && overlay.style.display !== 'none' && overlay.style.display !== '');
    if (fsElement) {
      if (!isNonContainerFullscreen(fsElement)) {
        if (hostEl.parentElement !== fsElement) fsElement.appendChild(hostEl);
      } else if (!isHostActuallyMounted() || hostEl.parentElement === fsElement) {
        if (document.body) document.body.appendChild(hostEl);
        else if (document.documentElement) document.documentElement.appendChild(hostEl);
      }
      if (isOverlayShown) showHostInTopLayer();
    } else {
      hideHostFromTopLayer();
      if (document.body && (hostEl.parentElement !== document.body || !isHostActuallyMounted())) {
        document.body.appendChild(hostEl);
      } else if (!document.body && !isHostActuallyMounted() && document.documentElement) {
        document.documentElement.appendChild(hostEl);
      }
    }
    scheduleEnsureOverlayInViewport();
  }

  function onEnterPiP(e) {
    if (isDestroyed || !isTopFrame) return;
    const target = (e && e.target) || (typeof document !== 'undefined' ? document.pictureInPictureElement : null) || currentBoundVideo;
    activePiPVideo = target || null;
    if (hostEl) hostEl.dataset.gltPip = 'video';
    if (
      isRunning &&
      config.audioMode === 'video' &&
      !tabCaptureActive &&
      !tabCapturePending &&
      audioSourceKind !== 'tab-capture' &&
      target &&
      target !== currentBoundVideo &&
      !target.paused &&
      !target.ended &&
      !target.muted &&
      target.volume > 0 &&
      !isTopFailedMedia(target)
    ) {
      rebindActiveVideo(target);
    }
    updateActiveRunningStatus();
  }

  function onLeavePiP(e) {
    if (isDestroyed || !isTopFrame) return;
    if (!e || !e.target || e.target === activePiPVideo) {
      activePiPVideo = null;
    }
    if (hostEl) hostEl.dataset.gltPip = activeDocPiPWindow ? 'document' : 'false';
    updateActiveRunningStatus();
    if (typeof runDomMediaCheck === 'function') runDomMediaCheck();
  }

  function onDocPiPEnter(e) {
    if (isDestroyed || !isTopFrame) return;
    const pipWin = e && e.window ? e.window : null;
    activeDocPiPWindow = pipWin;
    if (hostEl) hostEl.dataset.gltPip = pipWin ? 'document' : (activePiPVideo ? 'video' : 'false');
    if (pipWin && typeof pipWin.addEventListener === 'function') {
      if (docPiPPageHideTarget && onDocPiPWindowPageHide) {
        try { docPiPPageHideTarget.removeEventListener('pagehide', onDocPiPWindowPageHide); } catch (err) {}
      }
      docPiPPageHideTarget = pipWin;
      onDocPiPWindowPageHide = () => {
        if (activeDocPiPWindow === pipWin) activeDocPiPWindow = null;
        if (docPiPPageHideTarget === pipWin) docPiPPageHideTarget = null;
        if (hostEl) hostEl.dataset.gltPip = activePiPVideo ? 'video' : 'false';
        updateActiveRunningStatus();
        if (typeof runDomMediaCheck === 'function') runDomMediaCheck();
      };
      pipWin.addEventListener('pagehide', onDocPiPWindowPageHide);
    }
    updateActiveRunningStatus();
    if (typeof runDomMediaCheck === 'function') runDomMediaCheck();
  }

  if (isTopFrame) {
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    document.addEventListener('enterpictureinpicture', onEnterPiP, true);
    document.addEventListener('leavepictureinpicture', onLeavePiP, true);
    if (typeof window !== 'undefined' && window.documentPictureInPicture && typeof window.documentPictureInPicture.addEventListener === 'function') {
      docPiPRef = window.documentPictureInPicture;
      docPiPRef.addEventListener('enter', onDocPiPEnter);
    }
  }

  // ========================================================================
  // 5. 字幕引擎
  // ========================================================================

  const TERMINAL_PUNCT_RE = /[。！？!?…\n]$/;
  const CLAUSE_PUNCT_RE = /[，,；;：:—]\s*$/;
  const CJK_INNER_SPACE_RE = /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff。、！？「」『』（）【】《》，；：])[ \t]+(?=[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff。、！？「」『』（）【】《》，；：])/g;
  let lastTransTerminalAt = 0;

  function normalizeForEchoCompare(s) {
    return String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
  }

  function isEchoDuplicate(orig, trans) {
    const o = orig.trim();
    const t = trans.trim();
    if (!o || !t) return false;
    if (o === t) return true;
    const no = normalizeForEchoCompare(o);
    const nt = normalizeForEchoCompare(t);
    return no.length > 0 && no === nt;
  }

  function clearSubtitleBody() {
    cancelPendingScroll();
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    isUserScrolledUp = false;
    scrollBottomBtn.style.display = 'none';
    const promptMsg = isContextInvalidated
      ? '扩展已更新或重载，请刷新页面后继续使用'
      : (!isRunning ? '（已清屏，点击播放按钮继续同传）' : '（已清屏，正在监听音轨…）');
    subBody.innerHTML = `
      <div class="g-sub-entry" id="gSubInitialPrompt">
        <div class="g-sub-trans" style="font-size: 14px; color: #64748b;">${escapeHtml(promptMsg)}</div>
      </div>
    `;
    currentStreamingEntry = null;
    currentOrigBuffer = '';
    currentTransBuffer = '';
    committedLines = 0;
    resetDetectedSourceLangBadge();
    setDiagnostics({ Lines: 0 });
    subBody.scrollTop = 0;
  }

  function ensureStreamingEntry() {
    const initPrompt = overlay.querySelector('#gSubInitialPrompt');
    if (initPrompt) initPrompt.remove();

    if (!currentStreamingEntry) {
      const entry = document.createElement('div');
      entry.className = 'g-sub-entry streaming';

      const origEl = document.createElement('div');
      origEl.className = 'g-sub-orig';
      const origTextNode = document.createTextNode('');
      origEl.appendChild(origTextNode);

      const transEl = document.createElement('div');
      transEl.className = 'g-sub-trans';
      const transTextNode = document.createTextNode('…');
      transEl.appendChild(transTextNode);

      entry.appendChild(origEl);
      entry.appendChild(transEl);

      entry._origEl = origEl;
      entry._origText = origTextNode;
      entry._transEl = transEl;
      entry._transText = transTextNode;
      entry._echoSame = false;

      subBody.appendChild(entry);
      currentStreamingEntry = entry;
      applyDisplayModeToEntry(entry);
    }
    return currentStreamingEntry;
  }

  function renderStreamingLine() {
    const entry = ensureStreamingEntry();
    const mode = config.displayMode || 'bilingual';
    const origDisplay = currentOrigBuffer.trimStart();
    const transDisplay = currentTransBuffer.trimStart();

    entry._origText.nodeValue = origDisplay;
    entry._transText.nodeValue = transDisplay || '…';

    if (mode !== 'trans') {
      entry._origEl.style.display = origDisplay ? '' : 'none';
    } else {
      entry._origEl.style.display = 'none';
    }

    if (mode !== 'orig') {
      entry._transEl.style.display = '';
    } else {
      entry._transEl.style.display = 'none';
    }
    safeScrollToBottom();
  }

  function scheduleCommit(reason, delay) {
    pendingCommitReason = reason;
    if (commitGraceTimer) clearTimeout(commitGraceTimer);
    commitGraceTimer = setTimeout(() => {
      commitGraceTimer = null;
      commitCurrentLine(false, pendingCommitReason || reason);
    }, Math.max(0, delay || 0));
  }

  function pruneOldSubtitleEntries() {
    const limit = isUserScrolledUp ? SUBTITLE_SCROLLED_UP_CAP : SUBTITLE_MAX_HISTORY;
    while (subBody.children.length > limit) {
      const first = subBody.firstChild;
      if (!first || first === currentStreamingEntry) break;
      const removedHeight = isUserScrolledUp ? (first.offsetHeight + 11) : 0;
      subBody.removeChild(first);
      if (isUserScrolledUp && removedHeight > 0) {
        subBody.scrollTop = Math.max(0, subBody.scrollTop - removedHeight);
      }
    }
  }

  function commitCurrentLine(force, reason) {
    if (commitGraceTimer) {
      clearTimeout(commitGraceTimer);
      commitGraceTimer = null;
    }
    const origTrimmed = currentOrigBuffer.trim();
    const transTrimmed = currentTransBuffer.trim();
    const hasOrig = !!origTrimmed;
    const hasTrans = !!transTrimmed;

    if (!hasOrig && !hasTrans) {
      if (currentStreamingEntry) {
        if (!force && !currentTransBuffer) currentStreamingEntry.remove();
        currentStreamingEntry = null;
      }
      return;
    }
    if (!force && !hasTrans && !(config.displayMode === 'orig' && hasOrig)) return; // 尚无译文，留在流式行等待配对

    const entry = currentStreamingEntry;
    if (entry) {
      entry.classList.remove('streaming');
      if (entry._origText) entry._origText.nodeValue = origTrimmed;
      if (entry._transText) entry._transText.nodeValue = transTrimmed;
      entry._echoSame = isEchoDuplicate(origTrimmed, transTrimmed);
      applyDisplayModeToEntry(entry);
      currentStreamingEntry = null;
    }

    currentOrigBuffer = '';
    currentTransBuffer = '';
    lastTransTerminalAt = 0;
    committedLines++;
    setDiagnostics({ Lines: committedLines, LastCommitReason: reason || 'auto', LastCommitAt: now() });

    pruneOldSubtitleEntries();
    safeScrollToBottom();
  }

  function bufferEndsWithTerminal(buffer) {
    const s = String(buffer || '').replace(/[\s"'”’）)\]】」』]+$/g, '');
    return TERMINAL_PUNCT_RE.test(s);
  }

  function onOriginalDelta(text) {
    if (!text) return;
    // 跳过缓冲区为空时的纯空白分片，避免静音期产生空流式条或冲掉待提交定时器
    if (!text.trim() && !currentOrigBuffer.trim()) return;
    const tNow = now();
    // 若上一句已有原文且译文已带句末标点，停顿超过 220ms 后到达的新词视为下一句开头，先结清上一句
    if (
      currentOrigBuffer.trim().length >= 2 &&
      currentTransBuffer &&
      bufferEndsWithTerminal(currentTransBuffer) &&
      lastTransTerminalAt > 0 &&
      (tNow - lastTransTerminalAt) > 220 &&
      !/^[。、！？!?….\s]+$/.test(text)
    ) {
      commitCurrentLine(false, 'punctuation-orig-next');
    }
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    lastTranscriptionAt = tNow;
    lastServerMessageAt = tNow;
    currentOrigBuffer = (currentOrigBuffer + text).replace(CJK_INNER_SPACE_RE, '$1');
    renderStreamingLine();

    if (String(config.sourceLang || '').includes('自动识别')) {
      const lang = detectLanguageFromText(currentOrigBuffer);
      if (lang !== 'auto' && lang !== detectedSourceLang) {
        detectedSourceLang = lang;
        const langMap = { ja: '日语', en: '英语', ko: '韩语', zh: '中文' };
        const optAuto = srcLangSelect.querySelector('option[value*="自动识别"]');
        if (optAuto) optAuto.textContent = `自动 (${langMap[lang] || '多语言'})`;
        if (typeof srcLangSelect._syncUI === 'function') srcLangSelect._syncUI();
        setDiagnostics({ SrcLang: lang });
      }
    }
    maybeCommitByBoundary();
  }

  function onTranslationDelta(text) {
    if (!text) return;
    if (!text.trim() && !currentTransBuffer.trim()) return;
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    // 若上一句译文已带句末标点，新译文分片到达说明下一句已开始：先把上一句落成独立字幕卡
    if (currentTransBuffer && bufferEndsWithTerminal(currentTransBuffer)) {
      commitCurrentLine(false, 'punctuation-next');
    }
    lastTranscriptionAt = now();
    lastServerMessageAt = lastTranscriptionAt;
    currentTransBuffer = (currentTransBuffer + text).replace(CJK_INNER_SPACE_RE, '$1');
    if (bufferEndsWithTerminal(currentTransBuffer)) {
      if (!lastTransTerminalAt) lastTransTerminalAt = lastTranscriptionAt;
    } else {
      lastTransTerminalAt = 0;
    }
    renderStreamingLine();
    maybeCommitByBoundary();
    setDiagnostics({ LastTransAt: lastTranscriptionAt });
  }

  function maybeCommitByBoundary() {
    const mode = config.displayMode || 'bilingual';
    const trans = currentTransBuffer.trim();
    const orig = currentOrigBuffer.trim();

    // 仅原文模式：按原文标点或长度断句
    if (mode === 'orig') {
      if (!orig) return;
      if (bufferEndsWithTerminal(currentOrigBuffer)) { commitCurrentLine(false, 'punctuation'); return; }
      if (orig.length >= 56 && CLAUSE_PUNCT_RE.test(currentOrigBuffer)) { commitCurrentLine(false, 'clause-length'); return; }
      if (orig.length >= 88) commitCurrentLine(false, 'max-length');
      return;
    }

    if (!trans) return;
    if (trans.length >= 86) { commitCurrentLine(false, 'max-length'); return; }
    if (trans.length >= 54 && CLAUSE_PUNCT_RE.test(currentTransBuffer) && (mode === 'trans' || orig.length > 0)) {
      commitCurrentLine(false, 'clause-length');
      return;
    }

    const transEnded = bufferEndsWithTerminal(currentTransBuffer);
    if (!transEnded) return;

    // 仅译文模式：译文本句结束即刻提交
    if (mode === 'trans') { commitCurrentLine(false, 'punctuation'); return; }

    // 双语模式：实测译文有时领先原文约 50ms 到达；若此刻原文尚未到达，短暂等待 320ms 让同句原文归位到同一字幕卡，防止错位到下一句
    if (!orig) {
      scheduleCommit('punctuation-wait-orig', 320);
      return;
    }

    if (!bufferEndsWithTerminal(currentOrigBuffer)) {
      if (trans.length >= 12) { commitCurrentLine(false, 'punctuation-trans-only'); return; }
      scheduleCommit('punctuation-wait-orig', 350);
      return;
    }
    commitCurrentLine(false, 'punctuation');
  }

  // 静音断句：转写流停止一段时间后提交当前行
  function startSilenceFlushTimer() {
    if (silenceFlushTimer) clearInterval(silenceFlushTimer);
    silenceFlushTimer = setInterval(() => {
      if (!isRunning) return;
      const idle = now() - lastTranscriptionAt;
      if (idle > 1500 && (currentTransBuffer.trim() || currentOrigBuffer.trim())) {
        const trans = currentTransBuffer.trim();
        const orig = currentOrigBuffer.trim();
        if (trans.length >= 2) commitCurrentLine(false, 'silence');
        else if (!trans && orig.length >= 2 && idle > 3800) commitCurrentLine(true, 'silence-orig-only');
      }
      // 静止过久：清理空占位行
      if (idle > 25000 && currentStreamingEntry && !currentOrigBuffer.trim() && !currentTransBuffer.trim()) {
        currentStreamingEntry.remove();
        currentStreamingEntry = null;
      }
    }, 500);
  }

  // ========================================================================
  // 6. 音频引擎
  // ========================================================================

  function isInsideExtensionHost(el) {
    if (!hostEl || !el) return false;
    if (el === hostEl) return true;
    try {
      return typeof hostEl.contains === 'function' && hostEl.contains(el);
    } catch (e) {
      return false;
    }
  }

  function isMediaStreamLike(obj) {
    return !!(obj && typeof obj.getAudioTracks === 'function');
  }

  function hasLiveAudioTrack(stream) {
    if (!isMediaStreamLike(stream)) return false;
    try {
      const tracks = stream.getAudioTracks();
      if (!tracks || !tracks.length) return false;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t.readyState || t.readyState === 'live') return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function isMediaElementNode(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toUpperCase();
    return tag === 'VIDEO' || tag === 'AUDIO';
  }

  function ensureShadowRootListeners(sr) {
    if (!sr || sr === shadowRoot || observedShadowRoots.has(sr)) return;
    if (typeof sr.addEventListener !== 'function') return;
    observedShadowRoots.add(sr);
    sr.addEventListener('play', onDocumentVideoPlay, true);
    sr.addEventListener('volumechange', onDocumentVideoVolumeChange, true);
    shadowRootPlayTargets.push(sr);
  }

  function observeAccessibleDocument(doc) {
    if (!doc || doc === document || observedSubDocs.has(doc)) return;
    if (typeof doc.addEventListener !== 'function') return;
    observedSubDocs.add(doc);
    doc.addEventListener('play', onDocumentVideoPlay, true);
    doc.addEventListener('volumechange', onDocumentVideoVolumeChange, true);
    subDocPlayTargets.push(doc);
  }

  function onIframeLoad() {
    if (isDestroyed) return;
    if (typeof scheduleDomMediaCheck === 'function') scheduleDomMediaCheck();
    if (typeof scheduleMediaReconcile === 'function') scheduleMediaReconcile();
  }

  function observeIframeLoad(iframeEl) {
    if (!iframeEl || observedIframes.has(iframeEl) || typeof iframeEl.addEventListener !== 'function') return;
    observedIframes.add(iframeEl);
    iframeEl.addEventListener('load', onIframeLoad);
    iframeLoadTargets.push(iframeEl);
  }

  function addMediaIfUnique(el, state) {
    if (!el || isInsideExtensionHost(el) || state.seenElements.has(el)) return;
    state.seenElements.add(el);
    state.results.push(el);
  }

  function inspectNodeForSubtreesAndMedia(el, state, shadowDepth, iframeDepth) {
    if (!el || isInsideExtensionHost(el)) return;
    const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      addMediaIfUnique(el, state);
    }
    if (el.shadowRoot && el.shadowRoot !== shadowRoot) {
      ensureShadowRootListeners(el.shadowRoot);
      collectMediaInRoot(el.shadowRoot, state, shadowDepth + 1, iframeDepth);
    }
    if (tag === 'IFRAME' || tag === 'FRAME') {
      observeIframeLoad(el);
      let frameDoc = null;
      try {
        frameDoc = el.contentDocument || (el.contentWindow && el.contentWindow.document) || null;
      } catch (e) {
        frameDoc = null;
      }
      if (frameDoc && !state.visitedDocs.has(frameDoc)) {
        state.visitedDocs.add(frameDoc);
        observeAccessibleDocument(frameDoc);
        const frameRoot = frameDoc.documentElement || frameDoc.body || frameDoc;
        collectMediaInRoot(frameRoot, state, 0, iframeDepth + 1);
      }
    }
  }

  function collectMediaInRoot(root, state, shadowDepth, iframeDepth) {
    if (!root || shadowDepth > 16 || iframeDepth > 6 || state.visitedRoots.has(root)) return;
    state.visitedRoots.add(root);

    // 分别查询 video 与 audio，避免逗号选择器在精简 DOM 模拟器下匹配失败
    if (typeof root.querySelectorAll === 'function') {
      try {
        const videos = root.querySelectorAll('video');
        for (let i = 0; i < videos.length; i++) addMediaIfUnique(videos[i], state);
      } catch (e) {}
      try {
        const audios = root.querySelectorAll('audio');
        for (let i = 0; i < audios.length; i++) addMediaIfUnique(audios[i], state);
      } catch (e) {}
    }

    let walkedWithTreeWalker = false;
    if (typeof document !== 'undefined' && typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
          acceptNode: (node) => (node === hostEl ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
        });
        walkedWithTreeWalker = true;
        let cur = walker.nextNode();
        while (cur) {
          inspectNodeForSubtreesAndMedia(cur, state, shadowDepth, iframeDepth);
          cur = walker.nextNode();
        }
      } catch (e) {
        walkedWithTreeWalker = false;
      }
    }

    if (!walkedWithTreeWalker && typeof root.querySelectorAll === 'function') {
      try {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          inspectNodeForSubtreesAndMedia(all[i], state, shadowDepth, iframeDepth);
        }
      } catch (e) {}
    }
  }

  function collectCandidateMedia() {
    const state = {
      results: [],
      seenElements: new WeakSet(),
      visitedRoots: new WeakSet(),
      visitedDocs: new WeakSet()
    };
    if (typeof document !== 'undefined') {
      state.visitedDocs.add(document);
      collectMediaInRoot(document, state, 0, 0);
    }
    if (activeDocPiPWindow && !activeDocPiPWindow.closed && activeDocPiPWindow.document) {
      try {
        const pipDoc = activeDocPiPWindow.document;
        if (!state.visitedDocs.has(pipDoc)) {
          state.visitedDocs.add(pipDoc);
          observeAccessibleDocument(pipDoc);
          collectMediaInRoot(pipDoc.documentElement || pipDoc.body || pipDoc, state, 0, 1);
        }
      } catch (e) {}
    }
    return state.results;
  }

  function collectCandidateVideos() {
    return collectCandidateMedia();
  }

  function scoreMediaCandidate(v) {
    if (!v || v.isConnected === false) return -Infinity;
    if (!isTopFrame && isSubframeMediaFailed(v)) return -Infinity;
    if (isTopFrame && isTopFailedMedia(v)) return -Infinity;
    let score = 0;
    if (!v.paused && !v.ended) score += 100;
    if (!v.muted && v.volume > 0) score += 80;
    else score -= 50;

    const hasSrcObj = isMediaStreamLike(v.srcObject);
    const hasLiveSrcObjAudio = hasLiveAudioTrack(v.srcObject);
    if (hasLiveSrcObjAudio) score += 35;
    if (hasSrcObj && !hasLiveSrcObjAudio) score -= 120;
    else if (v.currentTime > 0 || v.readyState >= 2 || hasLiveSrcObjAudio) score += 20;
    else if (v.readyState === 0 && !hasSrcObj && !v.currentSrc && !v.src) score -= 80;

    const isPiP = (typeof document !== 'undefined' && document.pictureInPictureElement === v) ||
      v === activePiPVideo ||
      (activeDocPiPWindow && !activeDocPiPWindow.closed && v.ownerDocument === activeDocPiPWindow.document);
    if (isPiP) score += 80;

    let cssHidden = !!v.hidden;
    try {
      if (typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(v);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0)) {
          cssHidden = true;
        }
      }
    } catch (e) {}

    const tag = v.tagName ? String(v.tagName).toUpperCase() : '';
    if (tag === 'VIDEO' && !isPiP) {
      try {
        const rect = v.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (!cssHidden && rect.width >= 200 && rect.height >= 120) {
          score += 30 + Math.min(25, area / 50000);
        } else if (cssHidden || rect.width < 10 || rect.height < 10) {
          score -= 30;
        }
      } catch (e) {
        if (cssHidden) score -= 30;
      }
    }
    return score;
  }

  function scoreVideoCandidate(v) {
    return scoreMediaCandidate(v);
  }

  function findActiveMedia() {
    const media = collectCandidateMedia();
    if (media.length === 0) return null;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < media.length; i++) {
      if (!isTopFrame && isSubframeMediaFailed(media[i])) continue;
      if (isTopFrame && isTopFailedMedia(media[i])) continue;
      const s = scoreMediaCandidate(media[i]);
      if (s > bestScore) {
        bestScore = s;
        best = media[i];
      }
    }
    return best;
  }

  function findActiveVideo() {
    return findActiveMedia();
  }

  function collectMixableMedia(candidates) {
    const list = candidates || collectCandidateMedia();
    const mixable = [];
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el || el.isConnected === false || el.paused || el.ended || el.muted || el.volume === 0) continue;
      if (!isTopFrame && isSubframeMediaFailed(el)) continue;
      if (isTopFrame && isTopFailedMedia(el)) continue;
      const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
      if (isMediaStreamLike(el.srcObject)) {
        if (hasLiveAudioTrack(el.srcObject)) {
          mixable.push(el);
        }
      } else if (tag === 'AUDIO') {
        mixable.push(el);
      }
    }
    return mixable;
  }

  function ensureAudioContext() {
    if (!persistentAudioCtx || persistentAudioCtx.state === 'closed') {
      persistentAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (persistentAudioCtx.state === 'suspended') {
      persistentAudioCtx.resume().catch(() => {});
    }
    return persistentAudioCtx;
  }

  function stopOwnedCaptureStream() {
    if (!videoCaptureStream) return;
    try {
      videoCaptureStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) {}
      });
    } catch (e) {}
    videoCaptureStream = null;
  }

  function getOrCreateAudioGraph(video, options) {
    const opts = options || {};
    const trackOwnedGlobally = opts.trackOwnedGlobally !== false;
    const ctx = ensureAudioContext();

    if (isMediaStreamLike(video.srcObject)) {
      const stream = video.srcObject;
      const audioTracks = stream.getAudioTracks();
      if (audioTracks && audioTracks.length > 0) {
        let cachedStream = streamSourceCache.get(stream);
        if (!cachedStream || cachedStream.audioCtx !== ctx || !cachedStream.sourceNode) {
          const streamSource = ctx.createMediaStreamSource(stream);
          cachedStream = { audioCtx: ctx, sourceNode: streamSource };
          streamSourceCache.set(stream, cachedStream);
        }
        // WebRTC srcObject 由宿主原生输出，绝不连接 ctx.destination 也绝不停止其轨道
        return { audioCtx: ctx, sourceNode: cachedStream.sourceNode, kind: 'src-object-stream', srcObject: stream, ownedStream: null };
      }
      throw makeRetryableError('等待音轨就绪…', 'NO_AUDIO_TRACKS');
    }

    const cached = mediaSourceCache.get(video);
    if (cached && cached.audioCtx === ctx && cached.sourceNode) {
      return { audioCtx: ctx, sourceNode: cached.sourceNode, kind: 'video-element', ownedStream: null };
    }
    try {
      const sourceNode = ctx.createMediaElementSource(video);
      // 保持原声直通，确保网页视频正常发声且永不断开此直通分支
      sourceNode.connect(ctx.destination);
      mediaSourceCache.set(video, { audioCtx: ctx, sourceNode });
      return { audioCtx: ctx, sourceNode, kind: 'video-element', ownedStream: null };
    } catch (err) {
      // 兼容宿主页面自身已通过 AudioContext 绑定过该 <video>（防止 InvalidStateError 导致启动失败）
      const captureFn = video.captureStream || video.mozCaptureStream;
      if (typeof captureFn === 'function') {
        const stream = captureFn.call(video);
        const audioTracks = stream ? stream.getAudioTracks() : [];
        if (audioTracks.length > 0) {
          if (trackOwnedGlobally) {
            stopOwnedCaptureStream();
            videoCaptureStream = stream;
          }
          const streamSource = ctx.createMediaStreamSource(stream);
          return { audioCtx: ctx, sourceNode: streamSource, kind: 'video-stream', ownedStream: stream };
        }
      }
      throw err;
    }
  }

  let lastAudioBlockAt = 0;
  function resetCorsSilenceTracker() {
    zeroPcmSilentSince = 0;
    hasObservedAudioBlock = false;
    lastAudioBlockAt = 0;
    lastAudioBlockMaxAbs = 1;
    lastObservedMediaEl = null;
    lastObservedMediaTime = -1;
    lastMediaTimeAdvancedAt = 0;
    if (corsSilenceDetected) {
      corsSilenceDetected = false;
      setDiagnostics({ CorsSilence: 'false' });
    }
  }

  function isMediaInputGated() {
    if (config.audioMode !== 'video') return false;
    if (audioSourceKind === 'tab-capture') return false;
    if (audioSourceKind === 'subframe-relay') return !!(subframeRelayPaused || subframeRelayMuted);
    if (activeMixEntries.size > 0) {
      let hasAnyAudible = false;
      activeMixEntries.forEach((entry) => {
        const el = entry.el;
        if (el && el.isConnected !== false && !el.paused && !el.ended && !el.muted && el.volume > 0) {
          hasAnyAudible = true;
        }
      });
      return !hasAnyAudible;
    }
    if (isVideoPaused) return true;
    if (!currentBoundVideo) return true;
    return !!(currentBoundVideo.paused || currentBoundVideo.ended || currentBoundVideo.muted || currentBoundVideo.volume === 0);
  }

  function onMediaGatedTransition(gated) {
    if (gated) {
      if (!wasAudioInputGated) {
        wasAudioInputGated = true;
        silenceGateChunksRemaining = PAUSE_FLUSH_CHUNKS;
        mediaPauseStartedAt = now();
      }
      return;
    }
    if (wasAudioInputGated) {
      const tNow = now();
      const pausedMs = mediaPauseStartedAt > 0 ? Math.max(0, tNow - mediaPauseStartedAt) : 0;
      if (activeSession && pausedMs > 0) {
        const shiftAnchor = (ts) => (ts > 0 ? Math.min(tNow, ts + pausedMs) : 0);
        activeSession.lastServerMsgAt = shiftAnchor(activeSession.lastServerMsgAt);
        activeSession.lastTranscriptionAt = shiftAnchor(activeSession.lastTranscriptionAt);
        activeSession.readyAt = shiftAnchor(activeSession.readyAt);
        activeSession.lastOrigAt = shiftAnchor(activeSession.lastOrigAt);
        activeSession.firstOrigSinceOutAt = shiftAnchor(activeSession.firstOrigSinceOutAt);
        activeSession.lastOutAt = shiftAnchor(activeSession.lastOutAt);
      }
      if (pausedMs > 0) {
        if (lastTranscriptionAt > 0) lastTranscriptionAt = Math.min(tNow, lastTranscriptionAt + pausedMs);
        if (lastServerMessageAt > 0) lastServerMessageAt = Math.min(tNow, lastServerMessageAt + pausedMs);
      }
      lastAudioSentAt = tNow;
      wasAudioInputGated = false;
      silenceGateChunksRemaining = 0;
      mediaPauseStartedAt = 0;
      resetResampler(audioCtx ? audioCtx.sampleRate : 48000);
    }
  }

  function onVideoSeeking() {
    zeroPcmSilentSince = 0;
    if (isRunning) commitCurrentLine(true, 'seek');
  }

  function onVideoPause() {
    zeroPcmSilentSince = 0;
    if (activeMixEntries.size > 0) {
      onMediaGatedTransition(isMediaInputGated());
      if (!isTopFrame && subframeCaptureActive) {
        emitSubframeMediaState();
      }
      scheduleMediaReconcile();
      return;
    }
    isVideoPaused = true;
    onMediaGatedTransition(true);
    if (!isTopFrame && subframeCaptureActive) {
      emitSubframeMediaState();
      scheduleMediaReconcile();
      return;
    }
    if (isRunning) {
      commitCurrentLine(true, 'pause');
      if (!isConnectingUI) setStatus('info', '视频已暂停（会话保持）', 'pauseCircle');
      if (isTopFrame) scheduleMediaReconcile();
    }
  }

  function onVideoPlay() {
    isVideoPaused = false;
    if (!isTopFrame && subframeCaptureActive) {
      onMediaGatedTransition(isMediaInputGated());
      ensureAudioContext().resume().catch(() => {});
      emitSubframeMediaState();
      return;
    }
    if (!isRunning) return;
    onMediaGatedTransition(isMediaInputGated());
    ensureAudioContext().resume().catch(() => {});
    updateActiveRunningStatus();
    scheduleMediaReconcile();
  }

  function onVideoVolumeChange() {
    if (!isTopFrame && subframeCaptureActive) {
      onMediaGatedTransition(isMediaInputGated());
      emitSubframeMediaState();
      scheduleMediaReconcile();
      return;
    }
    if (!isRunning || config.audioMode !== 'video') return;
    onMediaGatedTransition(isMediaInputGated());
    if (!isConnectingUI) updateActiveRunningStatus();
    scheduleMediaReconcile();
  }

  function updateActiveRunningStatus() {
    if (!isTopFrame || !isRunning || isConnectingUI) return;
    if (isNetworkOffline) {
      setStatus('warn', '网络已断开，等待恢复…', 'warn');
      return;
    }
    if (config.audioMode === 'video') {
      if (tabCaptureActive && audioSourceKind === 'tab-capture') {
        if (activeSession && activeSession.state === 'ready') {
          setStatus('ok', '标签页音频捕获 · 正在同传', 'waveform');
        }
        return;
      }
      if (audioSourceKind === 'subframe-relay') {
        if (subframeRelayPaused) {
          setStatus('info', '视频已暂停（会话保持）', 'pauseCircle');
          return;
        }
        if (subframeRelayMuted) {
          setStatus('warn', '视频当前已静音（取消静音后恢复同传）', 'muted');
          return;
        }
      } else if (corsSilenceDetected) {
        setStatus('warn', '检测到播放无音频信号（可能受跨域或独立音频引擎限制），请点击扩展图标后重试或切换麦克风', 'muted');
        return;
      } else if (activeMixEntries.size > 0) {
        if (isMediaInputGated()) {
          setStatus('warn', '视频当前已静音（取消静音后恢复同传）', 'muted');
          return;
        }
      } else if (activeMixEntries.size === 0 && currentBoundVideo) {
        if (currentBoundVideo.paused) {
          setStatus('info', '视频已暂停（会话保持）', 'pauseCircle');
          return;
        }
        if (currentBoundVideo.muted || currentBoundVideo.volume === 0) {
          setStatus('warn', '视频当前已静音（取消静音后恢复同传）', 'muted');
          return;
        }
      }
      if (!audioPipelineReady) {
        if (tabCaptureFailedInSession && hasTopCorsOrSecurityBlockedMedia()) {
          setStatus('warn', '无法自动捕获跨源音频，请点击扩展图标后重试或切换麦克风', 'warn');
          return;
        }
        if (videoWaitTimer) {
          setStatus('info', '等待视频开始播放…（播放后自动开始同传）', 'clock');
          return;
        }
        if (tabCaptureFailedInSession) {
          setStatus('warn', '无法自动捕获跨源音频，请点击扩展图标后重试或切换麦克风', 'warn');
          return;
        }
        return;
      }
    }
    if (activeSession && activeSession.state === 'ready') {
      const hasPiP = !!(activePiPVideo || activeDocPiPWindow || (typeof document !== 'undefined' && document.pictureInPictureElement));
      if (hasPiP) {
        setStatus('ok', '画中画模式 · 正在同传', 'waveform');
      } else {
        setStatus('ok', '正在同传', 'waveform');
      }
    }
  }

  function attachVideoListeners(video) {
    if (!video) return;
    video.addEventListener('seeking', onVideoSeeking);
    video.addEventListener('pause', onVideoPause);
    video.addEventListener('play', onVideoPlay);
    video.addEventListener('volumechange', onVideoVolumeChange);
  }

  function detachVideoListeners(video) {
    if (!video) return;
    try {
      video.removeEventListener('seeking', onVideoSeeking);
      video.removeEventListener('pause', onVideoPause);
      video.removeEventListener('play', onVideoPlay);
      video.removeEventListener('volumechange', onVideoVolumeChange);
    } catch (e) {}
  }

  function computeMixEntryGain(el) {
    if (!el || el.paused || el.ended || el.muted || el.volume === 0) return 0;
    const v = Number(el.volume);
    if (!Number.isFinite(v)) return 1;
    return Math.min(1, Math.max(0, v));
  }

  function detachMixEntry(el) {
    const entry = activeMixEntries.get(el);
    if (!entry) return;
    activeMixEntries.delete(el);
    try {
      if (entry.sourceNode && entry.entryGain) entry.sourceNode.disconnect(entry.entryGain);
    } catch (e) {}
    try {
      if (entry.entryGain) entry.entryGain.disconnect();
    } catch (e) {}
    if (entry.ownedStream) {
      try {
        entry.ownedStream.getTracks().forEach((t) => {
          try { t.stop(); } catch (e) {}
        });
      } catch (e) {}
    }
    if (entry.onUpdate && el && typeof el.removeEventListener === 'function') {
      try {
        el.removeEventListener('volumechange', entry.onUpdate);
        el.removeEventListener('play', entry.onUpdate);
        el.removeEventListener('pause', entry.onUpdate);
        el.removeEventListener('ended', entry.onUpdate);
      } catch (e) {}
    }
  }

  function cleanupMixCandidateObservers() {
    Array.from(observedMixCandidates.entries()).forEach(([el, handler]) => {
      try {
        if (el && typeof el.removeEventListener === 'function') {
          el.removeEventListener('volumechange', handler);
          el.removeEventListener('play', handler);
        }
      } catch (e) {}
    });
    observedMixCandidates.clear();
    Array.from(observedCandidateStreams.entries()).forEach(([stream, handler]) => {
      try {
        if (stream && typeof stream.removeEventListener === 'function') {
          stream.removeEventListener('addtrack', handler);
          stream.removeEventListener('removetrack', handler);
        }
      } catch (e) {}
    });
    observedCandidateStreams.clear();
  }

  function syncMixCandidateObservers(candidates) {
    const list = candidates || [];
    const activeSet = new Set();
    const activeStreamSet = new Set();
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el || el.isConnected === false) continue;
      const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
      if (tag === 'AUDIO' || isMediaStreamLike(el.srcObject)) {
        activeSet.add(el);
        if (!observedMixCandidates.has(el) && typeof el.addEventListener === 'function') {
          const onCandidateUpdate = () => {
            if (!isRunning || isDestroyed || config.audioMode !== 'video') return;
            scheduleMediaReconcile();
          };
          el.addEventListener('volumechange', onCandidateUpdate);
          el.addEventListener('play', onCandidateUpdate);
          observedMixCandidates.set(el, onCandidateUpdate);
        }
        if (isMediaStreamLike(el.srcObject)) {
          const stream = el.srcObject;
          activeStreamSet.add(stream);
          if (!observedCandidateStreams.has(stream) && typeof stream.addEventListener === 'function') {
            const onStreamTrackChange = () => {
              if (!isRunning || isDestroyed || config.audioMode !== 'video') return;
              scheduleMediaReconcile();
            };
            stream.addEventListener('addtrack', onStreamTrackChange);
            stream.addEventListener('removetrack', onStreamTrackChange);
            observedCandidateStreams.set(stream, onStreamTrackChange);
          }
        }
      }
    }
    Array.from(observedMixCandidates.entries()).forEach(([el, handler]) => {
      if (!activeSet.has(el)) {
        try {
          if (el && typeof el.removeEventListener === 'function') {
            el.removeEventListener('volumechange', handler);
            el.removeEventListener('play', handler);
          }
        } catch (e) {}
        observedMixCandidates.delete(el);
      }
    });
    Array.from(observedCandidateStreams.entries()).forEach(([stream, handler]) => {
      if (!activeStreamSet.has(stream)) {
        try {
          if (stream && typeof stream.removeEventListener === 'function') {
            stream.removeEventListener('addtrack', handler);
            stream.removeEventListener('removetrack', handler);
          }
        } catch (e) {}
        observedCandidateStreams.delete(stream);
      }
    });
  }

  function isMixRetainableElement(el) {
    if (!el || el.isConnected === false || el.paused || el.ended) return false;
    if (isMediaStreamLike(el.srcObject) && !hasLiveAudioTrack(el.srcObject)) return false;
    return true;
  }

  function collectEffectiveMixMedia(candidates, mixable) {
    const result = (mixable || []).slice();
    const seen = new Set(result);
    if (mixerBus || activeMixEntries.size > 0) {
      activeMixEntries.forEach((_, el) => {
        if (!seen.has(el) && isMixRetainableElement(el)) {
          seen.add(el);
          result.push(el);
        }
      });
    }
    return result;
  }

  function cleanupMixerBusAndEntries() {
    Array.from(activeMixEntries.keys()).forEach((el) => detachMixEntry(el));
    if (mixerBus) {
      try { mixerBus.disconnect(); } catch (e) {}
      mixerBus = null;
    }
    mixerBusConnectedTap = null;
  }

  function syncMixEntries(mixableList) {
    if (!audioCtx || !mixerBus) return { added: 0, failed: 0, lastError: null, lastSecurityError: null, lastNonRetryableError: null };
    const targetSet = new Set(mixableList || []);

    Array.from(activeMixEntries.entries()).forEach(([el, entry]) => {
      if (!targetSet.has(el) || entry.audioCtx !== audioCtx || entry.boundSrcObject !== el.srcObject) {
        detachMixEntry(el);
      }
    });

    let added = 0;
    let failed = 0;
    let lastError = null;
    let lastSecurityError = null;
    let lastNonRetryableError = null;
    for (let i = 0; i < mixableList.length; i++) {
      const el = mixableList[i];
      const existing = activeMixEntries.get(el);
      if (existing) {
        if (existing.entryGain && existing.entryGain.gain) {
          existing.entryGain.gain.value = computeMixEntryGain(el);
        }
        continue;
      }
      try {
        const graph = getOrCreateAudioGraph(el, { trackOwnedGlobally: false });
        if (graph.audioCtx !== audioCtx) continue;
        const entryGain = audioCtx.createGain();
        if (entryGain.gain) entryGain.gain.value = computeMixEntryGain(el);
        graph.sourceNode.connect(entryGain);
        entryGain.connect(mixerBus);
        const onUpdate = () => {
          const cur = activeMixEntries.get(el);
          if (cur && cur.entryGain && cur.entryGain.gain) {
            cur.entryGain.gain.value = computeMixEntryGain(el);
          }
          onMediaGatedTransition(isMediaInputGated());
          if (!isTopFrame && subframeCaptureActive) {
            emitSubframeMediaState();
          }
          scheduleMediaReconcile();
        };
        if (typeof el.addEventListener === 'function') {
          el.addEventListener('volumechange', onUpdate);
          el.addEventListener('play', onUpdate);
          el.addEventListener('pause', onUpdate);
          el.addEventListener('ended', onUpdate);
        }
        activeMixEntries.set(el, {
          el,
          kind: graph.kind,
          sourceNode: graph.sourceNode,
          entryGain,
          boundSrcObject: el.srcObject || null,
          ownedStream: graph.ownedStream || null,
          audioCtx,
          onUpdate
        });
        added++;
      } catch (e) {
        failed++;
        lastError = e || null;
        if (e && e.name === 'SecurityError') {
          if (typeof e === 'object' && !e.failedElement) e.failedElement = el;
          lastSecurityError = e;
          if (isTopFrame) markTopFailedMedia(el);
          else markSubframeMediaFailed(el);
        } else if (!e || !e.retryable) {
          if (e && typeof e === 'object' && !e.failedElement) e.failedElement = el;
          lastNonRetryableError = e || new Error('Audio capture failed');
          if (isTopFrame) markTopFailedMedia(el);
          else markSubframeMediaFailed(el);
        }
      }
    }

    onMediaGatedTransition(isMediaInputGated());
    return { added, failed, lastError, lastSecurityError, lastNonRetryableError };
  }

  function scheduleMediaReconcile() {
    if (!isRunning || isDestroyed || config.audioMode !== 'video') return;
    if (mediaReconcileDebounce) clearTimeout(mediaReconcileDebounce);
    mediaReconcileDebounce = setTimeout(() => {
      mediaReconcileDebounce = null;
      reconcileActiveMedia();
    }, 250);
  }

  function reconcileActiveMedia() {
    if (!isRunning || isDestroyed || config.audioMode !== 'video') return;
    if (audioSourceKind === 'tab-capture' || tabCaptureActive || tabCapturePending) return;
    if (audioSourceKind === 'subframe-relay') {
      if (isTopFrame) {
        const candidates = collectCandidateMedia();
        syncMixCandidateObservers(candidates);
        if (activeSession && activeSession.state === 'ready') {
          const mixable = collectMixableMedia(candidates);
          if (mixable.length >= 2) {
            if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
            commitCurrentLine(true, 'video-switch');
            resetDetectedSourceLangBadge();
            runAudioInitForSession(activeSession, mixable[0], { preserveSessionOnFailure: true });
            return;
          }
        }
      }
      if (isTopFrame && (subframeRelayPaused || subframeRelayMuted)) {
        const nextSubId = findBestReadySubframe();
        if (nextSubId !== null && nextSubId !== activeSubframeId) {
          startSubframeRelay(nextSubId);
          return;
        }
        const nextPlayable = findNextPlayableMedia();
        if (nextPlayable && activeSession && activeSession.state === 'ready') {
          rebindActiveVideo(nextPlayable);
          return;
        }
      }
      return;
    }
    if (!audioPipelineReady || !audioCtx || audioCtx.state === 'closed') {
      if (
        isTopFrame &&
        !currentBoundVideo &&
        audioSourceKind === 'none' &&
        !audioInitInFlight &&
        activeSession &&
        activeSession.state === 'ready'
      ) {
        const candidates = collectCandidateMedia();
        const mixable = collectMixableMedia(candidates);
        const nextMedia = findNextPlayableMedia();
        const nextSubId = findBestReadySubframe();

        if (mixable.length >= 2) {
          if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
          runAudioInitForSession(activeSession, nextMedia || mixable[0], { preserveSessionOnFailure: true });
          return;
        }
        if (nextMedia && nextSubId !== null) {
          if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
          const subReport = knownSubframes.get(nextSubId);
          const subScore = (subReport && Number.isFinite(subReport.bestScore)) ? subReport.bestScore : -Infinity;
          if (subScore > scoreMediaCandidate(nextMedia)) {
            startSubframeRelay(nextSubId);
          } else {
            runAudioInitForSession(activeSession, nextMedia, { preserveSessionOnFailure: true });
          }
          return;
        }
        if (nextMedia) {
          if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
          runAudioInitForSession(activeSession, nextMedia, { preserveSessionOnFailure: true });
          return;
        }
        if (nextSubId !== null) {
          if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
          startSubframeRelay(nextSubId);
          return;
        }
      }
      return;
    }
    const tapNode = workletNode || processorNode;
    if (!tapNode || !analyserNode) return;

    if (isTopFrame && corsSilenceDetected && (!currentBoundVideo || isTopFailedMedia(currentBoundVideo))) {
      const readySubId = findBestReadySubframe();
      const nextPlayable = findNextPlayableMedia();
      if (readySubId !== null && nextPlayable) {
        const subReport = knownSubframes.get(readySubId);
        const subScore = (subReport && Number.isFinite(subReport.bestScore)) ? subReport.bestScore : -Infinity;
        if (subScore > scoreMediaCandidate(nextPlayable)) {
          startSubframeRelay(readySubId);
        } else {
          rebindActiveVideo(nextPlayable);
        }
        return;
      }
      if (readySubId !== null) {
        startSubframeRelay(readySubId);
        return;
      }
      if (nextPlayable) {
        rebindActiveVideo(nextPlayable);
        return;
      }
    }

    const candidates = collectCandidateMedia();
    syncMixCandidateObservers(candidates);
    const mixable = collectMixableMedia(candidates);
    const effectiveMix = collectEffectiveMixMedia(candidates, mixable);

    if (effectiveMix.length >= 2) {
      if (!mixerBus) {
        disconnectTapNodesFromSource();
        stopOwnedCaptureStream();
        audioSourceNode = null;
        audioSourceKind = 'mixer';
        mixerBus = audioCtx.createGain();
        if (mixerBus.gain) mixerBus.gain.value = 1;
        mixerBus.connect(analyserNode);
        mixerBus.connect(tapNode);
        mixerBusConnectedTap = tapNode;
      } else if (mixerBusConnectedTap !== tapNode) {
        try { mixerBus.disconnect(); } catch (e) {}
        mixerBus.connect(analyserNode);
        mixerBus.connect(tapNode);
        mixerBusConnectedTap = tapNode;
      }
      const mixSync = syncMixEntries(effectiveMix);
      if (activeMixEntries.size === 0) {
        const mixErr = (mixSync && (mixSync.lastSecurityError || mixSync.lastNonRetryableError || mixSync.lastError)) || null;
        cleanupMixerBusAndEntries();
        audioSourceKind = 'none';
        audioPipelineReady = false;
        if (currentBoundVideo) {
          detachVideoListeners(currentBoundVideo);
          currentBoundVideo = null;
        }
        currentBoundSrcObject = null;
        setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
        if (isTopFrame) {
          const nextSubId = findBestReadySubframe();
          const nextPlayable = findNextPlayableMedia();
          if (nextPlayable && nextSubId !== null) {
            const subReport = knownSubframes.get(nextSubId);
            const subScore = (subReport && Number.isFinite(subReport.bestScore)) ? subReport.bestScore : -Infinity;
            if (subScore > scoreMediaCandidate(nextPlayable)) {
              startSubframeRelay(nextSubId);
            } else {
              rebindActiveVideo(nextPlayable, true);
            }
            return;
          }
          if (nextSubId !== null) {
            startSubframeRelay(nextSubId);
            return;
          }
          if (nextPlayable) {
            rebindActiveVideo(nextPlayable, true);
            return;
          }
          if (mixErr && mixErr.name === 'SecurityError') {
            const targetSession = activeSession;
            setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none', MixTracks: 0 });
            tryTabCaptureFallback('security-error', { deferWarn: true }).then((ok) => {
              if (!ok) handleTopSecurityErrorFallback(targetSession, { skipWaitTimer: true });
            });
            return;
          }
          if (mixErr && !mixErr.retryable) {
            setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none', MixTracks: 0 });
            if (isRunning && !isConnectingUI) {
              updateActiveRunningStatus();
              if (!isNetworkOffline && !tabCaptureFailedInSession && !videoWaitTimer && !audioPipelineReady) {
                setStatus('warn', '音频捕获失败: ' + sanitizeErrorMessage((mixErr && mixErr.message) ? mixErr.message : mixErr), 'warn');
              }
            }
            return;
          }
          if (activeSession && activeSession.state === 'ready') {
            waitForVideoAndInit(activeSession, { preserveSessionOnFailure: true });
          }
        } else if (subframeCaptureActive) {
          const nextPlayable = findNextPlayableMedia();
          if (nextPlayable) {
            rebindActiveVideo(nextPlayable, true);
            return;
          }
          if (mixErr && !mixErr.retryable) {
            failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(mixErr));
            return;
          }
          emitSubframeMediaState();
          if (activeSession && activeSession.state === 'ready') {
            waitForVideoAndInit(activeSession);
          }
        }
        return;
      }
      let bestMix = effectiveMix[0];
      let bestScore = scoreMediaCandidate(effectiveMix[0]);
      for (let i = 1; i < effectiveMix.length; i++) {
        const s = scoreMediaCandidate(effectiveMix[i]);
        if (s > bestScore) { bestScore = s; bestMix = effectiveMix[i]; }
      }
      if (bestMix && bestMix !== currentBoundVideo) {
        if (currentBoundVideo) detachVideoListeners(currentBoundVideo);
        currentBoundVideo = bestMix;
        currentBoundSrcObject = bestMix.srcObject || null;
        isVideoPaused = !!bestMix.paused;
        attachVideoListeners(bestMix);
      } else if (bestMix && bestMix === currentBoundVideo) {
        currentBoundSrcObject = bestMix.srcObject || null;
      }
      if (isTopFrame) {
        lastTabCaptureFallbackReason = '';
        corsSilenceFallbackTried = false;
      }
      if (isMediaInputGated()) {
        const nextPlayable = findNextPlayableMedia();
        const nextSubId = isTopFrame ? findBestReadySubframe() : null;
        if (nextPlayable && nextSubId !== null) {
          const subReport = knownSubframes.get(nextSubId);
          const subScore = (subReport && Number.isFinite(subReport.bestScore)) ? subReport.bestScore : -Infinity;
          if (subScore > scoreMediaCandidate(nextPlayable)) {
            startSubframeRelay(nextSubId);
          } else {
            cleanupMixerBusAndEntries();
            audioSourceKind = 'none';
            setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
            rebindActiveVideo(nextPlayable, true);
          }
          return;
        }
        if (nextSubId !== null) {
          startSubframeRelay(nextSubId);
          return;
        }
        if (nextPlayable) {
          cleanupMixerBusAndEntries();
          audioSourceKind = 'none';
          setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
          rebindActiveVideo(nextPlayable, true);
          return;
        }
        if (mixSync && (mixSync.lastSecurityError || mixSync.lastNonRetryableError)) {
          cleanupMixerBusAndEntries();
          audioSourceKind = 'none';
          audioPipelineReady = false;
          if (currentBoundVideo) {
            detachVideoListeners(currentBoundVideo);
            currentBoundVideo = null;
          }
          currentBoundSrcObject = null;
          setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none', MixTracks: 0 });
          if (mixSync.lastSecurityError) {
            if (isTopFrame) {
              const targetSession = activeSession;
              tryTabCaptureFallback('security-error', { deferWarn: true }).then((ok) => {
                if (!ok) handleTopSecurityErrorFallback(targetSession, { skipWaitTimer: true });
              });
            } else if (subframeCaptureActive) {
              failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(mixSync.lastSecurityError));
            }
          } else {
            const nonSecErr = mixSync.lastNonRetryableError;
            if (isTopFrame && isRunning && !isConnectingUI) {
              updateActiveRunningStatus();
              if (!isNetworkOffline && !tabCaptureFailedInSession && !videoWaitTimer && !audioPipelineReady) {
                setStatus('warn', '音频捕获失败: ' + sanitizeErrorMessage((nonSecErr && nonSecErr.message) ? nonSecErr.message : nonSecErr), 'warn');
              }
            } else if (!isTopFrame && subframeCaptureActive) {
              failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(nonSecErr));
            }
          }
          return;
        }
      }
      setDiagnostics({ AudioEngine: 'mixer', MixTracks: activeMixEntries.size });
      updateActiveRunningStatus();
      emitSubframeMediaState();
      return;
    }

    if (mixerBus || activeMixEntries.size > 0) {
      cleanupMixerBusAndEntries();
      if (isTopFrame && !findNextPlayableMedia()) {
        const nextSubId = findBestReadySubframe();
        if (nextSubId !== null) {
          startSubframeRelay(nextSubId);
          return;
        }
      }
      const next = findActiveMedia();
      if (next) {
        if (currentBoundVideo) detachVideoListeners(currentBoundVideo);
        currentBoundVideo = null;
        currentBoundSrcObject = null;
        rebindActiveVideo(next);
      } else if (activeSession && activeSession.state === 'ready') {
        if (currentBoundVideo) {
          detachVideoListeners(currentBoundVideo);
          currentBoundVideo = null;
        }
        currentBoundSrcObject = null;
        audioPipelineReady = false;
        audioSourceKind = 'none';
        setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
        emitSubframeMediaState();
        waitForVideoAndInit(activeSession, { preserveSessionOnFailure: true });
      }
      return;
    }

    const best = findActiveMedia();
    if (!currentBoundVideo && best && activeSession && activeSession.state === 'ready') {
      rebindActiveVideo(best);
      return;
    }
    if (currentBoundVideo && best) {
      if (best === currentBoundVideo) {
        if ((currentBoundVideo.srcObject || null) !== currentBoundSrcObject) {
          rebindActiveVideo(best, true);
        }
      } else {
        const curFailed = isTopFrame && isTopFailedMedia(currentBoundVideo);
        const curBroken = curFailed || currentBoundVideo.isConnected === false || currentBoundVideo.paused || currentBoundVideo.ended || currentBoundVideo.muted || currentBoundVideo.volume === 0;
        const bestAudiblePlaying = !best.paused && !best.ended && !best.muted && best.volume > 0;
        if (bestAudiblePlaying && (!curFailed || isPlayableMediaCandidate(best)) && (curBroken || scoreMediaCandidate(best) > scoreMediaCandidate(currentBoundVideo) + 25)) {
          rebindActiveVideo(best);
          return;
        }
      }
    }
    if (isTopFrame && audioSourceKind !== 'tab-capture' && audioSourceKind !== 'mic' && isMediaInputGated() && !findNextPlayableMedia()) {
      const nextSubId = findBestReadySubframe();
      if (nextSubId !== null) {
        startSubframeRelay(nextSubId);
        return;
      }
    }
  }

  function disconnectTapNodesFromSource() {
    if (!audioSourceNode) return;
    if (audioSourceKind === 'video-element') {
      // 仅解绑分析器与采样节点，保留 MediaElementAudioSourceNode -> destination 原声通路不断开！
      if (analyserNode) {
        try { audioSourceNode.disconnect(analyserNode); } catch (e) {}
      }
      if (processorNode) {
        try { audioSourceNode.disconnect(processorNode); } catch (e) {}
      }
      if (workletNode) {
        try { audioSourceNode.disconnect(workletNode); } catch (e) {}
      }
    } else {
      try { audioSourceNode.disconnect(); } catch (e) {}
    }
  }

  function rebindActiveVideo(newVideo, force) {
    if (!isRunning || isDestroyed || config.audioMode === 'mic' || !newVideo) return;
    const nextSrcObj = newVideo.srcObject || null;
    if (!force && newVideo === currentBoundVideo && nextSrcObj === currentBoundSrcObject) return;
    resetCorsSilenceTracker();

    let pendingMixError = null;
    if (mixerBus || audioSourceKind === 'mixer') {
      const candidates = collectCandidateMedia();
      const mixable = collectEffectiveMixMedia(candidates, collectMixableMedia(candidates));
      if (mixable.length >= 2) {
        if (isTopFrame && activeSubframeId !== null) stopSubframeRelayFromTop();
        const mixSync = syncMixEntries(mixable);
        const mixFatalErr = mixSync && (mixSync.lastSecurityError || mixSync.lastNonRetryableError);
        if (activeMixEntries.size > 0 && !(isMediaInputGated() && (isPlayableMediaCandidate(newVideo) || mixFatalErr))) {
          if (currentBoundVideo) detachVideoListeners(currentBoundVideo);
          currentBoundVideo = newVideo;
          currentBoundSrcObject = nextSrcObj;
          isVideoPaused = !!newVideo.paused;
          attachVideoListeners(newVideo);
          setDiagnostics({ AudioEngine: 'mixer', MixTracks: activeMixEntries.size });
          updateActiveRunningStatus();
          emitSubframeMediaState();
          return;
        }
        if (mixFatalErr && !isPlayableMediaCandidate(newVideo)) {
          pendingMixError = mixFatalErr;
        }
      }
      cleanupMixerBusAndEntries();
      if (audioSourceKind === 'mixer') audioSourceKind = 'none';
      setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
    }

    const tapNode = workletNode || processorNode;
    if (!pendingMixError && (!audioCtx || audioCtx.state === 'closed' || !tapNode || !analyserNode)) {
      if (activeSession && activeSession.state === 'ready') {
        if (currentBoundVideo) {
          detachVideoListeners(currentBoundVideo);
        }
        pendingBindVideo = newVideo;
        commitCurrentLine(true, 'video-switch');
        resetDetectedSourceLangBadge();
        runAudioInitForSession(activeSession, newVideo, { preserveSessionOnFailure: true });
      } else {
        if (isTopFrame && activeSubframeId !== null) stopSubframeRelayFromTop();
        cleanupAudioPipeline();
        pendingBindVideo = newVideo;
        currentBoundVideo = newVideo;
        currentBoundSrcObject = nextSrcObj;
        isVideoPaused = !!newVideo.paused;
        attachVideoListeners(newVideo);
      }
      return;
    }
    const prevBoundVideo = currentBoundVideo;
    const prevSourceNode = audioSourceNode;
    const prevSourceKind = audioSourceKind;
    const prevPipelineReady = audioPipelineReady;
    const prevOwnedStream = videoCaptureStream;
    const canPreservePrevOnFailure = !!(
      prevPipelineReady &&
      prevBoundVideo &&
      prevBoundVideo !== newVideo &&
      prevSourceNode &&
      prevSourceKind !== 'mixer' &&
      prevSourceKind !== 'tab-capture' &&
      prevSourceKind !== 'subframe-relay' &&
      isPlayableMediaCandidate(prevBoundVideo)
    );

    try {
      if (pendingMixError) throw pendingMixError;
      const prevAudioCtx = audioCtx;
      const graph = getOrCreateAudioGraph(newVideo);
      if (graph.audioCtx !== prevAudioCtx) {
        if (activeSession && activeSession.state === 'ready') {
          if (currentBoundVideo) {
            detachVideoListeners(currentBoundVideo);
          }
          pendingBindVideo = newVideo;
          commitCurrentLine(true, 'video-switch');
          resetDetectedSourceLangBadge();
          runAudioInitForSession(activeSession, newVideo, { preserveSessionOnFailure: true });
        } else {
          cleanupAudioPipeline();
          pendingBindVideo = newVideo;
          currentBoundVideo = newVideo;
          currentBoundSrcObject = nextSrcObj;
          isVideoPaused = !!newVideo.paused;
          attachVideoListeners(newVideo);
        }
        return;
      }
      if (prevBoundVideo) {
        detachVideoListeners(prevBoundVideo);
      }
      disconnectTapNodesFromSource();
      if (prevOwnedStream && videoCaptureStream === prevOwnedStream && graph.kind !== 'video-stream') {
        stopOwnedCaptureStream();
      }
      if (isTopFrame && activeSubframeId !== null) {
        stopSubframeRelayFromTop();
      }

      currentBoundVideo = newVideo;
      currentBoundSrcObject = nextSrcObj;
      isVideoPaused = !!newVideo.paused;
      attachVideoListeners(newVideo);

      audioCtx = graph.audioCtx;
      audioSourceNode = graph.sourceNode;
      audioSourceKind = graph.kind;
      audioPipelineReady = true;
      audioSourceNode.connect(analyserNode);
      audioSourceNode.connect(tapNode);
      if (isTopFrame && graph.kind !== 'tab-capture') {
        lastTabCaptureFallbackReason = '';
        corsSilenceFallbackTried = false;
      }
      setDiagnostics({ AudioPipeline: 'running', AudioEngine: graph.kind, MixTracks: 0 });
      onMediaGatedTransition(isMediaInputGated());
      commitCurrentLine(true, 'video-switch');
      resetDetectedSourceLangBadge();
      ensureAudioContext().resume().catch(() => {});
      updateActiveRunningStatus();
      emitSubframeMediaState();
    } catch (e) {
      if (e && e.name === 'SecurityError') {
        const failedEl = (e && e.failedElement) || newVideo;
        sessionLog('Rebind video error', activeSession, { error: sanitizeErrorMessage(e), retryable: !!(e && e.retryable) });
        if (!isTopFrame && subframeCaptureActive) {
          if (failedEl) markSubframeMediaFailed(failedEl);
          if (canPreservePrevOnFailure) {
            return;
          }
          disconnectTapNodesFromSource();
          stopOwnedCaptureStream();
          audioSourceNode = null;
          audioSourceKind = 'none';
          audioPipelineReady = false;
          if (currentBoundVideo) {
            detachVideoListeners(currentBoundVideo);
            currentBoundVideo = null;
          }
          currentBoundSrcObject = null;
          setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none' });
          const nextPlayable = failedEl ? findNextPlayableMedia() : null;
          if (nextPlayable && activeSession && activeSession.state === 'ready') {
            cleanupAudioPipeline();
            runAudioInitForSession(activeSession, nextPlayable);
            return;
          }
          failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(e));
        } else if (config.audioMode === 'video' && isTopFrame) {
          if (failedEl) markTopFailedMedia(failedEl);
          if (!canPreservePrevOnFailure) {
            disconnectTapNodesFromSource();
            stopOwnedCaptureStream();
            audioSourceNode = null;
            audioSourceKind = 'none';
            audioPipelineReady = false;
            if (currentBoundVideo) {
              detachVideoListeners(currentBoundVideo);
              currentBoundVideo = null;
            }
            currentBoundSrcObject = null;
            setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none' });
          }
          const targetSession = activeSession;
          tryTabCaptureFallback('security-error', { deferWarn: true }).then((ok) => {
            if (!ok) handleTopSecurityErrorFallback(targetSession, { skipWaitTimer: true });
          });
        } else if (!canPreservePrevOnFailure) {
          disconnectTapNodesFromSource();
          stopOwnedCaptureStream();
          audioSourceNode = null;
          audioSourceKind = 'none';
          audioPipelineReady = false;
          if (currentBoundVideo) {
            detachVideoListeners(currentBoundVideo);
            currentBoundVideo = null;
          }
          currentBoundSrcObject = null;
          setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none' });
        }
        return;
      }

      if (canPreservePrevOnFailure) {
        if (!(e && e.retryable)) {
          const failedEl = (e && e.failedElement) || newVideo;
          if (failedEl) {
            if (isTopFrame) markTopFailedMedia(failedEl);
            else if (subframeCaptureActive) markSubframeMediaFailed(failedEl);
          }
        }
        sessionLog('Rebind video error (preserved active media)', activeSession, { error: sanitizeErrorMessage(e), retryable: !!(e && e.retryable) });
        return;
      }

      disconnectTapNodesFromSource();
      stopOwnedCaptureStream();
      audioSourceNode = null;
      audioSourceKind = 'none';
      audioPipelineReady = false;
      if (currentBoundVideo) {
        detachVideoListeners(currentBoundVideo);
        currentBoundVideo = null;
      }
      currentBoundSrcObject = null;
      setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none' });
      sessionLog('Rebind video error', activeSession, { error: sanitizeErrorMessage(e), retryable: !!(e && e.retryable) });
      if (e && e.retryable && activeSession && activeSession.state === 'ready') {
        emitSubframeMediaState();
        waitForVideoAndInit(activeSession, { preserveSessionOnFailure: true });
      } else if (!isTopFrame && subframeCaptureActive) {
        const failedEl = (e && e.failedElement) || newVideo;
        if (failedEl) markSubframeMediaFailed(failedEl);
        const nextPlayable = failedEl ? findNextPlayableMedia() : null;
        if (nextPlayable && activeSession && activeSession.state === 'ready') {
          cleanupAudioPipeline();
          runAudioInitForSession(activeSession, nextPlayable);
          return;
        }
        failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(e));
      } else if (isTopFrame) {
        const failedEl = (e && e.failedElement) || newVideo;
        if (failedEl) markTopFailedMedia(failedEl);
        if (tryTopNonSecurityFailover(activeSession, { preserveSessionOnFailure: true })) {
          return;
        }
        if (isRunning && !isConnectingUI) {
          updateActiveRunningStatus();
          if (!isNetworkOffline && !tabCaptureFailedInSession && !videoWaitTimer && !audioPipelineReady) {
            setStatus('warn', '音频捕获失败: ' + sanitizeErrorMessage((e && e.message) ? e.message : e), 'warn');
          }
        }
      }
    }
  }

  // SPA 导航 / 脱离 DOM / 动态挂载恢复
  function checkUrlChangeFallback() {
    try {
      const cur = (typeof location !== 'undefined' && location && location.href) ? String(location.href) : '';
      if (cur && cur !== lastObservedUrl) {
        lastObservedUrl = cur;
        onSpaNavigationDetected();
      }
    } catch (e) {}
  }

  let spaNavDebounce = null;
  function onSpaNavigationDetected() {
    if (isTopFrame) ensureOverlayMounted();
    try {
      const cur = (typeof location !== 'undefined' && location && location.href) ? String(location.href) : '';
      if (cur) lastObservedUrl = cur;
    } catch (e) {}
    if (!isRunning || isDestroyed) return;
    if (spaNavDebounce) clearTimeout(spaNavDebounce);
    spaNavDebounce = setTimeout(() => {
      spaNavDebounce = null;
      if (!isRunning || isDestroyed) return;
      if (isTopFrame) ensureOverlayMounted();
      runDomMediaCheck();
    }, 400);
  }

  function runDomMediaCheck() {
    if (isDestroyed) return;
    if (isTopFrame) ensureOverlayMounted();
    if (!isTopFrame && !isSameOriginWithParent() && !subframeCaptureActive) {
      reportSubframeMedia();
      return;
    }
    if (!isRunning || config.audioMode !== 'video') return;
    if (tabCaptureActive || tabCapturePending || audioSourceKind === 'tab-capture') return;
    if (audioSourceKind === 'subframe-relay') {
      reconcileActiveMedia();
      return;
    }

    const boundInDocPiP = !!(currentBoundVideo && activeDocPiPWindow && !activeDocPiPWindow.closed && currentBoundVideo.ownerDocument === activeDocPiPWindow.document);
    if (currentBoundVideo && currentBoundVideo.isConnected === false && !boundInDocPiP) {
      const deadEl = currentBoundVideo;
      detachVideoListeners(deadEl);
      const nextMedia = findActiveMedia();
      if (nextMedia && nextMedia !== deadEl) {
        rebindActiveVideo(nextMedia);
      } else {
        pendingBindVideo = null;
        cleanupAudioPipeline();
        setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
        emitSubframeMediaState();
        const nextSubId = isTopFrame ? findBestReadySubframe() : null;
        if (nextSubId !== null && activeSession && activeSession.state === 'ready') {
          startSubframeRelay(nextSubId);
        } else if (activeSession && activeSession.state === 'ready') {
          waitForVideoAndInit(activeSession, { preserveSessionOnFailure: true });
        }
      }
      return;
    }

    reconcileActiveMedia();
  }

  function scheduleDomMediaCheck() {
    if (isDestroyed) return;
    if (domCheckDebounce) clearTimeout(domCheckDebounce);
    domCheckDebounce = setTimeout(() => {
      domCheckDebounce = null;
      runDomMediaCheck();
    }, 250);
  }

  let titleObserver = null;
  (function hookHistory() {
    try {
      if (!window.__geminiLiveHistoryHooked) {
        window.__geminiLiveHistoryHooked = true;
        origHistoryPushState = history.pushState;
        origHistoryReplaceState = history.replaceState;
        wrappedHistoryPushState = function (...args) {
          const ret = origHistoryPushState.apply(this, args);
          window.dispatchEvent(new Event('locationchange'));
          return ret;
        };
        wrappedHistoryReplaceState = function (...args) {
          const ret = origHistoryReplaceState.apply(this, args);
          window.dispatchEvent(new Event('locationchange'));
          return ret;
        };
        history.pushState = wrappedHistoryPushState;
        history.replaceState = wrappedHistoryReplaceState;
      }
      window.addEventListener('popstate', onSpaNavigationDetected);
      window.addEventListener('locationchange', onSpaNavigationDetected);
      window.addEventListener('glt-spa-navigate', onSpaNavigationDetected);
      window.addEventListener('hashchange', onSpaNavigationDetected);
      window.addEventListener('yt-navigate-finish', onSpaNavigationDetected);
      if (typeof window !== 'undefined' && window.navigation && typeof window.navigation.addEventListener === 'function') {
        navigationRef = window.navigation;
        navigationRef.addEventListener('currententrychange', onSpaNavigationDetected);
      }
      const titleEl = document.querySelector('title');
      if (titleEl && window.MutationObserver) {
        titleObserver = new MutationObserver(onSpaNavigationDetected);
        titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
      const obsRoot = document.documentElement || document.body;
      if (obsRoot && typeof MutationObserver === 'function') {
        domMediaObserver = new MutationObserver((mutations) => {
          if (isDestroyed) return;
          let relevant = !!(isTopFrame && hostEl && !isHostActuallyMounted());
          if (!relevant && currentBoundVideo && currentBoundVideo.isConnected === false) {
            relevant = true;
          }
          if (!relevant && Array.isArray(mutations)) {
            for (let i = 0; i < mutations.length; i++) {
              const m = mutations[i];
              if (!m) continue;
              if (hostEl && (m.target === hostEl || (typeof hostEl.contains === 'function' && hostEl.contains(m.target)))) continue;
              if (m.type === 'childList' && ((m.addedNodes && m.addedNodes.length > 0) || (m.removedNodes && m.removedNodes.length > 0))) {
                const checkNodes = (nodes, isRemoved) => {
                  for (let j = 0; j < nodes.length; j++) {
                    const n = nodes[j];
                    if (!n || n.nodeType !== 1) continue;
                    if (n === hostEl) {
                      if (isRemoved) return true;
                      continue;
                    }
                    const t = n.tagName ? String(n.tagName).toUpperCase() : '';
                    if (t === 'VIDEO' || t === 'AUDIO' || t === 'IFRAME' || t === 'FRAME' || n.shadowRoot || (t && t.includes('-')) || (typeof n.querySelector === 'function' && (n.querySelector('video') || n.querySelector('audio') || n.querySelector('iframe')))) {
                      return true;
                    }
                  }
                  return false;
                };
                if ((m.addedNodes && checkNodes(m.addedNodes, false)) || (m.removedNodes && checkNodes(m.removedNodes, true))) {
                  relevant = true;
                  break;
                }
              }
            }
          }
          if (relevant) scheduleDomMediaCheck();
        });
        domMediaObserver.observe(obsRoot, { childList: true, subtree: true });
      }
    } catch (e) {}
  })();

  function onDocumentVideoPlay(e) {
    if (isDestroyed) return;
    if (!isTopFrame && !isSameOriginWithParent() && !subframeCaptureActive) {
      reportSubframeMedia();
      return;
    }
    if (!isRunning || config.audioMode !== 'video') return;
    if (isTopFrame && (tabCaptureActive || tabCapturePending || audioSourceKind === 'tab-capture')) return;
    let target = e && e.target;
    if (e && typeof e.composedPath === 'function') {
      try {
        const path = e.composedPath();
        for (let i = 0; i < path.length; i++) {
          if (path[i] && path[i].shadowRoot && path[i] !== hostEl) {
            ensureShadowRootListeners(path[i].shadowRoot);
          }
          if (isMediaElementNode(path[i]) && !isInsideExtensionHost(path[i])) {
            target = path[i];
            break;
          }
        }
      } catch (err) {}
    }
    if (!target) return;
    if (target.shadowRoot && target !== hostEl) {
      ensureShadowRootListeners(target.shadowRoot);
      const innerBest = findActiveMedia();
      if (innerBest && !innerBest.paused && !innerBest.ended) {
        target = innerBest;
      } else {
        scheduleMediaReconcile();
      }
    }
    if (!isMediaElementNode(target)) return;
    if (!isTopFrame && isSubframeMediaFailed(target)) return;
    if (isTopFrame && isTopFailedMedia(target)) return;

    const candidates = collectCandidateMedia();
    const mixable = collectEffectiveMixMedia(candidates, collectMixableMedia(candidates));
    if (mixable.length >= 2) {
      scheduleMediaReconcile();
      return;
    }

    if (target === currentBoundVideo) {
      if ((target.srcObject || null) !== currentBoundSrcObject) {
        rebindActiveVideo(target, true);
      } else if (corsSilenceDetected) {
        resetCorsSilenceTracker();
        if (isTopFrame) {
          lastTabCaptureFallbackReason = '';
          corsSilenceFallbackTried = false;
        }
        updateActiveRunningStatus();
      }
      return;
    }
    const targetAudible = !target.muted && target.volume > 0;
    if (isTopFrame && audioSourceKind === 'subframe-relay' && activeSubframeId !== null && !subframeRelayPaused && !subframeRelayMuted) {
      if (targetAudible) {
        rebindActiveVideo(target);
      }
      return;
    }
    if (!currentBoundVideo || currentBoundVideo.isConnected === false || currentBoundVideo.ended) {
      if (targetAudible || !currentBoundVideo || currentBoundVideo.isConnected === false) {
        rebindActiveVideo(target);
      }
      return;
    }
    const curPlaying = !currentBoundVideo.paused && !currentBoundVideo.ended;
    const curAudible = !currentBoundVideo.muted && currentBoundVideo.volume > 0;
    if (!targetAudible) {
      if (!curAudible && !curPlaying) rebindActiveVideo(target);
      return;
    }
    if (!curPlaying || !curAudible) {
      rebindActiveVideo(target);
      return;
    }
    if (scoreMediaCandidate(target) >= scoreMediaCandidate(currentBoundVideo)) {
      rebindActiveVideo(target);
    }
  }

  function onDocumentVideoVolumeChange(e) {
    if (isDestroyed) return;
    let target = e && e.target;
    if (e && typeof e.composedPath === 'function') {
      try {
        const path = e.composedPath();
        for (let i = 0; i < path.length; i++) {
          if (path[i] && path[i].shadowRoot && path[i] !== hostEl) {
            ensureShadowRootListeners(path[i].shadowRoot);
          }
          if (isMediaElementNode(path[i]) && !isInsideExtensionHost(path[i])) {
            target = path[i];
            break;
          }
        }
      } catch (err) {}
    }
    if (!target || !isMediaElementNode(target) || isInsideExtensionHost(target)) return;
    if (!isTopFrame && !isSameOriginWithParent()) {
      if (!subframeCaptureActive) {
        if (!target.muted && target.volume > 0 && !target.paused && !target.ended && !isSubframeMediaFailed(target)) {
          reportSubframeMedia();
        }
      } else if (isRunning && config.audioMode === 'video') {
        if (target !== currentBoundVideo && !activeMixEntries.has(target) && !target.muted && target.volume > 0 && !target.paused && !target.ended && !isSubframeMediaFailed(target)) {
          scheduleMediaReconcile();
        }
      }
      return;
    }
    if (isTopFrame && isRunning && config.audioMode === 'video' && !tabCaptureActive && !tabCapturePending && audioSourceKind !== 'tab-capture') {
      if (target !== currentBoundVideo && !activeMixEntries.has(target) && !target.muted && target.volume > 0 && !target.paused && !target.ended && !isTopFailedMedia(target)) {
        if (audioSourceKind === 'subframe-relay' && activeSubframeId !== null && !subframeRelayPaused && !subframeRelayMuted) {
          if (collectMixableMedia(collectCandidateMedia()).length < 2) {
            return;
          }
        }
        scheduleMediaReconcile();
      }
    }
  }
  document.addEventListener('play', onDocumentVideoPlay, true);
  document.addEventListener('volumechange', onDocumentVideoVolumeChange, true);

  function onPageHide() {
    if (!isTopFrame) {
      if (typeof stopSubframeCapture === 'function') stopSubframeCapture();
      if (subframeRelayPort) {
        try { subframeRelayPort.disconnect(); } catch (e) {}
        subframeRelayPort = null;
      }
      return;
    }
    wasRunningBeforeHide = !!isRunning;
    if (isRunning) stopSubtitleService(true);
  }
  window.addEventListener('pagehide', onPageHide);

  function onPageShow(e) {
    if (!isTopFrame || isDestroyed) return;
    if (!checkExtensionContextHealth()) return;
    if (e && e.persisted) {
      const shouldResume = wasRunningBeforeHide && overlay && overlay.style.display !== 'none' && !isRunning;
      wasRunningBeforeHide = false;
      if (shouldResume) {
        ensureAudioContext().resume().catch(() => {});
        startSubtitleService(true);
      }
    }
  }
  window.addEventListener('pageshow', onPageShow);

  function onNetworkOffline() {
    isNetworkOffline = true;
    if (!isTopFrame || !isRunning || isDestroyed) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setStatus('warn', '网络已断开，等待恢复…', 'warn');
  }

  function onNetworkOnline() {
    isNetworkOffline = false;
    if (!isTopFrame || !isRunning || isDestroyed) return;
    if (activeSession && activeSession.state === 'ready') {
      updateActiveRunningStatus();
      return;
    }
    if ((activeSession && activeSession.state === 'connecting') || sessionStartTimer) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      consecutiveFailures = 0;
      return;
    }
    if (promoteStandbyOnActiveDrop()) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    consecutiveFailures = 0;
    rapidFlapFailures = 0;
    connectSession(createSession('network-online'));
  }
  window.addEventListener('offline', onNetworkOffline);
  window.addEventListener('online', onNetworkOnline);

  // ---- 流式重采样 ------------------------------------------------------

  function resetResampler(nativeSampleRate) {
    resampler.step = (nativeSampleRate || 48000) / 16000;
    resampler.carryCount = 0;
    resampler.phase = 0;
    resampler.pendingCount = 0;
  }

  function resamplerSampleAt(idx, block, blockLen) {
    if (idx >= 0) {
      if (idx < blockLen) return block[idx];
      return blockLen > 0 ? block[blockLen - 1] : 0;
    }
    const carryIdx = resampler.carryCount + idx;
    if (carryIdx >= 0 && carryIdx < resampler.carryCount) return resampler.carry[carryIdx];
    return 0;
  }

  /**
   * 将任意长度、任意采样率的输入块流式重采样到 16kHz，
   * 输出写入 resampler.pending（Int16）。
   */
  function resampleBlock(input) {
    const n = input.length;
    if (!n) return 0;
    const step = resampler.step;
    let p = resampler.phase;
    let produced = 0;

    while (true) {
      const idx = Math.floor(p);
      if (idx >= n - 1) break;
      const frac = p - idx;
      let s0, s1;
      if (idx < 0) {
        s0 = resamplerSampleAt(idx, input, n);
        s1 = resamplerSampleAt(idx + 1, input, n);
      } else {
        s0 = input[idx];
        s1 = input[idx + 1];
      }
      if (!Number.isFinite(s0)) s0 = 0;
      if (!Number.isFinite(s1)) s1 = 0;
      const sample = s0 + (s1 - s0) * frac;
      const clamped = sample > 1 ? 1 : (sample < -1 ? -1 : sample);

      if (resampler.pendingCount >= resampler.pending.length) {
        consumePendingAudio();
        if (resampler.pendingCount >= resampler.pending.length) break;
      }
      resampler.pending[resampler.pendingCount++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      produced++;
      p += step;
    }

    if (n >= 2) {
      resampler.carry[0] = input[n - 2];
      resampler.carry[1] = input[n - 1];
      resampler.carryCount = 2;
    } else if (n === 1) {
      resampler.carry[0] = resampler.carryCount > 0 ? resampler.carry[resampler.carryCount - 1] : input[0];
      resampler.carry[1] = input[0];
      resampler.carryCount = 2;
    }
    resampler.phase = Math.max(-2, p - n);
    return produced;
  }

  function uint8ToBase64(uint8Arr, byteLength) {
    let binary = '';
    const chunkSize = 8192;
    const view = uint8Arr.subarray(0, byteLength);
    for (let i = 0; i < byteLength; i += chunkSize) {
      const chunk = view.subarray(i, Math.min(i + chunkSize, byteLength));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function buildAudioPayload(b64Audio) {
    const style = config.audioFrameStyle === 'mediaChunks' ? 'mediaChunks' : 'audio';
    if (style === 'mediaChunks') {
      return `{"realtimeInput":{"mediaChunks":[{"mimeType":"audio/pcm;rate=16000","data":"${b64Audio}"}]}}`;
    }
    return `{"realtimeInput":{"audio":{"data":"${b64Audio}","mimeType":"audio/pcm;rate=16000"}}}`;
  }

  const audioSendQueue = []; // 握手期间的 100ms 音频块（base64）

  function flushAudioQueue() {
    if (!activeSession || activeSession.state !== 'ready' || !activeSession.ws || activeSession.ws.readyState !== WebSocket.OPEN) return;
    while (audioSendQueue.length && activeSession && activeSession.state === 'ready' && activeSession.ws && activeSession.ws.readyState === WebSocket.OPEN) {
      if (activeSession.ws.bufferedAmount > 1048576) break;
      const payload = audioSendQueue.shift();
      try {
        activeSession.ws.send(payload);
        audioChunksSent++;
        lastAudioSentAt = now();
      } catch (e) {
        audioSendQueue.unshift(payload);
        break;
      }
    }
  }

  function dispatchAudioChunk(b64Audio) {
    if (!isTopFrame && subframeCaptureActive) {
      sendSubframeRelayMessage({ type: 'SUBFRAME_AUDIO_CHUNK', b64Audio: b64Audio, volume: volumeLevel });
      return;
    }
    const payload = buildAudioPayload(b64Audio);
    const s = activeSession;
    if (s && s.state === 'ready' && s.ws && s.ws.readyState === WebSocket.OPEN) {
      // 背压保护：发送队列积压过多时丢弃当前块，避免弱网下内存与延迟累积
      if (s.ws.bufferedAmount > 1048576) {
        droppedAudioChunks++;
        setDiagnostics({ DroppedAudio: droppedAudioChunks });
        return;
      }
      try {
        s.ws.send(payload);
        audioChunksSent++;
        lastAudioSentAt = now();
        if (audioChunksSent % 100 === 0) setDiagnostics({ AudioChunks: audioChunksSent });
        return;
      } catch (e) {
        forceReconnect('audio-send-error');
      }
    }
    // 握手/重连期间缓存少量音频，保持字幕连续
    if (audioSendQueue.length < AUDIO_MAX_QUEUE_CHUNKS) {
      audioSendQueue.push(payload);
    } else {
      audioSendQueue.shift();
      audioSendQueue.push(payload);
    }
  }

  function consumePendingAudio() {
    let sent = 0;
    while (resampler.pendingCount >= AUDIO_CHUNK_SAMPLES) {
      const chunkBytes = new Uint8Array(resampler.pending.buffer, 0, AUDIO_CHUNK_SAMPLES * 2);
      const b64 = uint8ToBase64(chunkBytes, AUDIO_CHUNK_SAMPLES * 2);
      dispatchAudioChunk(b64);
      sent++;
      const remain = resampler.pendingCount - AUDIO_CHUNK_SAMPLES;
      if (remain > 0) resampler.pending.copyWithin(0, AUDIO_CHUNK_SAMPLES, resampler.pendingCount);
      resampler.pendingCount = remain;
    }
    return sent;
  }

  function cleanupAudioPipeline() {
    audioInitSeq++;
    audioInitInFlight = false;
    if (volumeCheckInterval) { clearInterval(volumeCheckInterval); volumeCheckInterval = null; }
    if (audioResumeTimer) { clearInterval(audioResumeTimer); audioResumeTimer = null; }
    if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
    if (mediaReconcileDebounce) { clearTimeout(mediaReconcileDebounce); mediaReconcileDebounce = null; }

    cleanupMixerBusAndEntries();
    cleanupMixCandidateObservers();
    disconnectTapNodesFromSource();
    audioSourceNode = null;
    audioSourceKind = 'none';
    stopOwnedCaptureStream();
    resetCorsSilenceTracker();

    if (workletNode) {
      try { workletNode.port.onmessage = null; } catch (e) {}
      try { workletNode.disconnect(); } catch (e) {}
      workletNode = null;
    }
    if (processorNode) {
      try { processorNode.disconnect(); } catch (e) {}
      processorNode.onaudioprocess = null;
      processorNode = null;
    }
    if (mutedGainNode) {
      try { mutedGainNode.disconnect(); } catch (e) {}
      mutedGainNode = null;
    }
    if (analyserNode) {
      try { analyserNode.disconnect(); } catch (e) {}
      analyserNode = null;
    }
    if (mediaStream) {
      try { mediaStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      mediaStream = null;
    }
    if (currentBoundVideo) {
      detachVideoListeners(currentBoundVideo);
      currentBoundVideo = null;
    }
    currentBoundSrcObject = null;
    if (micAudioCtx && micAudioCtx.state !== 'closed') {
      try { micAudioCtx.close().catch(() => {}); } catch (e) {}
      micAudioCtx = null;
    }
    audioCtx = (persistentAudioCtx && persistentAudioCtx.state !== 'closed') ? persistentAudioCtx : null;
    audioPipelineReady = false;
    wasAudioInputGated = false;
    silenceGateChunksRemaining = 0;
    mediaPauseStartedAt = 0;
    resampler.pendingCount = 0;
    audioSendQueue.length = 0;
    renderVolume(0);
  }

  function makeRetryableError(message, code) {
    const err = new Error(message);
    err.retryable = true;
    err.code = code || 'RETRYABLE';
    return err;
  }

  function checkCorsSilenceState() {
    if (!isRunning || isDestroyed || config.audioMode !== 'video' || !audioPipelineReady) return;
    if (audioSourceKind === 'tab-capture' || audioSourceKind === 'subframe-relay' || audioSourceKind === 'mixer') return;
    if (isMediaInputGated()) {
      zeroPcmSilentSince = 0;
      return;
    }
    const primary = currentBoundVideo;
    if (!primary || primary.paused || primary.ended || primary.muted || primary.volume === 0) {
      zeroPcmSilentSince = 0;
      return;
    }
    if (primary.readyState < 2 && !isMediaStreamLike(primary.srcObject)) {
      zeroPcmSilentSince = 0;
      return;
    }

    const tNow = now();
    const curT = Number(primary.currentTime) || 0;
    const liveSrcObjAudio = hasLiveAudioTrack(primary.srcObject);
    if (primary !== lastObservedMediaEl) {
      lastObservedMediaEl = primary;
      lastObservedMediaTime = curT;
      lastMediaTimeAdvancedAt = liveSrcObjAudio ? tNow : 0;
      zeroPcmSilentSince = 0;
    } else if (Math.abs(curT - lastObservedMediaTime) > 0.05 || liveSrcObjAudio) {
      lastObservedMediaTime = curT;
      lastMediaTimeAdvancedAt = tNow;
    }

    const mediaAdvancing = liveSrcObjAudio || (lastMediaTimeAdvancedAt > 0 && (tNow - lastMediaTimeAdvancedAt) <= 1200);
    if (!mediaAdvancing) {
      zeroPcmSilentSince = 0;
      return;
    }

    const receivingBlocks = hasObservedAudioBlock && (tNow - lastAudioBlockAt) <= 1500;
    if (receivingBlocks && lastAudioBlockMaxAbs <= 1e-6) {
      if (zeroPcmSilentSince === 0) {
        zeroPcmSilentSince = tNow;
      } else if (!corsSilenceDetected && (tNow - zeroPcmSilentSince >= CORS_SILENCE_THRESHOLD_MS)) {
        corsSilenceDetected = true;
        setDiagnostics({ CorsSilence: 'true', AudioFallback: 'cors-silence' });
        if (isTopFrame) {
          const failedEl = currentBoundVideo;
          if (failedEl) markTopFailedMedia(failedEl);
          const onCorsTabCaptureUnavailable = () => {
            if (!isRunning || isDestroyed || config.audioMode !== 'video' || tabCaptureActive || tabCapturePending) return;
            if (audioSourceKind === 'tab-capture' || audioSourceKind === 'subframe-relay') return;
            if (!corsSilenceDetected) return;
            const subId = findBestReadySubframe();
            const nextMedia = findNextPlayableMedia();
            const candidates = collectCandidateMedia();
            const mixable = collectMixableMedia(candidates);
            if (mixable.length >= 2 && activeSession && activeSession.state === 'ready') {
              runAudioInitForSession(activeSession, nextMedia || mixable[0], { preserveSessionOnFailure: true });
              return;
            }
            if (subId !== null && nextMedia) {
              const subReport = knownSubframes.get(subId);
              const subScore = (subReport && Number.isFinite(subReport.bestScore)) ? subReport.bestScore : -Infinity;
              if (subScore > scoreMediaCandidate(nextMedia)) {
                startSubframeRelay(subId);
              } else if (activeSession && activeSession.state === 'ready') {
                runAudioInitForSession(activeSession, nextMedia, { preserveSessionOnFailure: true });
              }
              return;
            }
            if (subId !== null) {
              startSubframeRelay(subId);
              return;
            }
            if (nextMedia && activeSession && activeSession.state === 'ready') {
              runAudioInitForSession(activeSession, nextMedia, { preserveSessionOnFailure: true });
              return;
            }
            setStatus('warn', '检测到播放无音频信号（可能受跨域或独立音频引擎限制），请点击扩展图标后重试或切换麦克风', 'muted');
            updateActiveRunningStatus();
          };
          if (!corsSilenceFallbackTried && !tabCaptureFailedInSession) {
            corsSilenceFallbackTried = true;
            tryTabCaptureFallback('cors-silence', { deferWarn: true }).then((ok) => {
              if (!ok) onCorsTabCaptureUnavailable();
            });
          } else {
            corsSilenceFallbackTried = true;
            onCorsTabCaptureUnavailable();
          }
        } else if (!isTopFrame && subframeCaptureActive) {
          const failedEl = currentBoundVideo;
          if (failedEl) markSubframeMediaFailed(failedEl);
          const nextPlayable = failedEl ? findNextPlayableMedia() : null;
          if (nextPlayable && activeSession && activeSession.state === 'ready') {
            cleanupAudioPipeline();
            runAudioInitForSession(activeSession, nextPlayable);
            return;
          }
          failSubframeCapture('SUBFRAME_CORS_SILENCE');
        }
      }
    } else if (!receivingBlocks) {
      zeroPcmSilentSince = 0;
    }
  }

  function filterLiveMixableElements(list) {
    if (!Array.isArray(list)) return [];
    const live = [];
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el || el.isConnected === false || el.paused || el.ended || el.muted || el.volume === 0) continue;
      if (isMediaStreamLike(el.srcObject) && !hasLiveAudioTrack(el.srcObject)) continue;
      live.push(el);
    }
    return live;
  }

  async function initAudioCapture(session, preferredVideo) {
    const preferred = preferredVideo || pendingBindVideo;
    pendingBindVideo = null;
    cleanupAudioPipeline();
    const currentInitToken = ++audioInitSeq;
    audioInitInFlight = true;
    try {
    let selectedSourceKind = 'none';
    let initialMixable = null;

    if (config.audioMode === 'mic') {
      const mCtx = new (window.AudioContext || window.webkitAudioContext)();
      micAudioCtx = mCtx;
      audioCtx = mCtx;
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (e) {}
        if (currentInitToken !== audioInitSeq || session !== activeSession || !isRunning || isDestroyed) {
          try { if (mCtx.state !== 'closed') mCtx.close().catch(() => {}); } catch (e) {}
          if (micAudioCtx === mCtx) micAudioCtx = null;
          if (currentInitToken === audioInitSeq) cleanupAudioPipeline();
          return false;
        }
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
      } catch (micErr) {
        try { if (mCtx.state !== 'closed') mCtx.close().catch(() => {}); } catch (e) {}
        if (micAudioCtx === mCtx) micAudioCtx = null;
        if (currentInitToken === audioInitSeq) audioCtx = null;
        throw new Error('麦克风权限被拒绝或未找到音频输入设备: ' + (micErr && micErr.message ? micErr.message : micErr));
      }
      if (currentInitToken !== audioInitSeq || session !== activeSession || !isRunning || isDestroyed) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        try { if (mCtx.state !== 'closed') mCtx.close().catch(() => {}); } catch (e) {}
        if (micAudioCtx === mCtx) micAudioCtx = null;
        if (currentInitToken === audioInitSeq) cleanupAudioPipeline();
        return false;
      }
      mediaStream = stream;
      audioSourceNode = audioCtx.createMediaStreamSource(mediaStream);
      selectedSourceKind = 'mic';
    } else {
      const candidates = collectCandidateMedia();
      syncMixCandidateObservers(candidates);
      const mixable = collectMixableMedia(candidates);
      if (mixable.length >= 2) {
        initialMixable = mixable;
        let bestMix = mixable[0];
        let bestScore = scoreMediaCandidate(mixable[0]);
        for (let i = 1; i < mixable.length; i++) {
          const s = scoreMediaCandidate(mixable[i]);
          if (s > bestScore) { bestScore = s; bestMix = mixable[i]; }
        }
        currentBoundVideo = bestMix;
        currentBoundSrcObject = bestMix.srcObject || null;
        isVideoPaused = !!bestMix.paused;
        attachVideoListeners(bestMix);
        audioCtx = ensureAudioContext();
        audioSourceNode = null;
        selectedSourceKind = 'mixer';
      } else {
        const fallbackVideo = findActiveMedia();
        const video = (preferred && preferred.isConnected !== false && !preferred.ended && !preferred.paused && (isTopFrame ? !isTopFailedMedia(preferred) : !isSubframeMediaFailed(preferred)))
          ? preferred
          : fallbackVideo;
        if (!video || video.paused || video.ended) {
          throw makeRetryableError('未找到正在播放的视频。请先点击播放视频后再开启同传。', 'NO_VIDEO');
        }
        if (currentInitToken !== audioInitSeq || session !== activeSession || !isRunning || isDestroyed) return false;
        let graph;
        try {
          graph = getOrCreateAudioGraph(video);
        } catch (graphErr) {
          if (graphErr && typeof graphErr === 'object') graphErr.failedElement = video;
          throw graphErr;
        }
        currentBoundVideo = video;
        currentBoundSrcObject = video.srcObject || null;
        isVideoPaused = !!video.paused;
        attachVideoListeners(video);
        audioCtx = graph.audioCtx;
        audioSourceNode = graph.sourceNode;
        selectedSourceKind = graph.kind;
      }
    }

    if (currentInitToken !== audioInitSeq || session !== activeSession || !isRunning || isDestroyed) {
      if (currentInitToken === audioInitSeq) cleanupAudioPipeline();
      return false;
    }

    if (isTopFrame && activeSubframeId !== null) stopSubframeRelayFromTop();
    audioSourceKind = selectedSourceKind;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    if (audioSourceNode) {
      audioSourceNode.connect(analyserNode);
    }

    const volumeData = new Uint8Array(analyserNode.frequencyBinCount);
    volumeCheckInterval = setInterval(() => {
      if (!isRunning || !analyserNode) return;
      if (isMediaInputGated()) {
        renderVolume(0);
        return;
      }
      checkCorsSilenceState();
      try {
        analyserNode.getByteFrequencyData(volumeData);
      } catch (e) { return; }
      let sum = 0;
      for (let i = 0; i < volumeData.length; i++) sum += volumeData[i];
      const avg = sum / volumeData.length;
      renderVolume(avg);
      if (avg > 6) lastSpeechAt = now();
      setDiagnostics({ Volume: Math.round(avg) });
    }, 500);

    audioResumeTimer = setInterval(() => {
      if (!isRunning || !audioCtx) return;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }, 1000);

    const nativeRate = audioCtx.sampleRate || 48000;
    resetResampler(nativeRate);

    function processAudioInputBlock(input) {
      if (!isRunning || isDestroyed || !input || !input.length) return;
      if (isMediaInputGated()) {
        if (!wasAudioInputGated) onMediaGatedTransition(true);
        if (silenceGateChunksRemaining <= 0) return;
        resampleBlock(input);
        const dispatched = consumePendingAudio();
        if (dispatched > 0) {
          silenceGateChunksRemaining = Math.max(0, silenceGateChunksRemaining - dispatched);
        }
        if (silenceGateChunksRemaining <= 0) {
          resampler.pendingCount = 0;
        }
        return;
      }
      if (wasAudioInputGated) onMediaGatedTransition(false);
      if (config.audioMode === 'video' && audioSourceKind !== 'tab-capture' && audioSourceKind !== 'subframe-relay' && audioSourceKind !== 'mixer') {
        let maxAbs = 0;
        for (let i = 0; i < input.length; i++) {
          const v = input[i] < 0 ? -input[i] : input[i];
          if (v > maxAbs) {
            maxAbs = v;
            if (maxAbs > 1e-6) break;
          }
        }
        hasObservedAudioBlock = true;
        lastAudioBlockAt = now();
        lastAudioBlockMaxAbs = maxAbs;
        if (maxAbs <= 1e-6) {
          checkCorsSilenceState();
        } else {
          zeroPcmSilentSince = 0;
          if (corsSilenceDetected) {
            corsSilenceDetected = false;
            if (isTopFrame) {
              clearTopFailedMedia(currentBoundVideo);
              lastTabCaptureFallbackReason = '';
              corsSilenceFallbackTried = false;
            }
            setDiagnostics({ CorsSilence: 'false' });
            updateActiveRunningStatus();
          }
        }
      }
      resampleBlock(input);
      consumePendingAudio();
    }

    let tapNode = null;
    let pipelineKind = 'script-processor';
    const canTryWorklet = !!(
      audioCtx.audioWorklet &&
      typeof AudioWorkletNode === 'function' &&
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.getURL === 'function'
    );

    let detachedWhileLoading = false;
    if (canTryWorklet) {
      const ctxForWorklet = audioCtx;
      try {
        if (!workletLoadedContexts.has(ctxForWorklet)) {
          let loadPromise = workletLoadingContexts.get(ctxForWorklet);
          if (!loadPromise) {
            loadPromise = Promise.resolve(
              ctxForWorklet.audioWorklet.addModule(chrome.runtime.getURL('audio_worklet.js'))
            ).then(
              () => {
                workletLoadedContexts.add(ctxForWorklet);
                workletLoadingContexts.delete(ctxForWorklet);
              },
              (err) => {
                workletLoadingContexts.delete(ctxForWorklet);
                throw err;
              }
            );
            workletLoadingContexts.set(ctxForWorklet, loadPromise);
          }
          await loadPromise;
        }
        if (currentInitToken !== audioInitSeq || session !== activeSession || !isRunning || isDestroyed) {
          if (currentInitToken === audioInitSeq) cleanupAudioPipeline();
          return false;
        }
        const boundInDocPiP = !!(currentBoundVideo && activeDocPiPWindow && !activeDocPiPWindow.closed && currentBoundVideo.ownerDocument === activeDocPiPWindow.document);
        let workletBlockedByDetach = false;
        if (config.audioMode === 'video' && selectedSourceKind === 'mixer') {
          initialMixable = filterLiveMixableElements(initialMixable);
          if (initialMixable.length === 0) {
            workletBlockedByDetach = true;
          } else if (!currentBoundVideo || !initialMixable.includes(currentBoundVideo)) {
            if (currentBoundVideo) detachVideoListeners(currentBoundVideo);
            let nextBest = initialMixable[0];
            let nextBestScore = scoreMediaCandidate(nextBest);
            for (let i = 1; i < initialMixable.length; i++) {
              const s = scoreMediaCandidate(initialMixable[i]);
              if (s > nextBestScore) { nextBestScore = s; nextBest = initialMixable[i]; }
            }
            currentBoundVideo = nextBest;
            currentBoundSrcObject = nextBest.srcObject || null;
            isVideoPaused = !!nextBest.paused;
            attachVideoListeners(nextBest);
          }
        } else if (config.audioMode === 'video' && selectedSourceKind !== 'tab-capture' && (!currentBoundVideo || (currentBoundVideo.isConnected === false && !boundInDocPiP))) {
          workletBlockedByDetach = true;
        }
        if (workletBlockedByDetach) {
          detachedWhileLoading = true;
          cleanupAudioPipeline();
        } else {
          const wn = new AudioWorkletNode(ctxForWorklet, 'gemini-live-audio-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers'
          });
          wn.port.onmessage = (evt) => {
            if (!isRunning || isDestroyed) return;
            try {
              const data = evt && evt.data;
              if (data && data.length) processAudioInputBlock(data);
            } catch (err) {
              console.error('[Gemini Live] Worklet process error:', sanitizeErrorMessage(err));
            }
          };
          workletNode = wn;
          tapNode = wn;
          pipelineKind = 'audio-worklet';
        }
      } catch (workletErr) {
        if (currentInitToken !== audioInitSeq || session !== activeSession || !isRunning || isDestroyed) {
          if (currentInitToken === audioInitSeq) cleanupAudioPipeline();
          return false;
        }
        sessionLog('AudioWorklet unavailable, falling back to ScriptProcessor', session, {
          error: sanitizeErrorMessage(workletErr)
        });
        if (workletNode) {
          try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch (e) {}
          workletNode = null;
        }
      }
    }

    if (detachedWhileLoading) {
      throw makeRetryableError('视频已从页面移除，等待新视频播放…', 'VIDEO_DETACHED');
    }
    if (currentInitToken !== audioInitSeq || session !== activeSession || !isRunning || isDestroyed) {
      if (currentInitToken === audioInitSeq) cleanupAudioPipeline();
      return false;
    }
    const boundInDocPiPPost = !!(currentBoundVideo && activeDocPiPWindow && !activeDocPiPWindow.closed && currentBoundVideo.ownerDocument === activeDocPiPWindow.document);
    if (config.audioMode === 'video' && selectedSourceKind === 'mixer') {
      initialMixable = filterLiveMixableElements(initialMixable);
      if (initialMixable.length === 0) {
        cleanupAudioPipeline();
        throw makeRetryableError('视频已从页面移除，等待新视频播放…', 'VIDEO_DETACHED');
      }
      if (initialMixable.length === 1) {
        const sole = initialMixable[0];
        if (currentBoundVideo && currentBoundVideo !== sole) {
          detachVideoListeners(currentBoundVideo);
        }
        let soleGraph;
        try {
          soleGraph = getOrCreateAudioGraph(sole);
        } catch (soleErr) {
          if (soleErr && typeof soleErr === 'object') soleErr.failedElement = sole;
          cleanupAudioPipeline();
          throw soleErr;
        }
        if (soleGraph.audioCtx !== audioCtx) {
          cleanupAudioPipeline();
          throw makeRetryableError('视频已切换，重新初始化音频…', 'VIDEO_DETACHED');
        }
        currentBoundVideo = sole;
        currentBoundSrcObject = sole.srcObject || null;
        isVideoPaused = !!sole.paused;
        attachVideoListeners(sole);
        audioSourceNode = soleGraph.sourceNode;
        selectedSourceKind = soleGraph.kind;
        audioSourceKind = soleGraph.kind;
        if (analyserNode && audioSourceNode) {
          audioSourceNode.connect(analyserNode);
        }
        initialMixable = null;
      } else if (!currentBoundVideo || !initialMixable.includes(currentBoundVideo)) {
        if (currentBoundVideo) detachVideoListeners(currentBoundVideo);
        let nextBest = initialMixable[0];
        let nextBestScore = scoreMediaCandidate(nextBest);
        for (let i = 1; i < initialMixable.length; i++) {
          const s = scoreMediaCandidate(initialMixable[i]);
          if (s > nextBestScore) { nextBestScore = s; nextBest = initialMixable[i]; }
        }
        currentBoundVideo = nextBest;
        currentBoundSrcObject = nextBest.srcObject || null;
        isVideoPaused = !!nextBest.paused;
        attachVideoListeners(nextBest);
      }
    } else if (config.audioMode === 'video' && selectedSourceKind !== 'tab-capture' && (!currentBoundVideo || (currentBoundVideo.isConnected === false && !boundInDocPiPPost))) {
      cleanupAudioPipeline();
      throw makeRetryableError('视频已从页面移除，等待新视频播放…', 'VIDEO_DETACHED');
    }

    if (!tapNode) {
      processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
      try {
        processorNode.channelCount = 1;
        processorNode.channelCountMode = 'explicit';
        processorNode.channelInterpretation = 'speakers';
      } catch (e) {}

      processorNode.onaudioprocess = (e) => {
        if (!isRunning || isDestroyed) return;
        try {
          processAudioInputBlock(e.inputBuffer.getChannelData(0));
        } catch (err) {
          console.error('[Gemini Live] Audio process error:', sanitizeErrorMessage(err));
        }
      };
      tapNode = processorNode;
    }

    if (selectedSourceKind === 'mixer' && initialMixable) {
      mixerBus = audioCtx.createGain();
      if (mixerBus.gain) mixerBus.gain.value = 1;
      mixerBus.connect(analyserNode);
      mixerBus.connect(tapNode);
      mixerBusConnectedTap = tapNode;
      const mixSync = syncMixEntries(initialMixable);
      if (activeMixEntries.size === 0) {
        const mixErr = (mixSync && (mixSync.lastSecurityError || mixSync.lastNonRetryableError || mixSync.lastError)) || null;
        cleanupAudioPipeline();
        setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
        if (mixErr && (mixErr.name === 'SecurityError' || !mixErr.retryable)) {
          throw mixErr;
        }
        throw makeRetryableError(
          mixErr ? sanitizeErrorMessage(mixErr) : '未找到可用混音音轨，等待新音轨就绪…',
          'NO_AUDIO_TRACKS'
        );
      }
      pipelineKind = 'mixer';
    } else if (audioSourceNode) {
      audioSourceNode.connect(tapNode);
    }
    mutedGainNode = audioCtx.createGain();
    mutedGainNode.gain.value = 0;
    tapNode.connect(mutedGainNode);
    mutedGainNode.connect(audioCtx.destination);

    audioPipelineReady = true;
    if (isMediaInputGated()) {
      onMediaGatedTransition(true);
    } else {
      wasAudioInputGated = false;
      silenceGateChunksRemaining = 0;
      mediaPauseStartedAt = 0;
    }
    lastAudioSentAt = now();
    if (isTopFrame && selectedSourceKind !== 'tab-capture') {
      lastTabCaptureFallbackReason = '';
      corsSilenceFallbackTried = false;
    }
    setDiagnostics({
      SampleRate: nativeRate,
      AudioPipeline: 'running',
      AudioEngine: pipelineKind,
      MixTracks: selectedSourceKind === 'mixer' ? activeMixEntries.size : 0
    });
    startSilenceFlushTimer();
    updateActiveRunningStatus();
    return true;
    } finally {
      if (currentInitToken === audioInitSeq) {
        audioInitInFlight = false;
      }
    }
  }

  // ========================================================================
  // 7. WebSocket 会话管理（原生 Live Translate 协议）
  // ========================================================================

  function getWebSocketUrl() {
    let host = String((config && config.apiHost) || 'https://generativelanguage.googleapis.com').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() || 'https://generativelanguage.googleapis.com';
    if (/^http:\/\//i.test(host)) host = 'ws://' + host.substring(7);
    else if (/^https:\/\//i.test(host)) host = 'wss://' + host.substring(8);
    else if (!/^wss?:\/\//i.test(host)) host = 'wss://' + host;

    host = host.replace(/\/+$/, '')
      .replace(/\/v1(beta|alpha)\/models\/?$/i, '')
      .replace(/\/v1(beta|alpha)\/?$/i, '')
      .replace(/\/models\/?$/i, '');

    if (!/\/ws\/google\.ai\.generativelanguage\./i.test(host)) {
      host += '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
    }

    const cleanKey = config && config.apiKey ? String(config.apiKey).replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : '';
    if (cleanKey && !/[?&]key=/.test(host)) {
      host += (host.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(cleanKey);
    }
    return host;
  }

  function buildSetupPayload() {
    const model = normalizeModelName(config.model);
    const useLegacy = isLiveTranslateModel(model) && config.protocolMode === 'legacy';

    if (useLegacy) {
      const srcHint = (config.sourceLang && !String(config.sourceLang).includes('自动识别'))
        ? ` Source spoken language: ${config.sourceLang}.`
        : '';
      const legacyPrompt = `${buildDynamicSystemPrompt()}${srcHint}\n\n[MODE]: Real-time simultaneous interpretation of the incoming audio. Output ONLY the translated text in the target language, continuously, without waiting for turns.`;
      return {
        setup: {
          model,
          generationConfig: {
            responseModalities: [config.responseModality === 'AUDIO' ? 'AUDIO' : 'TEXT'],
            temperature: 0.3
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          systemInstruction: { parts: [{ text: legacyPrompt }] }
        }
      };
    }

    return {
      setup: {
        model,
        generationConfig: {
          responseModalities: [config.responseModality === 'TEXT' ? 'TEXT' : 'AUDIO'],
          translationConfig: {
            targetLanguageCode: getBcp47LanguageCode(config.targetLang),
            echoTargetLanguage: true
          }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} }
      }
    };
  }

  function createSession(reason) {
    return {
      id: ++sessionSeq,
      reason: reason || 'connect',
      ws: null,
      state: 'connecting', // connecting | ready | closed
      createdAt: now(),
      openedAt: 0,
      readyAt: 0,
      lastServerMsgAt: 0,
      lastTranscriptionAt: 0,
      lastOrigAt: 0,
      firstOrigSinceOutAt: 0,
      lastOutAt: 0,
      connectTimer: null,
      rotationTimer: null,
      drainTimer: null,
      intentionallyClosed: false,
      urgent: false,
      goAwayAt: 0,
      goAwayDeadlineAt: 0,
      hasEmittedTranscript: false,
      rotationPriority: 'normal'
    };
  }

  function clearSessionTimers(session) {
    if (!session) return;
    if (session.connectTimer) { clearTimeout(session.connectTimer); session.connectTimer = null; }
    if (session.rotationTimer) { clearTimeout(session.rotationTimer); session.rotationTimer = null; }
    if (session.drainTimer) { clearTimeout(session.drainTimer); session.drainTimer = null; }
  }

  function closeSession(session, reason) {
    if (!session) return;
    session.intentionallyClosed = true;
    clearSessionTimers(session);
    const sock = session.ws;
    session.ws = null;
    session.state = 'closed';
    if (sock) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try { sock.close(1000, reason || 'close'); } catch (e) {}
    }
  }

  function closeDrainingSession(reason) {
    if (!drainingSession) return;
    const ds = drainingSession;
    drainingSession = null;
    closeSession(ds, reason || 'drain-complete');
  }

  function flushDrainingSession(reason) {
    if (!drainingSession) return;
    if (currentOrigBuffer.trim() || currentTransBuffer.trim()) {
      commitCurrentLine(true, reason || 'rotation-handoff');
    }
    closeDrainingSession(reason || 'rotation-handoff');
  }

  function sessionLog(prefix, session, extra) {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[Gemini Live ${ts}] ${prefix}`, JSON.stringify(Object.assign({
      session: session ? session.id : null,
      reason: session ? session.reason : null,
      state: session ? session.state : null
    }, extra || {})));
  }

  function connectSession(session, options) {
    if (!session || !isRunning || isDestroyed) return;
    const opts = options || {};
    const silent = !!opts.silent; // 轮转备用会话：静默握手，绝不污染活跃主会话的状态栏

    const rawHost = cleanInputString(config.apiHost || DEFAULT_CONFIG.apiHost);
    const isOfficial = isOfficialApiHost(rawHost);

    if (!isOfficial && !isValidApiHost(rawHost)) {
      if (!silent) {
        const errMsg = '请在设置页填写完整的自定义代理节点地址';
        setStatus('err', errMsg, 'error');
        setInitialPromptMessage(errMsg);
        stopSubtitleService(false);
      }
      return;
    }

    let url;
    try {
      url = getWebSocketUrl();
    } catch (e) {
      if (!silent) {
        const errMsg = '节点地址无效: ' + sanitizeErrorMessage(e);
        setStatus('err', errMsg, 'error');
        setInitialPromptMessage(errMsg);
      }
      return;
    }

    if (isOfficialApiHost(url) && !cleanInputString(config.apiKey)) {
      if (!silent) {
        const errMsg = '官方 API 需要填写 Google API Key';
        setStatus('err', errMsg, 'error');
        setInitialPromptMessage(errMsg);
        stopSubtitleService(false);
      }
      return;
    }

    if (!silent) {
      if (activeSession && activeSession !== session && activeSession.state !== 'closed') {
        closeSession(activeSession, 'superseded');
      }
      activeSession = session;
      isConnectingUI = true;
      setStatus('info', '正在连接…', 'spinner');
      setDiagnostics({ Session: session.id, Connects: session.id });
    } else {
      sessionLog('Standby session connecting', session);
    }

    let sock;
    try {
      sock = new WebSocket(url);
      sock.binaryType = 'arraybuffer';
    } catch (e) {
      sessionLog('WS construct failed', session, { error: sanitizeErrorMessage(e) });
      closeSession(session, 'construct-failed');
      if (silent || session === standbySession) {
        if (standbySession === session) standbySession = null;
        if (activeSession && activeSession.state === 'ready') {
          const retryMs = activeSession.goAwayDeadlineAt ? STANDBY_URGENT_RETRY_MS : STANDBY_RETRY_MS;
          scheduleRotation(activeSession, 'standby-retry', retryMs);
        }
        return;
      }
      lastErrorSummary = sanitizeErrorMessage(e && e.message ? e.message : e).slice(0, 60);
      if (activeSession === session) {
        activeSession = null;
        isConnectingUI = false;
      }
      setStatus('err', 'WebSocket 创建失败: ' + lastErrorSummary, 'error');
      scheduleReconnect('construct-failed');
      return;
    }
    session.ws = sock;

    session.connectTimer = setTimeout(() => {
      if (session.state === 'closed') return;
      if (session.state === 'connecting') {
        const isStandbyRole = session === standbySession || (silent && session !== activeSession);
        sessionLog('Connect/handshake timeout', session, { timeoutMs: CONNECT_TIMEOUT_MS, silent: isStandbyRole });
        closeSession(session, 'handshake-timeout');
        if (isStandbyRole) {
          if (standbySession === session) standbySession = null;
          if (activeSession && activeSession.state === 'ready') {
            const retryMs = activeSession.goAwayDeadlineAt ? STANDBY_URGENT_RETRY_MS : STANDBY_RETRY_MS;
            scheduleRotation(activeSession, 'standby-timeout-retry', retryMs);
          }
          return;
        }
        lastErrorSummary = '握手超时';
        if (activeSession === session) {
          activeSession = null;
          isConnectingUI = false;
        }
        setStatus('warn', '握手超时，正在重试…', 'spinner');
        scheduleReconnect('handshake-timeout');
      }
    }, CONNECT_TIMEOUT_MS);

    sock.onopen = () => {
      if (session.state === 'closed' || !isRunning || isDestroyed) return;
      session.openedAt = now();
      sessionLog('WebSocket opened', session, { handshakeMs: session.openedAt - session.createdAt });
      let payload;
      try {
        payload = buildSetupPayload();
      } catch (e) {
        closeSession(session, 'setup-error');
        if (session === activeSession) isConnectingUI = false;
        if (session === activeSession || !silent) setStatus('err', '会话配置构造失败: ' + sanitizeErrorMessage(e), 'error');
        return;
      }
      try {
        sock.send(JSON.stringify(payload));
        sessionLog('Setup sent', session, { model: payload.setup.model });
        if (session === activeSession || !silent) setStatus('info', '初始化会话…', 'spinner');
      } catch (e) {
        const isStandbyRole = session === standbySession || (silent && session !== activeSession);
        closeSession(session, 'setup-send-error');
        if (isStandbyRole) {
          if (standbySession === session) standbySession = null;
          if (activeSession && activeSession.state === 'ready') {
            const retryMs = activeSession.goAwayDeadlineAt ? STANDBY_URGENT_RETRY_MS : STANDBY_RETRY_MS;
            scheduleRotation(activeSession, 'standby-send-retry', retryMs);
          }
          return;
        }
        lastErrorSummary = sanitizeErrorMessage(e).slice(0, 60);
        if (activeSession === session) {
          activeSession = null;
          isConnectingUI = false;
        }
        setStatus('err', '发送 setup 失败: ' + lastErrorSummary, 'error');
        scheduleReconnect('setup-send-error');
      }
    };

    sock.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleServerMessage(session, event.data);
      } else if (event.data instanceof ArrayBuffer) {
        try { handleServerMessage(session, utf8Decoder.decode(event.data)); } catch (e) {}
      } else if (event.data && typeof event.data.text === 'function') {
        event.data.text().then((t) => handleServerMessage(session, t)).catch((e) => sessionLog('Blob decode error', session, { error: String(e) }));
      }
    };

    sock.onerror = () => {
      sessionLog('WebSocket error event', session);
    };

    sock.onclose = (event) => {
      sessionLog('WebSocket closed', session, { code: event.code, reason: sanitizeErrorMessage(event.reason || ''), wasReady: !!session.readyAt });
      clearSessionTimers(session);
      const wasActive = session === activeSession;
      const wasStandby = session === standbySession;
      const wasDraining = session === drainingSession;
      session.state = 'closed';
      session.ws = null;

      if (wasDraining) {
        drainingSession = null;
        if (!session.intentionallyClosed && (currentOrigBuffer.trim() || currentTransBuffer.trim()) && (!activeSession || !activeSession.hasEmittedTranscript)) {
          commitCurrentLine(true, 'rotation-drain-close');
        }
        return;
      }

      if (session.intentionallyClosed) return;

      if (wasStandby) {
        standbySession = null;
        sessionLog('Standby rotation failed, keeping current session', session);
        if (activeSession && activeSession.state === 'ready') {
          const retryMs = activeSession.goAwayDeadlineAt ? STANDBY_URGENT_RETRY_MS : STANDBY_RETRY_MS;
          scheduleRotation(activeSession, 'standby-closed-retry', retryMs);
        }
        return;
      }

      if (!wasActive) return;

      activeSession = null;
      isConnectingUI = false;
      if (!isRunning || isDestroyed) return;

      if (isTerminalError(event.code, event.reason, config.apiHost)) {
        const errText = formatTerminalErrorMessage(event.code, event.reason);
        setStatus('err', errText, 'error');
        setInitialPromptMessage(errText);
        stopSubtitleService(false);
        return;
      }

      lastErrorSummary = sanitizeErrorMessage(event.reason || `code ${event.code}`).slice(0, 60);
      if (session.readyAt) {
        const uptime = now() - session.readyAt;
        if (uptime < HEALTHY_SESSION_MIN_MS && !session.hasEmittedTranscript) {
          rapidFlapFailures++;
        } else if (uptime >= HEALTHY_SESSION_MIN_MS) {
          rapidFlapFailures = 0;
          consecutiveFailures = 0;
        }
      }

      if (event.code === 1000 && !event.reason) {
        sessionLog('Normal close while running -> reconnect', session);
      }
      if (promoteStandbyOnActiveDrop()) return;
      scheduleReconnect(`close-${event.code}`);
    };
  }

  function handleServerMessage(session, rawText) {
    if (!rawText) return;
    if (session.state === 'closed' || isDestroyed) return;
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch (e) {
      sessionLog('JSON parse error', session, { error: sanitizeErrorMessage(e) });
      return;
    }

    const t = now();
    session.lastServerMsgAt = t;
    lastServerMessageAt = t;
    if (msg.setupComplete !== undefined) {
      session.state = 'ready';
      session.readyAt = t;
      clearSessionTimers(session);
      sessionLog('setupComplete', session, { setupMs: t - session.createdAt });
      reconnectAttempts = 0;
      consecutiveFailures = 0;
      circuitBreakerTripped = false;
      lastErrorSummary = '';
      isConnectingUI = false;
      onSessionReady(session);
      return;
    }

    if (msg.error) {
      const errStatus = msg.error.status ? String(msg.error.status) : '';
      const errDetail = msg.error.message || JSON.stringify(msg.error);
      const errMsg = (errStatus && !errDetail.includes(errStatus)) ? `${errStatus}: ${errDetail}` : errDetail;
      sessionLog('Server error', session, { code: msg.error.code, message: sanitizeErrorMessage(errMsg) });
      if (session === drainingSession) {
        flushDrainingSession('drain-error');
        return;
      }
      if (session !== activeSession) {
        closeSession(session, 'standby-error');
        if (session === standbySession) standbySession = null;
        if (activeSession && activeSession.state === 'ready') {
          const retryMs = activeSession.goAwayDeadlineAt ? STANDBY_URGENT_RETRY_MS : STANDBY_RETRY_MS;
          scheduleRotation(activeSession, 'standby-err-retry', retryMs);
        }
        return;
      }
      if (isTerminalError(msg.error.code, errMsg, config.apiHost)) {
        const errText = formatTerminalErrorMessage(msg.error.code, errMsg);
        setStatus('err', errText, 'error');
        setInitialPromptMessage(errText);
        closeSession(session, 'terminal-error');
        activeSession = null;
        stopSubtitleService(false);
      } else {
        lastErrorSummary = sanitizeErrorMessage(errMsg).slice(0, 60);
        if (session.readyAt) {
          const uptime = t - session.readyAt;
          if (uptime < HEALTHY_SESSION_MIN_MS && !session.hasEmittedTranscript) {
            rapidFlapFailures++;
          } else if (uptime >= HEALTHY_SESSION_MIN_MS) {
            rapidFlapFailures = 0;
            consecutiveFailures = 0;
          }
        }
        setStatus('warn', '服务端异常，正在重连: ' + lastErrorSummary, 'warn');
        closeSession(session, 'transient-server-error');
        activeSession = null;
        isConnectingUI = false;
        scheduleReconnect('server-error');
      }
      return;
    }

    if (msg.goAway) {
      const timeLeftSec = parseDurationSeconds(msg.goAway.timeLeft);
      sessionLog('goAway received', session, { timeLeftSec, raw: msg.goAway.timeLeft });
      setDiagnostics({ GoAway: timeLeftSec || '0' });
      if (session === activeSession) {
        session.goAwayAt = t;
        session.goAwayDeadlineAt = timeLeftSec > 0 ? (t + timeLeftSec * 1000) : t;
        const leadMs = 20000;
        const rotateDelay = timeLeftSec > 0 ? Math.max(300, timeLeftSec * 1000 - leadMs) : 300;
        scheduleRotation(session, 'go-away', rotateDelay);
      }
    }

    // 备用/过期会话一律不渲染字幕，避免轮转期间出现重复内容（drainingSession 仅收尾当前句）
    if (session !== activeSession) {
      if (session !== drainingSession) return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    const hasTranscriptSignal = !!(
      (sc.inputTranscription && sc.inputTranscription.text) ||
      (sc.outputTranscription && sc.outputTranscription.text) ||
      (sc.outputAudioTranscription && sc.outputAudioTranscription.text) ||
      (Array.isArray(sc.modelTurn && sc.modelTurn.parts) && sc.modelTurn.parts.some((p) => p && p.text))
    );

    if (session === activeSession) {
      if (session.readyAt && (t - session.readyAt >= HEALTHY_SESSION_MIN_MS)) {
        rapidFlapFailures = 0;
      }
      if (hasTranscriptSignal) {
        rapidFlapFailures = 0;
        if (!session.hasEmittedTranscript) {
          session.hasEmittedTranscript = true;
          if (drainingSession) {
            flushDrainingSession('rotation-handoff');
          }
        }
      }
    }

    if (sc.interrupted) {
      commitCurrentLine(true, 'interrupted');
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      session.lastTranscriptionAt = t;
      session.lastOrigAt = t;
      if (!session.firstOrigSinceOutAt && sc.inputTranscription.text.trim()) {
        session.firstOrigSinceOutAt = t;
      }
      onOriginalDelta(sc.inputTranscription.text);
    }

    let handled = false;
    if (sc.outputTranscription && sc.outputTranscription.text) {
      session.lastTranscriptionAt = t;
      session.lastOutAt = t;
      session.firstOrigSinceOutAt = 0;
      onTranslationDelta(sc.outputTranscription.text);
      handled = true;
    }
    if (sc.outputAudioTranscription && sc.outputAudioTranscription.text) {
      session.lastTranscriptionAt = t;
      session.lastOutAt = t;
      session.firstOrigSinceOutAt = 0;
      onTranslationDelta(sc.outputAudioTranscription.text);
      handled = true;
    }
    if (!handled && sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
      for (let i = 0; i < sc.modelTurn.parts.length; i++) {
        const part = sc.modelTurn.parts[i];
        if (part && part.text) {
          session.lastTranscriptionAt = t;
          session.lastOutAt = t;
          session.firstOrigSinceOutAt = 0;
          onTranslationDelta(part.text);
        }
        if (part && part.inlineData) {
          inlineAudioChunks++;
          if (inlineAudioChunks % 20 === 1) setDiagnostics({ InlineAudio: inlineAudioChunks });
        }
      }
    }

    if (sc.turnComplete || sc.generationComplete) {
      if (session === drainingSession) {
        if (currentOrigBuffer.trim() || currentTransBuffer.trim()) {
          commitCurrentLine(true, 'drain-turn-complete');
        }
        closeDrainingSession('drain-settled');
      } else if (bufferEndsWithTerminal(currentTransBuffer) || currentTransBuffer.trim().length >= 20) {
        commitCurrentLine(false, 'turn-complete');
      } else if (currentTransBuffer.trim()) {
        scheduleCommit('turn-complete-idle', 600);
      }
    } else if (session === drainingSession && !currentOrigBuffer.trim() && !currentTransBuffer.trim() && !commitGraceTimer) {
      closeDrainingSession('drain-settled');
    }
  }

  function sendRuntimeMessageSafe(msg) {
    if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (resp) => {
        if (settled) return;
        settled = true;
        resolve(resp || null);
      };
      try {
        const p = chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime && chrome.runtime.lastError) done(null);
          else done(r);
        });
        if (p && typeof p.then === 'function') {
          p.then(done, () => done(null));
        }
      } catch (e) {
        done(null);
      }
    });
  }

  function ensureTopRelayPort() {
    if (!isTopFrame || isDestroyed) return null;
    if (topRelayPort) return topRelayPort;
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connect === 'function') {
      try {
        topRelayPort = chrome.runtime.connect({ name: 'glt-top-relay' });
        if (topRelayPort && topRelayPort.onMessage && typeof topRelayPort.onMessage.addListener === 'function') {
          topRelayPort.onMessage.addListener((msg) => {
            if (!isDestroyed) handleTopRelayMessage(msg);
          });
        }
        if (topRelayPort && topRelayPort.onDisconnect && typeof topRelayPort.onDisconnect.addListener === 'function') {
          topRelayPort.onDisconnect.addListener(() => {
            topRelayPort = null;
          });
        }
      } catch (e) {
        topRelayPort = null;
      }
    }
    return topRelayPort;
  }

  function findBestReadySubframe() {
    let bestId = null;
    let bestScore = -Infinity;
    knownSubframes.forEach((report, fid) => {
      if (failedSubframeIds.has(fid)) return;
      if (!report || !report.audiblePlayingCount || report.isPaused || report.isMuted) return;
      const sc = Number.isFinite(report.bestScore) ? report.bestScore : 0;
      if (sc > bestScore) {
        bestScore = sc;
        bestId = fid;
      }
    });
    return bestId;
  }

  function startSubframeRelay(frameId) {
    if (!isTopFrame || !isRunning || isDestroyed || frameId === null || frameId === undefined) return;
    stopSubframeRelayFromTop();
    cleanupAudioPipeline();
    if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
    activeSubframeId = frameId;
    audioSourceKind = 'subframe-relay';
    audioPipelineReady = true;
    subframeRelayPaused = false;
    subframeRelayMuted = false;
    lastAudioSentAt = now();
    ensureTopRelayPort();
    sendRuntimeMessageSafe({ type: 'RELAY_START_SUBFRAME_CAPTURE', targetFrameId: frameId });
    lastTabCaptureFallbackReason = '';
    corsSilenceFallbackTried = false;
    setDiagnostics({ AudioPipeline: 'running', AudioEngine: 'subframe-relay', MixTracks: 0 });
    startSilenceFlushTimer();
    updateActiveRunningStatus();
    flushAudioQueue();
  }

  function stopSubframeRelayFromTop() {
    if (activeSubframeId === null || activeSubframeId === undefined) return;
    const prevId = activeSubframeId;
    activeSubframeId = null;
    subframeRelayPaused = false;
    subframeRelayMuted = false;
    if (audioSourceKind === 'subframe-relay') {
      audioSourceKind = 'none';
      audioPipelineReady = false;
      setDiagnostics({ AudioEngine: 'none' });
    }
    sendRuntimeMessageSafe({ type: 'RELAY_STOP_SUBFRAME_CAPTURE', targetFrameId: prevId });
  }

  function hasCrossOriginIframeInRoot(root, state, shadowDepth, iframeDepth) {
    if (!root || shadowDepth > 16 || iframeDepth > 6 || state.visitedRoots.has(root)) return false;
    state.visitedRoots.add(root);

    const inspectFrameEl = (frameEl) => {
      if (!frameEl || isInsideExtensionHost(frameEl)) return false;
      let frameDoc = null;
      try {
        frameDoc = frameEl.contentDocument || (frameEl.contentWindow && frameEl.contentWindow.document) || null;
      } catch (e) {
        return true;
      }
      if (!frameDoc) return true;
      if (!state.visitedDocs.has(frameDoc)) {
        state.visitedDocs.add(frameDoc);
        const frameRoot = frameDoc.documentElement || frameDoc.body || frameDoc;
        if (hasCrossOriginIframeInRoot(frameRoot, state, 0, iframeDepth + 1)) return true;
      }
      return false;
    };

    if (typeof root.querySelectorAll === 'function') {
      try {
        const frames = root.querySelectorAll('iframe');
        for (let i = 0; i < frames.length; i++) {
          if (inspectFrameEl(frames[i])) return true;
        }
      } catch (e) {}
    }

    let walked = false;
    if (typeof document !== 'undefined' && typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
          acceptNode: (node) => (node === hostEl ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
        });
        walked = true;
        let cur = walker.nextNode();
        while (cur) {
          if (!isInsideExtensionHost(cur)) {
            const tag = cur.tagName ? String(cur.tagName).toUpperCase() : '';
            if (tag === 'IFRAME' || tag === 'FRAME') {
              if (inspectFrameEl(cur)) return true;
            }
            if (cur.shadowRoot && cur.shadowRoot !== shadowRoot) {
              if (hasCrossOriginIframeInRoot(cur.shadowRoot, state, shadowDepth + 1, iframeDepth)) return true;
            }
          }
          cur = walker.nextNode();
        }
      } catch (e) {
        walked = false;
      }
    }

    if (!walked && typeof root.querySelectorAll === 'function') {
      try {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const cur = all[i];
          if (!cur || isInsideExtensionHost(cur)) continue;
          const tag = cur.tagName ? String(cur.tagName).toUpperCase() : '';
          if (tag === 'IFRAME' || tag === 'FRAME') {
            if (inspectFrameEl(cur)) return true;
          }
          if (cur.shadowRoot && cur.shadowRoot !== shadowRoot) {
            if (hasCrossOriginIframeInRoot(cur.shadowRoot, state, shadowDepth + 1, iframeDepth)) return true;
          }
        }
      } catch (e) {}
    }
    return false;
  }

  function hasCrossOriginIframe() {
    try {
      if (typeof document === 'undefined') return false;
      const state = {
        visitedRoots: new WeakSet(),
        visitedDocs: new WeakSet()
      };
      state.visitedDocs.add(document);
      return hasCrossOriginIframeInRoot(document, state, 0, 0);
    } catch (e) {}
    return false;
  }

  function markTopFailedMedia(el) {
    if (!el) return;
    topFailedMedia.set(el, {
      src: el.currentSrc || el.src || '',
      srcObject: el.srcObject || null
    });
  }

  function clearTopFailedMedia(el) {
    if (el && topFailedMedia.has(el)) {
      topFailedMedia.delete(el);
    }
  }

  function isTopFailedMedia(el) {
    if (!el || !topFailedMedia.has(el)) return false;
    const prev = topFailedMedia.get(el);
    const curSrc = el.currentSrc || el.src || '';
    const curObj = el.srcObject || null;
    if (prev && prev.src === curSrc && prev.srcObject === curObj) {
      return true;
    }
    topFailedMedia.delete(el);
    return false;
  }

  function isNonRecoverableTabCaptureReason(reason) {
    return reason === 'security-error' ||
      reason === 'cors-silence' ||
      reason === 'subframe-cors' ||
      reason === 'cross-origin-iframe' ||
      (reason === 'no-video' && hasCrossOriginIframe());
  }

  function hasTopCorsOrSecurityBlockedMedia() {
    if (!isTopFrame) return false;
    if (hasCrossOriginIframe()) return true;
    if (failedSubframeIds.size > 0) return true;
    const media = collectCandidateMedia();
    for (let i = 0; i < media.length; i++) {
      if (isTopFailedMedia(media[i])) return true;
    }
    return false;
  }

  function tryTabCaptureFallback(reason, options) {
    const deferWarn = !!(options && options.deferWarn);
    if (!isTopFrame || !isRunning || isDestroyed || config.audioMode !== 'video') {
      return Promise.resolve(false);
    }
    if (tabCaptureActive) {
      if (audioSourceKind !== 'tab-capture') audioSourceKind = 'tab-capture';
      if (!audioPipelineReady) audioPipelineReady = true;
      return Promise.resolve(true);
    }
    if (tabCapturePending) {
      if (isNonRecoverableTabCaptureReason(reason)) {
        lastTabCaptureFallbackReason = reason;
      }
      return tabCapturePendingPromise || Promise.resolve(false);
    }
    if (tabCaptureFailedInSession) {
      if (isNonRecoverableTabCaptureReason(reason)) {
        lastTabCaptureFallbackReason = reason;
        if (!deferWarn) {
          setDiagnostics({ AudioFallback: 'unavailable' });
          setStatus('warn', '无法自动捕获跨源音频，请点击扩展图标后重试或切换麦克风', 'warn');
        }
      }
      return Promise.resolve(false);
    }
    const reqSeq = ++tabCaptureRequestSeq;
    tabCapturePending = true;
    tabCapturePendingPreempted = false;
    lastTabCaptureFallbackReason = reason || 'fallback';
    setDiagnostics({ AudioFallback: reason || 'fallback' });
    const p = sendRuntimeMessageSafe({ type: 'START_TAB_CAPTURE', reason: reason || 'fallback' }).then((resp) => {
      if (reqSeq !== tabCaptureRequestSeq) {
        if (resp && resp.ok && !tabCapturePendingPreempted && !tabCaptureActive && !tabCapturePending) {
          sendRuntimeMessageSafe({ type: 'STOP_TAB_CAPTURE' });
        }
        return false;
      }
      if (tabCapturePendingPromise === p) {
        tabCapturePendingPromise = null;
      }
      tabCapturePending = false;
      const wasPreempted = tabCapturePendingPreempted;
      tabCapturePendingPreempted = false;
      if (!isRunning || isDestroyed || config.audioMode !== 'video') {
        if (resp && resp.ok && !wasPreempted) sendRuntimeMessageSafe({ type: 'STOP_TAB_CAPTURE' });
        return false;
      }
      if (resp && resp.ok && wasPreempted) {
        tabCaptureFailedInSession = true;
        if (
          audioPipelineReady &&
          currentBoundVideo &&
          isPlayableMediaCandidate(currentBoundVideo) &&
          (workletNode || processorNode || mixerBus)
        ) {
          updateActiveRunningStatus();
          return false;
        }
        audioSourceKind = 'none';
        audioPipelineReady = false;
        setDiagnostics({ AudioEngine: 'none' });
        if (activeSession && activeSession.state === 'ready') {
          waitForVideoAndInit(activeSession, { preserveSessionOnFailure: true });
        }
        updateActiveRunningStatus();
        return false;
      }
      if (resp && resp.ok) {
        if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
        stopSubframeRelayFromTop();
        cleanupAudioPipeline();
        ensureTopRelayPort();
        tabCaptureActive = true;
        audioSourceKind = 'tab-capture';
        audioPipelineReady = true;
        corsSilenceDetected = false;
        lastAudioSentAt = now();
        setDiagnostics({ AudioPipeline: 'running', AudioEngine: 'tab-capture', CorsSilence: 'false', AudioFallback: reason || 'tab-capture' });
        startSilenceFlushTimer();
        updateActiveRunningStatus();
        flushAudioQueue();
        return true;
      }
      tabCaptureFailedInSession = true;
      if (isNonRecoverableTabCaptureReason(reason) && !deferWarn) {
        setDiagnostics({ AudioFallback: 'unavailable' });
        setStatus('warn', '无法自动捕获跨源音频，请点击扩展图标后重试或切换麦克风', 'warn');
      }
      return false;
    });
    tabCapturePendingPromise = p;
    return p;
  }

  function handleTopSecurityErrorFallback(session, options) {
    const opts = options || {};
    if (!isTopFrame || !isRunning || isDestroyed || config.audioMode !== 'video') return;
    if (session && activeSession && session !== activeSession) return;
    if (tabCaptureActive || tabCapturePending || audioSourceKind === 'tab-capture') return;
    if (audioSourceKind === 'subframe-relay' && activeSubframeId !== null) return;

    if (
      audioPipelineReady &&
      currentBoundVideo &&
      isPlayableMediaCandidate(currentBoundVideo) &&
      (workletNode || processorNode || mixerBus)
    ) {
      lastTabCaptureFallbackReason = '';
      corsSilenceFallbackTried = false;
      setDiagnostics({
        AudioPipeline: 'running',
        AudioEngine: mixerBus ? 'mixer' : (workletNode ? 'audio-worklet' : 'script-processor'),
        AudioFallback: 'top-media-preserved'
      });
      updateActiveRunningStatus();
      return;
    }

    const candidates = collectCandidateMedia();
    const mixable = collectMixableMedia(candidates);
    const nextMedia = findNextPlayableMedia();
    const nextSubId = findBestReadySubframe();
    const targetSession = session || activeSession;

    if (mixable.length >= 2 && targetSession && targetSession.state === 'ready') {
      if (audioPipelineReady || currentBoundVideo || audioSourceNode || mixerBus) {
        cleanupAudioPipeline();
      }
      runAudioInitForSession(targetSession, nextMedia || mixable[0], { preserveSessionOnFailure: true });
      return;
    }
    if (nextMedia && nextSubId !== null) {
      if (audioPipelineReady || currentBoundVideo || audioSourceNode || mixerBus) {
        cleanupAudioPipeline();
      }
      const subReport = knownSubframes.get(nextSubId);
      const subScore = (subReport && Number.isFinite(subReport.bestScore)) ? subReport.bestScore : -Infinity;
      if (subScore > scoreMediaCandidate(nextMedia)) {
        startSubframeRelay(nextSubId);
      } else if (targetSession && targetSession.state === 'ready') {
        runAudioInitForSession(targetSession, nextMedia, { preserveSessionOnFailure: true });
      }
      return;
    }
    if (nextMedia && targetSession && targetSession.state === 'ready') {
      if (audioPipelineReady || currentBoundVideo || audioSourceNode || mixerBus) {
        cleanupAudioPipeline();
      }
      runAudioInitForSession(targetSession, nextMedia, { preserveSessionOnFailure: true });
      return;
    }
    if (nextSubId !== null) {
      if (audioPipelineReady || currentBoundVideo || audioSourceNode || mixerBus) {
        cleanupAudioPipeline();
      }
      startSubframeRelay(nextSubId);
      return;
    }

    if (audioPipelineReady || currentBoundVideo || audioSourceNode || mixerBus) {
      cleanupAudioPipeline();
    }
    setDiagnostics({ AudioFallback: 'unavailable', AudioEngine: 'none' });
    if (opts.skipWaitTimer) {
      setDiagnostics({ AudioPipeline: 'error' });
    }
    setStatus('warn', '无法自动捕获跨源音频，请点击扩展图标后重试或切换麦克风', 'warn');
    if (!opts.skipWaitTimer && targetSession && targetSession.state === 'ready') {
      waitForVideoAndInit(targetSession, { preserveSessionOnFailure: true });
    }
  }

  function stopTabCaptureFallback() {
    tabCaptureRequestSeq++;
    tabCapturePendingPromise = null;
    if (!tabCaptureActive && !tabCapturePending) return;
    tabCaptureActive = false;
    tabCapturePending = false;
    tabCapturePendingPreempted = false;
    if (audioSourceKind === 'tab-capture') {
      audioSourceKind = 'none';
      audioPipelineReady = false;
      setDiagnostics({ AudioEngine: 'none' });
    }
    sendRuntimeMessageSafe({ type: 'STOP_TAB_CAPTURE' });
  }

  function handleTopRelayMessage(msg) {
    if (!msg || !isTopFrame || isDestroyed) return;
    const cmd = msg.action || msg.type;
    if (cmd === 'SUBFRAME_MEDIA_UPDATE' && typeof msg.frameId === 'number') {
      if (msg.report) {
        if (msg.report.audiblePlayingCount > 0 && !msg.report.isPaused && !msg.report.isMuted) {
          failedSubframeIds.delete(msg.frameId);
        }
        knownSubframes.set(msg.frameId, msg.report);
      }
      const canTakeoverFromCorsSilence = !!(corsSilenceDetected && currentBoundVideo && isTopFailedMedia(currentBoundVideo));
      const canTakeoverFromInactiveSubframe = !!(
        audioSourceKind === 'subframe-relay' &&
        (subframeRelayPaused || subframeRelayMuted) &&
        msg.frameId !== activeSubframeId
      );
      const canTakeoverFromGatedTopMedia = !!(
        audioSourceKind !== 'none' &&
        audioSourceKind !== 'tab-capture' &&
        audioSourceKind !== 'mic' &&
        audioSourceKind !== 'subframe-relay' &&
        isMediaInputGated() &&
        !findNextPlayableMedia()
      );
      if (isRunning && config.audioMode === 'video' && !tabCaptureActive && !tabCapturePending &&
          ((audioSourceKind === 'none' && !currentBoundVideo) || canTakeoverFromCorsSilence || canTakeoverFromInactiveSubframe || canTakeoverFromGatedTopMedia)) {
        if (msg.report && msg.report.audiblePlayingCount > 0 && !msg.report.isPaused && !msg.report.isMuted) {
          startSubframeRelay(msg.frameId);
        }
      }
      return;
    }
    if (cmd === 'SUBFRAME_AUDIO_CHUNK') {
      if (!isRunning || isDestroyed || config.audioMode !== 'video' || audioSourceKind !== 'subframe-relay') return;
      if (typeof msg.frameId === 'number' && activeSubframeId !== null && msg.frameId !== activeSubframeId) return;
      if (!subframeRelayPaused && !subframeRelayMuted && msg.b64Audio) {
        dispatchAudioChunk(msg.b64Audio);
        const vol = Number(msg.volume) || 0;
        renderVolume(vol);
        if (vol > 6) lastSpeechAt = now();
        setDiagnostics({ Volume: Math.round(vol) });
      }
      return;
    }
    if (cmd === 'SUBFRAME_MEDIA_STATE') {
      if (typeof msg.frameId === 'number') {
        const prevRep = knownSubframes.get(msg.frameId);
        if (prevRep) {
          prevRep.isPaused = !!msg.paused;
          prevRep.isMuted = !!msg.muted;
          if (msg.paused || msg.muted) {
            prevRep.audiblePlayingCount = 0;
          } else if (!prevRep.audiblePlayingCount) {
            prevRep.audiblePlayingCount = 1;
          }
        }
      }
      if (audioSourceKind !== 'subframe-relay') return;
      if (typeof msg.frameId === 'number' && activeSubframeId !== null && msg.frameId !== activeSubframeId) return;
      subframeRelayPaused = !!msg.paused;
      subframeRelayMuted = !!msg.muted;
      onMediaGatedTransition(subframeRelayPaused || subframeRelayMuted);
      if (isRunning && config.audioMode === 'video' && !tabCaptureActive && !tabCapturePending && (subframeRelayPaused || subframeRelayMuted)) {
        const nextSubId = findBestReadySubframe();
        if (nextSubId !== null && nextSubId !== activeSubframeId) {
          startSubframeRelay(nextSubId);
          return;
        }
        const nextPlayable = findNextPlayableMedia();
        if (nextPlayable && activeSession && activeSession.state === 'ready') {
          rebindActiveVideo(nextPlayable);
          return;
        }
      }
      updateActiveRunningStatus();
      return;
    }
    if (cmd === 'SUBFRAME_CORS_SILENCE' || cmd === 'SUBFRAME_CAPTURE_ERROR') {
      if (typeof msg.frameId === 'number') {
        knownSubframes.delete(msg.frameId);
        failedSubframeIds.add(msg.frameId);
      }
      if (!isRunning || isDestroyed || config.audioMode !== 'video' || audioSourceKind !== 'subframe-relay') return;
      if (typeof msg.frameId === 'number' && activeSubframeId !== null && msg.frameId !== activeSubframeId) return;
      stopSubframeRelayFromTop();
      const nextSubId = findBestReadySubframe();
      if (nextSubId !== null) {
        startSubframeRelay(nextSubId);
        return;
      }
      const fallbackReason = cmd === 'SUBFRAME_CORS_SILENCE' ? 'subframe-cors' : 'security-error';
      const targetSession = activeSession;
      tryTabCaptureFallback(fallbackReason, { deferWarn: true }).then((ok) => {
        if (!ok) handleTopSecurityErrorFallback(targetSession);
      });
      return;
    }
    if (cmd === 'SUBFRAME_DISCONNECTED' && typeof msg.frameId === 'number') {
      knownSubframes.delete(msg.frameId);
      failedSubframeIds.delete(msg.frameId);
      if (activeSubframeId === msg.frameId) {
        activeSubframeId = null;
        subframeRelayPaused = false;
        subframeRelayMuted = false;
        const wasSubframeRelay = audioSourceKind === 'subframe-relay';
        if (wasSubframeRelay) {
          audioSourceKind = 'none';
          audioPipelineReady = false;
          setDiagnostics({ AudioEngine: 'none' });
        }
        if (wasSubframeRelay || (!audioPipelineReady && !currentBoundVideo && audioSourceKind === 'none')) {
          if (isRunning && config.audioMode === 'video' && activeSession && activeSession.state === 'ready') {
            const nextSubId = findBestReadySubframe();
            if (nextSubId !== null) {
              startSubframeRelay(nextSubId);
            } else {
              runAudioInitForSession(activeSession, null, { preserveSessionOnFailure: true });
            }
          }
        }
      }
      return;
    }
    if (cmd === 'OFFSCREEN_AUDIO_CHUNK') {
      if (!isRunning || isDestroyed || config.audioMode !== 'video' || !tabCaptureActive || audioSourceKind !== 'tab-capture') return;
      if (msg.b64Audio) {
        dispatchAudioChunk(msg.b64Audio);
        const vol = Number(msg.volume) || 0;
        renderVolume(vol);
        if (vol > 6) lastSpeechAt = now();
        setDiagnostics({ Volume: Math.round(vol) });
      }
      return;
    }
    if (cmd === 'OFFSCREEN_STOPPED') {
      if (tabCapturePending && !tabCaptureActive) {
        tabCapturePendingPreempted = true;
        tabCaptureFailedInSession = true;
      }
      if (tabCaptureActive) {
        tabCaptureActive = false;
        tabCaptureFailedInSession = true;
        if (audioSourceKind === 'tab-capture') {
          audioSourceKind = 'none';
          audioPipelineReady = false;
          setDiagnostics({ AudioEngine: 'none' });
        }
        if (isRunning && config.audioMode === 'video' && activeSession && activeSession.state === 'ready') {
          waitForVideoAndInit(activeSession, { preserveSessionOnFailure: true });
          updateActiveRunningStatus();
        } else if (isRunning) {
          updateActiveRunningStatus();
        }
      }
    }
  }

  function emitSubframeMediaState() {
    if (isTopFrame || isDestroyed || !subframeCaptureActive) return;
    if (activeMixEntries.size > 0) {
      let allPaused = true;
      let anyUnmuted = false;
      let hasAudiblePlaying = false;
      activeMixEntries.forEach((entry) => {
        const el = entry && entry.el;
        if (!el || el.isConnected === false) return;
        if (!el.muted && el.volume > 0) anyUnmuted = true;
        if (!el.paused && !el.ended) {
          allPaused = false;
          if (!el.muted && el.volume > 0) {
            hasAudiblePlaying = true;
          }
        }
      });
      sendSubframeRelayMessage({
        type: 'SUBFRAME_MEDIA_STATE',
        paused: allPaused,
        muted: allPaused ? !anyUnmuted : !hasAudiblePlaying
      });
      return;
    }
    sendSubframeRelayMessage({
      type: 'SUBFRAME_MEDIA_STATE',
      paused: !currentBoundVideo || !!currentBoundVideo.paused,
      muted: !currentBoundVideo || !!(currentBoundVideo.muted || currentBoundVideo.volume === 0)
    });
  }

  function tryTopNonSecurityFailover(session, options) {
    const opts = options || {};
    if (!isTopFrame || !isRunning || isDestroyed || config.audioMode !== 'video') return false;
    if (!session || session !== activeSession || session.state !== 'ready') return false;
    if (tabCaptureActive || tabCapturePending || audioSourceKind === 'tab-capture') return false;
    const candidates = collectCandidateMedia();
    const mixable = collectMixableMedia(candidates);
    const nextMedia = findNextPlayableMedia();
    const nextSubId = findBestReadySubframe();

    if (mixable.length >= 2) {
      cleanupAudioPipeline();
      runAudioInitForSession(session, nextMedia || mixable[0], opts);
      return true;
    }
    if (nextMedia && nextSubId !== null) {
      cleanupAudioPipeline();
      const subReport = knownSubframes.get(nextSubId);
      const subScore = (subReport && Number.isFinite(subReport.bestScore)) ? subReport.bestScore : -Infinity;
      if (subScore > scoreMediaCandidate(nextMedia)) {
        startSubframeRelay(nextSubId);
      } else {
        runAudioInitForSession(session, nextMedia, opts);
      }
      return true;
    }
    if (nextMedia) {
      cleanupAudioPipeline();
      runAudioInitForSession(session, nextMedia, opts);
      return true;
    }
    if (nextSubId !== null) {
      cleanupAudioPipeline();
      startSubframeRelay(nextSubId);
      return true;
    }
    return false;
  }

  function runAudioInitForSession(session, preferredVideo, options) {
    const opts = options || {};
    return initAudioCapture(session, preferredVideo).then((completed) => {
      if (completed !== true || session !== activeSession || !isRunning || isDestroyed) return;
      flushAudioQueue();
      updateActiveRunningStatus();
      emitSubframeMediaState();
      setDiagnostics({ AudioPipeline: 'running' });
    }).catch((audioErr) => {
      if (session !== activeSession || !isRunning || isDestroyed) return;
      sessionLog('Audio capture failed', session, { error: sanitizeErrorMessage(audioErr), retryable: !!(audioErr && audioErr.retryable) });
      if (audioErr && audioErr.retryable) {
        if (currentBoundVideo) {
          detachVideoListeners(currentBoundVideo);
          currentBoundVideo = null;
        }
        currentBoundSrcObject = null;
        setDiagnostics({ AudioEngine: 'none', MixTracks: 0 });
        if (config.audioMode === 'video' && isTopFrame) {
          const subId = findBestReadySubframe();
          if (subId !== null) {
            startSubframeRelay(subId);
            return;
          }
          sendRuntimeMessageSafe({ type: 'ENSURE_SUBFRAMES_INJECTED' });
          sendRuntimeMessageSafe({ type: 'RELAY_SCAN_SUBFRAMES' }).then((scanRes) => {
            if (!isRunning || session !== activeSession || isDestroyed || audioPipelineReady) return;
            if (scanRes && Array.isArray(scanRes.subframes)) {
              for (let i = 0; i < scanRes.subframes.length; i++) {
                const rep = scanRes.subframes[i];
                if (rep && typeof rep.frameId === 'number' && !failedSubframeIds.has(rep.frameId)) {
                  knownSubframes.set(rep.frameId, rep);
                }
              }
            }
            const nextSub = findBestReadySubframe();
            if (nextSub !== null) {
              startSubframeRelay(nextSub);
            } else if (!tabCaptureActive && !tabCaptureFailedInSession) {
              tryTabCaptureFallback('no-video');
            }
          });
        }
        if (opts.preserveSessionOnFailure) {
          waitForVideoAndInit(session, opts);
        } else {
          waitForVideoAndInit(session);
        }
        return;
      }
      if (config.audioMode === 'video' && isTopFrame && audioErr && audioErr.name === 'SecurityError') {
        markTopFailedMedia((audioErr && audioErr.failedElement) || preferredVideo || currentBoundVideo);
        tryTabCaptureFallback('security-error', { deferWarn: true }).then((ok) => {
          if (!ok) handleTopSecurityErrorFallback(session);
        });
        return;
      } else if (!isTopFrame && subframeCaptureActive) {
        const failedEl = (audioErr && audioErr.failedElement) || currentBoundVideo || preferredVideo;
        if (failedEl) markSubframeMediaFailed(failedEl);
        cleanupAudioPipeline();
        const nextPlayable = failedEl ? findNextPlayableSubframeMedia() : null;
        if (nextPlayable) {
          runAudioInitForSession(session, nextPlayable);
          return;
        }
        failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(audioErr));
        return;
      } else if (config.audioMode === 'video' && isTopFrame) {
        const failedEl = (audioErr && audioErr.failedElement) || preferredVideo || currentBoundVideo;
        if (failedEl) markTopFailedMedia(failedEl);
        cleanupAudioPipeline();
        if (tryTopNonSecurityFailover(session, opts)) {
          return;
        }
        if (opts.preserveSessionOnFailure) {
          setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none', MixTracks: 0 });
          if (isRunning && !isConnectingUI) {
            updateActiveRunningStatus();
            if (!isNetworkOffline && !tabCaptureFailedInSession && !videoWaitTimer && !audioPipelineReady) {
              setStatus('warn', '音频捕获失败: ' + sanitizeErrorMessage((audioErr && audioErr.message) ? audioErr.message : audioErr), 'warn');
            }
          }
          return;
        }
      }
      const audioErrMsg = '音频启动失败: ' + sanitizeErrorMessage(audioErr && audioErr.message ? audioErr.message : audioErr);
      setStatus('err', audioErrMsg, 'error');
      setInitialPromptMessage(audioErrMsg);
      stopSubtitleService(false);
    });
  }

  function onSessionReady(session) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setInitialPromptMessage('正在监听音轨…');
    const isStandby = session === standbySession;

    if (isStandby) {
      if (drainingSession) {
        flushDrainingSession('drain-superseded');
      }
      const old = activeSession;
      activeSession = session;
      standbySession = null;
      session.rotationTimer = null;
      session.rotationPriority = 'normal';
      sessionLog('Rotation promoted', session, { previousSession: old ? old.id : null });
      if (old && old.state !== 'closed') {
        const hasPendingTranscript = !!(currentOrigBuffer.trim() || currentTransBuffer.trim() || commitGraceTimer);
        if (hasPendingTranscript) {
          drainingSession = old;
          old.drainTimer = setTimeout(() => {
            if (drainingSession === old) {
              flushDrainingSession('rotation-drain-timeout');
            }
          }, ROTATION_DRAIN_MS);
        } else {
          closeSession(old, 'rotated-out');
        }
      }
    } else {
      activeSession = session;
    }

    updateActiveRunningStatus();
    setDiagnostics({ Session: session.id, LastReadyAt: now() });
    renderVolume(0);

    const isRemoteRelayActive = (audioSourceKind === 'tab-capture' && tabCaptureActive) ||
      (audioSourceKind === 'subframe-relay' && activeSubframeId !== null);
    if (!isRemoteRelayActive && (!audioPipelineReady || !audioCtx || audioCtx.state === 'closed' || !(workletNode || processorNode))) {
      const preferred = pendingBindVideo;
      pendingBindVideo = null;
      const preserveOnReinit = !!(isStandby || (session && session.reason && session.reason !== 'start' && session.reason !== 'manual-restart'));
      runAudioInitForSession(session, preferred, preserveOnReinit ? { preserveSessionOnFailure: true } : undefined);
    } else {
      flushAudioQueue();
      if (isRemoteRelayActive && isTopFrame && audioSourceKind === 'subframe-relay' && activeSession === session) {
        reconcileActiveMedia();
      }
    }

    scheduleRotation(session, 'periodic', SESSION_ROTATE_MS);
  }

  function waitForVideoAndInit(session, options) {
    const opts = options || {};
    if (tabCaptureActive || audioSourceKind === 'tab-capture') return;
    if (videoWaitTimer) clearInterval(videoWaitTimer);
    if (!(isTopFrame && tabCaptureFailedInSession && hasTopCorsOrSecurityBlockedMedia())) {
      const waitMsg = '等待视频开始播放…（播放后自动开始同传）';
      setStatus('info', waitMsg, 'clock');
      setInitialPromptMessage(waitMsg);
    } else {
      updateActiveRunningStatus();
    }
    setDiagnostics({ AudioPipeline: 'waiting-video' });
    videoWaitTimer = setInterval(() => {
      if (!isRunning || session !== activeSession || isDestroyed) {
        clearInterval(videoWaitTimer);
        videoWaitTimer = null;
        return;
      }
      if (tabCaptureActive || audioSourceKind === 'tab-capture' || (audioSourceKind === 'subframe-relay' && activeSubframeId !== null)) {
        clearInterval(videoWaitTimer);
        videoWaitTimer = null;
        return;
      }
      if (tabCapturePending) return;
      const subId = isTopFrame ? findBestReadySubframe() : null;
      if (subId !== null) {
        clearInterval(videoWaitTimer);
        videoWaitTimer = null;
        startSubframeRelay(subId);
        return;
      }
      const video = findActiveMedia();
      if (!video || video.paused) return;
      clearInterval(videoWaitTimer);
      videoWaitTimer = null;
      const preferred = pendingBindVideo;
      pendingBindVideo = null;
      initAudioCapture(session, preferred).then((completed) => {
        if (completed !== true || session !== activeSession || !isRunning || isDestroyed) return;
        flushAudioQueue();
        updateActiveRunningStatus();
        emitSubframeMediaState();
        setDiagnostics({ AudioPipeline: 'running' });
      }).catch((err) => {
        if (session !== activeSession || !isRunning || isDestroyed) return;
        sessionLog('Audio capture retry failed', session, { error: sanitizeErrorMessage(err), retryable: !!(err && err.retryable) });
        if (err && err.retryable) {
          if (opts.preserveSessionOnFailure) {
            waitForVideoAndInit(session, opts);
          } else {
            waitForVideoAndInit(session);
          }
        } else if (!isTopFrame && subframeCaptureActive) {
          const failedEl = (err && err.failedElement) || currentBoundVideo || video;
          if (failedEl) markSubframeMediaFailed(failedEl);
          cleanupAudioPipeline();
          const nextPlayable = failedEl ? findNextPlayableSubframeMedia() : null;
          if (nextPlayable) {
            runAudioInitForSession(session, nextPlayable);
            return;
          }
          failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(err));
        } else if (config.audioMode === 'video' && isTopFrame && err && err.name === 'SecurityError') {
          markTopFailedMedia((err && err.failedElement) || video || currentBoundVideo);
          tryTabCaptureFallback('security-error', { deferWarn: true }).then((ok) => {
            if (!ok) handleTopSecurityErrorFallback(session);
          });
        } else {
          if (config.audioMode === 'video' && isTopFrame) {
            const failedEl = (err && err.failedElement) || video || currentBoundVideo;
            if (failedEl) markTopFailedMedia(failedEl);
            cleanupAudioPipeline();
            if (tryTopNonSecurityFailover(session, opts)) {
              return;
            }
            if (opts.preserveSessionOnFailure) {
              setDiagnostics({ AudioPipeline: 'error', AudioEngine: 'none', MixTracks: 0 });
              if (isRunning && !isConnectingUI) {
                updateActiveRunningStatus();
                if (!isNetworkOffline && !tabCaptureFailedInSession && !videoWaitTimer && !audioPipelineReady) {
                  setStatus('warn', '音频捕获失败: ' + sanitizeErrorMessage((err && err.message) ? err.message : err), 'warn');
                }
              }
              return;
            }
          }
          const retryErrMsg = '音频启动失败: ' + sanitizeErrorMessage(err && err.message ? err.message : err);
          setStatus('err', retryErrMsg, 'error');
          setInitialPromptMessage(retryErrMsg);
          stopSubtitleService(false);
        }
      });
    }, 1200);
  }

  function scheduleRotation(session, reason, delayMs) {
    if (!session || session !== activeSession) return;
    const isUrgent = reason === 'go-away' || reason === 'go-away-retry' || !!session.goAwayDeadlineAt;
    if (session.rotationTimer && session.rotationPriority === 'urgent' && !isUrgent) return;
    if (session.rotationTimer) clearTimeout(session.rotationTimer);
    session.rotationPriority = isUrgent ? 'urgent' : 'normal';
    const delay = (typeof delayMs === 'number' && Number.isFinite(delayMs))
      ? Math.max(300, delayMs)
      : SESSION_ROTATE_MS;
    session.rotationTimer = setTimeout(() => {
      session.rotationTimer = null;
      session.rotationPriority = 'normal';
      if (!isRunning || session !== activeSession || isNetworkOffline || isDestroyed) return;
      if (standbySession) {
        if (standbySession.state === 'closed') {
          standbySession = null;
        } else if (standbySession.state === 'ready') {
          return;
        } else if (!isUrgent) {
          return;
        } else {
          const age = now() - (standbySession.createdAt || 0);
          if (standbySession.urgent && age < STANDBY_URGENT_FRESH_MS) {
            return;
          }
          sessionLog('Preempting stalled standby for urgent rotation', standbySession, { reason, age });
          closeSession(standbySession, 'go-away-preempt');
          standbySession = null;
        }
      }
      sessionLog('Starting standby rotation', session, { reason, urgent: isUrgent });
      setDiagnostics({ RotationReason: reason });
      const standby = createSession(isUrgent ? 'go-away-rotation' : 'rotation');
      standby.urgent = isUrgent;
      standbySession = standby;
      connectSession(standby, { silent: true });
    }, delay);
  }

  function promoteStandbyOnActiveDrop() {
    if (!standbySession) return false;
    if (standbySession.state === 'closed') {
      standbySession = null;
      return false;
    }
    if (standbySession.state === 'ready') {
      const promoted = standbySession;
      standbySession = null;
      activeSession = promoted;
      promoted.rotationPriority = 'normal';
      isConnectingUI = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectAttempts = 0;
      consecutiveFailures = 0;
      circuitBreakerTripped = false;
      sessionLog('Promoted ready standby after active drop', promoted);
      updateActiveRunningStatus();
      setDiagnostics({ Session: promoted.id, LastReadyAt: promoted.readyAt || now() });
      flushAudioQueue();
      scheduleRotation(promoted, 'periodic', SESSION_ROTATE_MS);
      return true;
    }
    if (standbySession.state === 'connecting') {
      const promoted = standbySession;
      standbySession = null;
      activeSession = promoted;
      promoted.rotationPriority = 'normal';
      isConnectingUI = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      sessionLog('Promoted connecting standby after active drop', promoted);
      setStatus('warn', '主连接断开，正在切换备用连接…', 'spinner');
      setDiagnostics({ Session: promoted.id });
      return true;
    }
    return false;
  }

  function scheduleReconnect(reason) {
    if (!isRunning || isDestroyed) return;
    if (isNetworkOffline) {
      setStatus('warn', '网络已断开，等待恢复…', 'warn');
      return;
    }
    if (activeSession && (activeSession.state === 'ready' || activeSession.state === 'connecting')) return;
    if (promoteStandbyOnActiveDrop()) return;
    if (reconnectTimer || sessionStartTimer) return;
    if (isConnectingUI) isConnectingUI = false;

    consecutiveFailures++;
    reconnectAttempts++;
    if (consecutiveFailures >= MAX_RECONNECT_FAILURES || rapidFlapFailures >= MAX_RECONNECT_FAILURES) {
      circuitBreakerTripped = true;
      const detail = lastErrorSummary ? `（${lastErrorSummary}）` : '';
      const msg = `连续重连失败已达 ${MAX_RECONNECT_FAILURES} 次${detail}，请检查网络、代理或 API Key 后点击刷新按钮重试`;
      setDiagnostics({ CircuitBreaker: 'open', Reconnects: consecutiveFailures, ReconnectReason: reason });
      setStatus('err', msg, 'error');
      setInitialPromptMessage(msg);
      stopSubtitleService(false);
      return;
    }

    const delay = calculateBackoffDelay(reconnectAttempts - 1);
    setDiagnostics({ Reconnects: reconnectAttempts, ReconnectReason: reason });
    setStatus('warn', `连接断开，${(delay / 1000).toFixed(1)}s 后重连（第 ${reconnectAttempts} 次）`, 'spinner');

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isRunning || isDestroyed || isNetworkOffline) return;
      if (sessionStartTimer) return;
      if (activeSession && (activeSession.state === 'ready' || activeSession.state === 'connecting')) return;
      if (promoteStandbyOnActiveDrop()) return;
      const session = createSession('reconnect');
      connectSession(session);
    }, delay);
  }

  function manualRestart(reason) {
    if (!isTopFrame || !isRunning || isDestroyed) return;
    if (!checkExtensionContextHealth()) return;
    sessionLog('Manual restart', activeSession, { reason });
    commitCurrentLine(true, 'restart');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sessionStartTimer) { clearTimeout(sessionStartTimer); sessionStartTimer = null; }
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    closeDrainingSession('restart');
    if (standbySession) { closeSession(standbySession, 'restart'); standbySession = null; }
    if (activeSession) { closeSession(activeSession, 'restart'); activeSession = null; }
    stopTabCaptureFallback();
    stopSubframeRelayFromTop();
    cleanupAudioPipeline();
    tabCaptureRequestSeq++;
    tabCaptureFailedInSession = false;
    tabCapturePendingPreempted = false;
    tabCapturePendingPromise = null;
    lastTabCaptureFallbackReason = '';
    corsSilenceFallbackTried = false;
    topFailedMedia = new WeakMap();
    failedSubframeIds.clear();
    audioSendQueue.length = 0;
    reconnectAttempts = 0;
    consecutiveFailures = 0;
    rapidFlapFailures = 0;
    circuitBreakerTripped = false;
    lastErrorSummary = '';
    isConnectingUI = false;
    updateToggleIcon(true);
    setInitialPromptMessage('正在监听音轨…');
    setStatus('info', '正在连接…', 'spinner');
    setDiagnostics({ Reconnects: 0, Session: 0, CircuitBreaker: 'closed' });
    startWatchdog();
    startSilenceFlushTimer();
    sessionStartTimer = setTimeout(() => {
      sessionStartTimer = null;
      if (!isRunning || isDestroyed) return;
      connectSession(createSession('manual-restart'));
    }, 100);
  }

  function updateToggleIcon(running) {
    if (!btnToggle || !btnToggleIcon) return;
    btnToggle.setAttribute('aria-pressed', running ? 'true' : 'false');
    if (running) {
      btnToggle.classList.add('active');
      btnToggleIcon.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect>';
    } else {
      btnToggle.classList.remove('active');
      btnToggleIcon.innerHTML = '<polygon points="6 4 20 12 6 20 6 4"></polygon>';
    }
  }

  // ---- 看门狗 ----------------------------------------------------------

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (hadValidExtensionContext && !isExtensionContextValid()) {
        handleContextInvalidated();
        return;
      }
      if (!isTopFrame || !isRunning || isDestroyed || isNetworkOffline) return;

      checkUrlChangeFallback();
      ensureOverlayMounted();

      const boundInDocPiP = !!(currentBoundVideo && activeDocPiPWindow && !activeDocPiPWindow.closed && currentBoundVideo.ownerDocument === activeDocPiPWindow.document);
      if (config.audioMode === 'video' && currentBoundVideo && currentBoundVideo.isConnected === false && !boundInDocPiP) {
        runDomMediaCheck();
      } else if (
        config.audioMode === 'video' &&
        !tabCaptureActive &&
        !tabCapturePending &&
        audioSourceKind !== 'tab-capture' &&
        (audioPipelineReady || (!currentBoundVideo && audioSourceKind === 'none'))
      ) {
        reconcileActiveMedia();
      }

      // 未连接且无重连计划 → 兜底重连
      if (!activeSession || activeSession.state === 'closed') {
        if (!reconnectTimer && !sessionStartTimer && !isConnectingUI) {
          scheduleReconnect('watchdog-no-session');
        }
        return;
      }

      const s = activeSession;
      if (s.state === 'ready') {
        let videoInactive = false;
        if (config.audioMode === 'video') {
          if (audioSourceKind === 'tab-capture' && tabCaptureActive) {
            videoInactive = false;
          } else if (audioSourceKind === 'subframe-relay' && activeSubframeId !== null) {
            videoInactive = subframeRelayPaused || subframeRelayMuted;
          } else if (activeMixEntries.size > 0) {
            videoInactive = isMediaInputGated();
          } else {
            videoInactive = (
              isVideoPaused ||
              !audioPipelineReady ||
              !currentBoundVideo ||
              (currentBoundVideo.isConnected === false && !boundInDocPiP) ||
              currentBoundVideo.paused ||
              currentBoundVideo.ended ||
              currentBoundVideo.muted ||
              currentBoundVideo.volume === 0
            );
          }
        }

        if (!videoInactive && audioPipelineReady) {
          const t = now();
          const speechRecent = t - lastSpeechAt < 8000;
          const serverIdle = t - (s.lastServerMsgAt || s.readyAt || t);

          // 仅在近期有语音输入或极长时间无响应时触发静默重建，避免安静无台词片段误重连
          if ((speechRecent && serverIdle > SERVER_SILENCE_RECONNECT_MS) || serverIdle > SERVER_SILENCE_RECONNECT_MS * 2) {
            sessionLog('Watchdog: server silent too long', s, { serverIdle });
            forceReconnect('server-silent');
            return;
          }

          const transcribeIdle = t - (s.lastTranscriptionAt || s.readyAt || t);
          if (speechRecent && transcribeIdle > NO_TRANSCRIPTION_RECONNECT_MS) {
            sessionLog('Watchdog: speech but no transcription', s, { transcribeIdle });
            forceReconnect('no-transcription');
            return;
          }

          // 原文持续产出但译文长时间停滞（含会话启动后一直未产出首条译文的情形）
          if (config.displayMode !== 'orig') {
            const origActive = t - (s.lastOrigAt || 0) < 10000;
            const outWaitAnchor = s.firstOrigSinceOutAt || s.lastOutAt || 0;
            if (origActive && outWaitAnchor > 0 && (t - outWaitAnchor) > NO_TRANSLATION_RECONNECT_MS) {
              sessionLog('Watchdog: transcription flowing but translation stalled', s, { outIdle: t - outWaitAnchor });
              forceReconnect('translation-stall');
              return;
            }
          }
        }

        if (audioPipelineReady && audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        if (audioPipelineReady && !videoInactive && now() - lastAudioSentAt > 5000) {
          sessionLog('Watchdog: audio pipeline stalled', s, { sinceLastSent: now() - lastAudioSentAt });
          try { resetResampler(audioCtx ? audioCtx.sampleRate : 48000); } catch (e) {}
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        }
      }
    }, 2500);
  }

  function forceReconnect(reason) {
    closeDrainingSession('force-reconnect');
    if (standbySession) {
      closeSession(standbySession, 'force-reconnect-standby');
      standbySession = null;
    }
    const old = activeSession;
    if (old) {
      closeSession(old, 'force-reconnect:' + reason);
      activeSession = null;
    }
    if (!reconnectTimer) scheduleReconnect(reason);
  }

  // ========================================================================
  // 8. 服务启停与实例销毁
  // ========================================================================

  function handleContextInvalidated() {
    if (isContextInvalidated || isDestroyed) return;
    isContextInvalidated = true;
    wasRunningBeforeHide = false;
    isStartingPending = false;
    if (contextCheckTimer) { clearInterval(contextCheckTimer); contextCheckTimer = null; }
    stopSubtitleService(false);
    if (saveConfigTimer) { clearTimeout(saveConfigTimer); saveConfigTimer = null; }
    recentLocalPersistSnapshots.length = 0;
    seenInFlightStorageSnapshots.length = 0;
    if (configLoadTimer) { clearTimeout(configLoadTimer); configLoadTimer = null; }
    if (resizePersistTimer) { clearTimeout(resizePersistTimer); resizePersistTimer = null; }

    if (!isTopFrame) return;

    const msg = '扩展已更新或重载，请刷新页面后继续使用';
    setStatus('err', msg, 'warn');
    if (hostEl) hostEl.dataset.gltContextValid = 'false';

    if (btnToggle) {
      btnToggle.disabled = true;
      btnToggle.title = msg;
    }
    if (btnReconnect) {
      btnReconnect.title = '刷新页面以恢复扩展连接';
    }
    if (subBody && overlay) {
      const existingNotice = overlay.querySelector('#gSubContextInvalidatedNotice');
      if (!existingNotice) {
        const notice = document.createElement('div');
        notice.id = 'gSubContextInvalidatedNotice';
        notice.className = 'g-sub-entry';
        notice.innerHTML = `<div class="g-sub-trans" style="font-size: 14px; color: #fbbf24; font-weight: 500;">${escapeHtml(msg)}</div>`;
        const initPrompt = overlay.querySelector('#gSubInitialPrompt');
        if (initPrompt) initPrompt.remove();
        subBody.appendChild(notice);
        safeScrollToBottom();
      }
    }
  }

  function checkExtensionContextHealth() {
    if (isDestroyed || isContextInvalidated) return false;
    if (hadValidExtensionContext && !isExtensionContextValid()) {
      handleContextInvalidated();
      return false;
    }
    return true;
  }

  function onDocumentVisibilityChange() {
    if (document.visibilityState === 'visible') {
      checkExtensionContextHealth();
    }
  }
  document.addEventListener('visibilitychange', onDocumentVisibilityChange);

  function startSubtitleService(isManualStart = true) {
    if (!isTopFrame || isRunning || isDestroyed) return;
    if (!checkExtensionContextHealth()) return;
    if (!isConfigReady) {
      if (isStartingPending) return;
      isStartingPending = true;
      setStatus('info', '正在加载配置…', 'spinner');
      configReadyPromise.then(() => {
        if (!isStartingPending || isDestroyed) return;
        isStartingPending = false;
        startSubtitleService(isManualStart);
      });
      return;
    }
    isStartingPending = false;
    isRunning = true;
    wasRunningBeforeHide = false;
    tabCaptureRequestSeq++;
    tabCaptureFailedInSession = false;
    tabCapturePendingPreempted = false;
    tabCapturePendingPromise = null;
    lastTabCaptureFallbackReason = '';
    corsSilenceFallbackTried = false;
    topFailedMedia = new WeakMap();
    failedSubframeIds.clear();
    isNetworkOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    reconnectAttempts = 0;
    consecutiveFailures = 0;
    rapidFlapFailures = 0;
    circuitBreakerTripped = false;
    lastErrorSummary = '';
    setInitialPromptMessage('正在监听音轨…');
    setDiagnostics({ CircuitBreaker: 'closed' });
    updateToggleIcon(true);
    ensureTopRelayPort();
    sendRuntimeMessageSafe({ type: 'ENSURE_SUBFRAMES_INJECTED' });
    sendRuntimeMessageSafe({ type: 'RELAY_SCAN_SUBFRAMES' });
    if (isNetworkOffline) {
      setStatus('warn', '网络已断开，等待恢复…', 'warn');
    } else {
      setStatus('info', '正在连接…', 'spinner');
    }
    startWatchdog();
    startSilenceFlushTimer();
    activeSession = null;
    if (!isNetworkOffline) {
      connectSession(createSession('start'));
    }
    if (isManualStart && pendingSaveKeys.size > 0) saveConfig(true);
  }

  function stopSubtitleService(isManual = false) {
    if (isManual) overlayShowSeq++;
    isRunning = false;
    isStartingPending = false;
    isConnectingUI = false;

    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sessionStartTimer) { clearTimeout(sessionStartTimer); sessionStartTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (silenceFlushTimer) { clearInterval(silenceFlushTimer); silenceFlushTimer = null; }
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    if (spaNavDebounce) { clearTimeout(spaNavDebounce); spaNavDebounce = null; }
    if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
    if (domCheckDebounce) { clearTimeout(domCheckDebounce); domCheckDebounce = null; }
    if (mediaReconcileDebounce) { clearTimeout(mediaReconcileDebounce); mediaReconcileDebounce = null; }

    closeDrainingSession('service-stop');
    if (standbySession) { closeSession(standbySession, 'service-stop'); standbySession = null; }
    if (activeSession) { closeSession(activeSession, 'service-stop'); activeSession = null; }

    stopTabCaptureFallback();
    stopSubframeRelayFromTop();
    lastTabCaptureFallbackReason = '';
    corsSilenceFallbackTried = false;
    topFailedMedia = new WeakMap();
    failedSubframeIds.clear();
    pendingBindVideo = null;
    cleanupAudioPipeline();
    if (isTopFrame) {
      commitCurrentLine(true, 'service-stop');
      updateToggleIcon(false);
      if (isManual) {
        setStatus('idle', '已暂停', 'pauseCircle');
        setInitialPromptMessage('已暂停，点击左上角播放按钮继续同传');
        setDiagnostics({ Session: 0 });
      }
    }
  }

  function teardownInstance() {
    if (isDestroyed) return;
    isDestroyed = true;
    overlayShowSeq++;
    finishConfigReady();
    stopSubtitleService(false);
    cleanupMixCandidateObservers();
    if (typeof stopSubframeCapture === 'function') stopSubframeCapture();
    if (saveConfigTimer) { clearTimeout(saveConfigTimer); saveConfigTimer = null; }
    recentLocalPersistSnapshots.length = 0;
    seenInFlightStorageSnapshots.length = 0;
    if (configLoadTimer) { clearTimeout(configLoadTimer); configLoadTimer = null; }
    if (resizePersistTimer) { clearTimeout(resizePersistTimer); resizePersistTimer = null; }
    if (syncStyleTimer) { clearTimeout(syncStyleTimer); syncStyleTimer = null; }
    if (subframeMediaScanTimer) { clearTimeout(subframeMediaScanTimer); subframeMediaScanTimer = null; }
    isSyncingOverlayStyle = false;
    if (contextCheckTimer) { clearInterval(contextCheckTimer); contextCheckTimer = null; }
    if (resizeRafId !== null) { cancelAnimationFrame(resizeRafId); resizeRafId = null; }
    if (viewportRafId !== null) { cancelAnimationFrame(viewportRafId); viewportRafId = null; }
    cancelPendingScroll();
    const prevDragPointerId = activeDragPointerId;
    isDragging = false;
    dragMode = null;
    activeDragPointerId = null;
    if (header) {
      if (prevDragPointerId !== null && typeof header.releasePointerCapture === 'function') {
        try { header.releasePointerCapture(prevDragPointerId); } catch (e) {}
      }
      try {
        header.removeEventListener('pointermove', onHeaderPointerMove);
        header.removeEventListener('pointerup', onHeaderPointerUp);
        header.removeEventListener('pointercancel', onHeaderPointerUp);
      } catch (e) {}
    }
    if (docPointerBound) {
      docPointerBound = false;
      document.removeEventListener('pointermove', onHeaderPointerMove);
      document.removeEventListener('pointerup', onHeaderPointerUp);
      document.removeEventListener('pointercancel', onHeaderPointerUp);
    }
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    window.removeEventListener('blur', onDragEnd);
    if (overlayResizeObserver) {
      try { overlayResizeObserver.disconnect(); } catch (e) {}
      overlayResizeObserver = null;
    }
    if (titleObserver) {
      try { titleObserver.disconnect(); } catch (e) {}
      titleObserver = null;
    }
    if (domMediaObserver) {
      try { domMediaObserver.disconnect(); } catch (e) {}
      domMediaObserver = null;
    }
    document.removeEventListener('gemini-live-translator-teardown', teardownInstance);
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
    document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    document.removeEventListener('enterpictureinpicture', onEnterPiP, true);
    document.removeEventListener('leavepictureinpicture', onLeavePiP, true);
    if (docPiPRef && typeof docPiPRef.removeEventListener === 'function') {
      try { docPiPRef.removeEventListener('enter', onDocPiPEnter); } catch (e) {}
      docPiPRef = null;
    }
    if (docPiPPageHideTarget && onDocPiPWindowPageHide) {
      try { docPiPPageHideTarget.removeEventListener('pagehide', onDocPiPWindowPageHide); } catch (e) {}
      docPiPPageHideTarget = null;
      onDocPiPWindowPageHide = null;
    }
    while (shadowRootPlayTargets.length > 0) {
      const sr = shadowRootPlayTargets.pop();
      try { sr.removeEventListener('play', onDocumentVideoPlay, true); } catch (e) {}
      try { sr.removeEventListener('volumechange', onDocumentVideoVolumeChange, true); } catch (e) {}
    }
    while (subDocPlayTargets.length > 0) {
      const doc = subDocPlayTargets.pop();
      try { doc.removeEventListener('play', onDocumentVideoPlay, true); } catch (e) {}
      try { doc.removeEventListener('volumechange', onDocumentVideoVolumeChange, true); } catch (e) {}
    }
    while (iframeLoadTargets.length > 0) {
      const ifr = iframeLoadTargets.pop();
      try { ifr.removeEventListener('load', onIframeLoad); } catch (e) {}
    }
    document.removeEventListener('play', onDocumentVideoPlay, true);
    document.removeEventListener('volumechange', onDocumentVideoVolumeChange, true);
    document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('offline', onNetworkOffline);
    window.removeEventListener('online', onNetworkOnline);
    window.removeEventListener('popstate', onSpaNavigationDetected);
    window.removeEventListener('locationchange', onSpaNavigationDetected);
    window.removeEventListener('glt-spa-navigate', onSpaNavigationDetected);
    window.removeEventListener('hashchange', onSpaNavigationDetected);
    window.removeEventListener('yt-navigate-finish', onSpaNavigationDetected);
    if (navigationRef && typeof navigationRef.removeEventListener === 'function') {
      try { navigationRef.removeEventListener('currententrychange', onSpaNavigationDetected); } catch (e) {}
      navigationRef = null;
    }
    if (topRelayPort) {
      try { topRelayPort.disconnect(); } catch (e) {}
      topRelayPort = null;
    }
    if (subframeRelayPort) {
      try { subframeRelayPort.disconnect(); } catch (e) {}
      subframeRelayPort = null;
    }
    if (runtimeMessageListener) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
          chrome.runtime.onMessage.removeListener(runtimeMessageListener);
        }
      } catch (e) {}
      runtimeMessageListener = null;
    }
    if (storageChangeListener) {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
          chrome.storage.onChanged.removeListener(storageChangeListener);
        }
      } catch (e) {}
      storageChangeListener = null;
    }
    try {
      if (origHistoryPushState && history.pushState === wrappedHistoryPushState) {
        history.pushState = origHistoryPushState;
      }
      if (origHistoryReplaceState && history.replaceState === wrappedHistoryReplaceState) {
        history.replaceState = origHistoryReplaceState;
      }
      if (window.__geminiLiveHistoryHooked) window.__geminiLiveHistoryHooked = false;
      window.__geminiLiveTranslatorLoaded = false;
      window.__geminiLiveIsAlive = () => false;
    } catch (e) {}
    hideHostFromTopLayer();
    try { if (hostEl) hostEl.remove(); } catch (e) {}
  }

  document.addEventListener('gemini-live-translator-teardown', teardownInstance);

  function toggleOverlayVisibility() {
    if (!isTopFrame || !overlay) return;
    if (overlay.style.display === 'none' || !overlay.style.display) {
      ensureOverlayMounted();
      overlay.style.display = 'flex';
      applyInitialStyles();
      handleFullscreenChange();
      if (!isRunning) startSubtitleService(true);
    } else {
      overlayShowSeq++;
      wasRunningBeforeHide = false;
      overlay.style.display = 'none';
      hideHostFromTopLayer();
      closeAllCustomDropdowns();
      setSettingsPanelOpen(false, false);
      if (isRunning || isStartingPending) stopSubtitleService(true);
    }
  }

  // ========================================================================
  // 9. 配置加载与消息接口 / 跨源子帧代理
  // ========================================================================

  let isConfigReady = false;
  let hasStorageChangedBeforeLoad = false;
  let configLoadTimer = null;
  let resolveConfigReady = null;
  const configReadyPromise = new Promise((resolve) => {
    resolveConfigReady = resolve;
  });

  function finishConfigReady() {
    if (configLoadTimer) {
      clearTimeout(configLoadTimer);
      configLoadTimer = null;
    }
    if (isConfigReady) return;
    isConfigReady = true;
    if (resolveConfigReady) resolveConfigReady();
  }

  function loadStoredConfig(callback) {
    try {
      if (isExtensionContextValid() && chrome.storage && chrome.storage.local) {
        let settledByTimeout = false;
        configLoadTimer = setTimeout(() => {
          configLoadTimer = null;
          if (isConfigReady || isDestroyed) return;
          settledByTimeout = true;
          finishConfigReady();
          if (callback) callback();
        }, CONFIG_LOAD_TIMEOUT_MS);

        chrome.storage.local.get(['geminiLiveConfig'], (res) => {
          if (configLoadTimer) {
            clearTimeout(configLoadTimer);
            configLoadTimer = null;
          }
          const alreadyReady = isConfigReady || settledByTimeout;
          try {
            if (!alreadyReady && !isDestroyed && !(chrome.runtime && chrome.runtime.lastError)) {
              if (!hasStorageChangedBeforeLoad && res && res.geminiLiveConfig) {
                applyConfigUpdate(res.geminiLiveConfig, { isFullSnapshot: true });
              }
            }
          } catch (e) {}
          finishConfigReady();
          if (!alreadyReady && callback) callback();
        });
        return;
      }
    } catch (e) {}
    finishConfigReady();
    if (callback) callback();
  }

  function ensureSubframeRelayPort() {
    if (isTopFrame || isDestroyed) return null;
    if (subframeRelayPort) return subframeRelayPort;
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connect === 'function') {
      try {
        subframeRelayPort = chrome.runtime.connect({ name: 'glt-subframe-audio' });
        if (subframeRelayPort && subframeRelayPort.onDisconnect && typeof subframeRelayPort.onDisconnect.addListener === 'function') {
          subframeRelayPort.onDisconnect.addListener(() => {
            subframeRelayPort = null;
          });
        }
      } catch (e) {
        subframeRelayPort = null;
      }
    }
    return subframeRelayPort;
  }

  function sendSubframeRelayMessage(payload) {
    if (isTopFrame || isDestroyed) return;
    const port = ensureSubframeRelayPort();
    if (port && typeof port.postMessage === 'function') {
      try {
        port.postMessage(payload);
        return;
      } catch (e) {
        subframeRelayPort = null;
      }
    }
    sendRuntimeMessageSafe(payload);
  }

  function markSubframeMediaFailed(el) {
    if (!el) return;
    subframeFailedMedia.set(el, {
      src: el.currentSrc || el.src || '',
      srcObject: el.srcObject || null
    });
  }

  function isSubframeMediaFailed(el) {
    if (!el || !subframeFailedMedia.has(el)) return false;
    const prev = subframeFailedMedia.get(el);
    const curSrc = el.currentSrc || el.src || '';
    const curObj = el.srcObject || null;
    if (prev && prev.src === curSrc && prev.srcObject === curObj) {
      return true;
    }
    subframeFailedMedia.delete(el);
    return false;
  }

  function isPlayableMediaCandidate(el) {
    if (!el || el.isConnected === false || el.paused || el.ended || el.muted || el.volume === 0) return false;
    if (!isTopFrame && isSubframeMediaFailed(el)) return false;
    if (isTopFrame && isTopFailedMedia(el)) return false;
    if (isMediaStreamLike(el.srcObject) && !hasLiveAudioTrack(el.srcObject)) return false;
    return true;
  }

  function findNextPlayableMedia() {
    const candidates = collectCandidateMedia();
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!isPlayableMediaCandidate(el)) continue;
      const sc = scoreMediaCandidate(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
    return best;
  }

  function findNextPlayableSubframeMedia() {
    return findNextPlayableMedia();
  }

  function buildSubframeMediaReport() {
    const media = collectCandidateMedia();
    let bestScore = -Infinity;
    let audiblePlayingCount = 0;
    let bestEl = null;
    for (let i = 0; i < media.length; i++) {
      const el = media[i];
      if (isSubframeMediaFailed(el)) continue;
      const sc = scoreMediaCandidate(el);
      if (sc > bestScore) {
        bestScore = sc;
        bestEl = el;
      }
      if (!el.paused && !el.ended && !el.muted && el.volume > 0 && el.isConnected !== false) {
        audiblePlayingCount++;
      }
    }
    return {
      mediaCount: media.length,
      bestScore: Number.isFinite(bestScore) ? bestScore : -1000,
      audiblePlayingCount: audiblePlayingCount,
      isPaused: bestEl ? !!bestEl.paused : true,
      isMuted: bestEl ? !!(bestEl.muted || bestEl.volume === 0) : false
    };
  }

  function reportSubframeMedia() {
    if (isTopFrame || isDestroyed || isSameOriginWithParent()) return;
    const report = buildSubframeMediaReport();
    sendRuntimeMessageSafe({ type: 'SUBFRAME_MEDIA_REPORT', report: report });
  }

  function stopSubframeCapture(options) {
    if (isTopFrame) return;
    const disconnectPort = !!(options && options.disconnectPort);
    subframeCaptureActive = false;
    isRunning = false;
    if (activeSession) {
      activeSession.state = 'closed';
      activeSession = null;
    }
    cleanupAudioPipeline();
    if (disconnectPort && subframeRelayPort) {
      try { subframeRelayPort.disconnect(); } catch (e) {}
      subframeRelayPort = null;
    }
  }

  function failSubframeCapture(type, errorText) {
    if (isTopFrame) return;
    subframeCaptureActive = false;
    isRunning = false;
    const payload = errorText !== undefined ? { type, error: errorText } : { type };
    sendSubframeRelayMessage(payload);
    stopSubframeCapture({ disconnectPort: true });
  }

  function startSubframeCapture() {
    if (isTopFrame || isDestroyed || isSameOriginWithParent()) return;
    if (activeSession) {
      activeSession.state = 'closed';
    }
    subframeCaptureActive = true;
    isRunning = true;
    config.audioMode = 'video';
    ensureSubframeRelayPort();
    const fakeSession = { id: ++sessionSeq, state: 'ready' };
    activeSession = fakeSession;
    initAudioCapture(fakeSession, null).then((completed) => {
      if (completed !== true || !subframeCaptureActive || !isRunning || isDestroyed || activeSession !== fakeSession || fakeSession.state !== 'ready') return;
      emitSubframeMediaState();
    }).catch((err) => {
      if (!subframeCaptureActive || !isRunning || isDestroyed || activeSession !== fakeSession || fakeSession.state !== 'ready') return;
      if (err && err.retryable) {
        cleanupAudioPipeline();
        emitSubframeMediaState();
        waitForVideoAndInit(fakeSession);
        return;
      }
      const failedEl = (err && err.failedElement) || currentBoundVideo;
      if (failedEl) markSubframeMediaFailed(failedEl);
      cleanupAudioPipeline();
      const nextPlayable = failedEl ? findNextPlayableSubframeMedia() : null;
      if (nextPlayable) {
        runAudioInitForSession(fakeSession, nextPlayable);
        return;
      }
      failSubframeCapture('SUBFRAME_CAPTURE_ERROR', sanitizeErrorMessage(err));
    });
  }

  function attachSubframeMessageListener() {
    try {
      if (!isExtensionContextValid() || !chrome.runtime || !chrome.runtime.onMessage) return;
      runtimeMessageListener = (msg) => {
        if (!msg || isDestroyed) return false;
        const cmd = msg.action || msg.type;
        if (cmd === 'SUBFRAME_SCAN_MEDIA') {
          reportSubframeMedia();
          return false;
        }
        if (cmd === 'SUBFRAME_START_CAPTURE') {
          startSubframeCapture();
          return false;
        }
        if (cmd === 'SUBFRAME_STOP_CAPTURE') {
          const wasCapturing = subframeCaptureActive;
          stopSubframeCapture();
          if (wasCapturing && !isDestroyed) reportSubframeMedia();
          return false;
        }
        // 子帧严格忽略顶层窗口控制指令（禁止调用 sendResponse 抢答）
        return false;
      };
      chrome.runtime.onMessage.addListener(runtimeMessageListener);
    } catch (e) {}
  }

  function initSubframeAgent() {
    attachSubframeMessageListener();
    subframeMediaScanTimer = setTimeout(() => {
      subframeMediaScanTimer = null;
      reportSubframeMedia();
    }, 150);
  }

  function attachMessageListener() {
    try {
      if (!isExtensionContextValid() || !chrome.runtime || !chrome.runtime.onMessage) return;
      runtimeMessageListener = (msg, sender, sendResponse) => {
        if (!msg || isDestroyed) return false;
        const cmd = msg.action || msg.type;
        if (cmd === 'SUBFRAME_MEDIA_UPDATE' || cmd === 'SUBFRAME_AUDIO_CHUNK' || cmd === 'SUBFRAME_MEDIA_STATE' ||
            cmd === 'SUBFRAME_CORS_SILENCE' || cmd === 'SUBFRAME_CAPTURE_ERROR' || cmd === 'SUBFRAME_DISCONNECTED' ||
            cmd === 'OFFSCREEN_AUDIO_CHUNK' || cmd === 'OFFSCREEN_STOPPED') {
          handleTopRelayMessage(msg);
          return false;
        }
        if (msg.action === 'PING') {
          sendResponse({ status: 'PONG', version: EXTENSION_VERSION, running: isRunning });
          return false;
        }
        if (msg.action === 'CHECK_OVERLAY_VISIBLE') {
          const isVisible = !!(overlay && overlay.style.display !== 'none' && overlay.style.display !== '');
          sendResponse({ status: 'OK', isVisible: isVisible, running: isRunning });
          return false;
        }
        if (msg.action === 'SHOW_OVERLAY') {
          const myShowToken = ++overlayShowSeq;
          configReadyPromise.then(() => {
            if (isDestroyed) {
              try { sendResponse({ status: 'ERROR', error: 'destroyed' }); } catch (e) {}
              return;
            }
            if (!checkExtensionContextHealth()) {
              try { sendResponse({ status: 'ERROR', error: 'context_invalidated' }); } catch (e) {}
              return;
            }
            if (myShowToken !== overlayShowSeq) {
              const visibleNow = !!(overlay && overlay.style.display !== 'none' && overlay.style.display !== '');
              try { sendResponse({ status: 'OK', isVisible: visibleNow, cancelled: true }); } catch (e) {}
              return;
            }
            if (msg.config && typeof msg.config === 'object') {
              applyConfigUpdate(msg.config);
            }
            ensureOverlayMounted();
            if (overlay.style.display === 'none' || !overlay.style.display) {
              overlay.style.display = 'flex';
              applyInitialStyles();
              handleFullscreenChange();
              if (!isRunning) startSubtitleService(true);
            } else if (!isRunning) {
              handleFullscreenChange();
              startSubtitleService(true);
            }
            try { sendResponse({ status: 'OK', isVisible: true }); } catch (e) {}
          });
          return true;
        }
        if (msg.action === 'TOGGLE_OVERLAY') {
          const myShowToken = ++overlayShowSeq;
          configReadyPromise.then(() => {
            if (isDestroyed) {
              try { sendResponse({ status: 'ERROR', error: 'destroyed' }); } catch (e) {}
              return;
            }
            if (!checkExtensionContextHealth()) {
              try { sendResponse({ status: 'ERROR', error: 'context_invalidated' }); } catch (e) {}
              return;
            }
            if (myShowToken !== overlayShowSeq) {
              const visibleNow = !!(overlay && overlay.style.display !== 'none' && overlay.style.display !== '');
              try { sendResponse({ status: 'OK', isVisible: visibleNow, cancelled: true }); } catch (e) {}
              return;
            }
            toggleOverlayVisibility();
            try { sendResponse({ status: 'OK', isVisible: overlay.style.display !== 'none' }); } catch (e) {}
          });
          return true;
        }
        if (msg.action === 'GET_STATE') {
          configReadyPromise.then(() => {
            if (isDestroyed) {
              try { sendResponse({ status: 'ERROR', error: 'destroyed' }); } catch (e) {}
              return;
            }
            const isVisible = !!(overlay && overlay.style.display !== 'none' && overlay.style.display !== '');
            const ctxValid = !isContextInvalidated && isExtensionContextValid();
            try {
              sendResponse({
                status: 'OK',
                version: EXTENSION_VERSION,
                running: isRunning,
                isRunning: isRunning,
                isVisible: isVisible,
                isPaused: !isRunning || (config.audioMode === 'video' && isVideoPaused),
                statusKind: currentStatusKind,
                statusText: currentStatusText,
                audioMode: config.audioMode,
                mediaCount: collectCandidateVideos().length,
                isContextValid: ctxValid,
                circuitBreaker: circuitBreakerTripped,
                sessionId: activeSession ? activeSession.id : 0,
                state: activeSession ? activeSession.state : 'none',
                lines: committedLines,
                audioChunks: audioChunksSent
              });
            } catch (e) {}
          });
          return true;
        }
        if (msg.action === 'UPDATE_CONFIG') {
          configReadyPromise.then(() => {
            if (isDestroyed) {
              try { sendResponse({ status: 'ERROR', error: 'destroyed' }); } catch (e) {}
              return;
            }
            if (!checkExtensionContextHealth()) {
              try { sendResponse({ status: 'ERROR', error: 'context_invalidated' }); } catch (e) {}
              return;
            }
            applyConfigUpdate(msg.config || {});
            try { sendResponse({ status: 'OK' }); } catch (e) {}
          });
          return true;
        }
        return false;
      };
      chrome.runtime.onMessage.addListener(runtimeMessageListener);
    } catch (e) {}
  }

  // ---- 初始化 ----------------------------------------------------------

  function init() {
    if (!isTopFrame) {
      finishConfigReady();
      if (!isSameOriginWithParent()) {
        initSubframeAgent();
      }
      return;
    }
    attachMessageListener();
    // 多标签页 / popup 修改配置时统一经由 applyConfigUpdate 同步与重连判定
    try {
      if (isExtensionContextValid() && chrome.storage && chrome.storage.onChanged) {
        storageChangeListener = (changes, area) => {
          if (isDestroyed || area !== 'local' || !changes.geminiLiveConfig || !changes.geminiLiveConfig.newValue) return;
          if (!isConfigReady) hasStorageChangedBeforeLoad = true;
          const incoming = changes.geminiLiveConfig.newValue;
          const serialized = JSON.stringify(incoming);
          const sanitizedIncoming = sanitizeConfigObject(incoming);
          if (!Object.prototype.hasOwnProperty.call(incoming, 'posRatio')) {
            delete sanitizedIncoming.posRatio;
          }
          if (consumeRecentLocalPersistSnapshot(serialized, sanitizedIncoming)) return;
          if ((serialized === lastLocalPersistJson || serialized === JSON.stringify(config)) && deepEqualConfig(incoming, config)) {
            if (inFlightStorageWrites > 0) {
              seenInFlightStorageSnapshots.push(sanitizedIncoming);
              if (seenInFlightStorageSnapshots.length > 16) {
                seenInFlightStorageSnapshots.splice(0, seenInFlightStorageSnapshots.length - 16);
              }
            }
            return;
          }
          if (pendingSaveKeys.size > 0 || inFlightStorageWrites > 0) {
            if (inFlightStorageWrites > 0) {
              seenInFlightStorageSnapshots.push(sanitizedIncoming);
              if (seenInFlightStorageSnapshots.length > 16) {
                seenInFlightStorageSnapshots.splice(0, seenInFlightStorageSnapshots.length - 16);
              }
            }
            const mergedIncoming = Object.assign({}, incoming);
            const preserveKey = (k) => {
              if (Object.prototype.hasOwnProperty.call(config, k) && config[k] !== undefined) {
                mergedIncoming[k] = config[k];
              } else {
                delete mergedIncoming[k];
              }
            };
            pendingSaveKeys.forEach(preserveKey);
            inFlightKeyCounts.forEach((_, k) => preserveKey(k));
            if (deepEqualConfig(mergedIncoming, config)) return;
            applyConfigUpdate(mergedIncoming, { isFullSnapshot: true });
            return;
          }
          applyConfigUpdate(incoming, { isFullSnapshot: true });
        };
        chrome.storage.onChanged.addListener(storageChangeListener);
      }
    } catch (e) {}
    if (hadValidExtensionContext) {
      contextCheckTimer = setInterval(checkExtensionContextHealth, 5000);
    }
    updateAudioModeButton();
    loadStoredConfig(() => {
      if (isDestroyed) return;
      applyInitialStyles();
      updateAudioModeButton();
      console.log('[Gemini Live] Engine v2 ready. version=', EXTENSION_VERSION, 'model=', config.model, 'host=', sanitizeUrl(config.apiHost));
    });
    if (hostEl) {
      hostEl.dataset.gltVersion = EXTENSION_VERSION;
      hostEl.dataset.gltContextValid = hadValidExtensionContext ? 'true' : 'false';
    }
    setDiagnostics({ Session: 0, Lines: 0, AudioChunks: 0, CircuitBreaker: 'closed' });
    setStatus('idle', '就绪');
  }

  init();
})();
