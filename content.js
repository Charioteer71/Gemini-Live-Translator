/**
 * Gemini Live Translator - Chrome Extension Content Script (v2 Engine)
 * ---------------------------------------------------------------------
 * 实时双语同传字幕引擎（原生 Gemini 3.5 Live Translate 协议）
 *
 * 架构：
 *   1) 会话状态机（CONNECTING / READY / STREAMING / RECONNECTING / STOPPED）
 *      - 握手超时按网关实测放宽到 30s
 *      - 指数退避重连（上限 8s），永不因网关临时错误误判为致命错误
 *      - 看门狗：有声音但长时间无转写 / 服务端长时间静默 → 主动重建会话
 *      - 9 分钟预防性「无缝轮转」：新旧会话交接，字幕不断档
 *   2) 音频引擎：<video> / 麦克风 → AudioContext → 流式线性插值重采样到
 *      16kHz/16bit/单声道 → 精确 100ms 分块 → Base64 → realtimeInput
 *   3) 字幕引擎：inputTranscription（原文）+ outputTranscription（译文）
 *      增量合并 → 标点/静音边界断句 → Shadow DOM 零重排渲染
 *   4) 浮窗 UI：拖拽/缩放/透明度/字号/显示模式/音源切换
 */

(function () {
  'use strict';

  if (window.__geminiLiveTranslatorLoaded) {
    // 兼容扩展热重载：清掉上一个（可能已失效的）实例残留的宿主节点
    try {
      const stale = document.getElementById('gemini-live-translator-host');
      if (stale) stale.remove();
    } catch (e) {}
    return;
  }
  window.__geminiLiveTranslatorLoaded = true;

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
    protocolMode: 'native', // 'native'（官方 translationConfig，实测连续+实时）| 'legacy'（旧 Agent 兼容载荷）
    responseModality: 'AUDIO', // 原生同传模型：AUDIO（官方推荐，实测低延迟）| TEXT（仅字幕）
    width: 760,
    height: 300,
    pos: null
  };

  const MODEL_TRANSLATE = 'models/gemini-3.5-live-translate-preview';

  // 握手/重连/轮转参数（依据网关实测 0.5s~13.5s 握手波动放宽）
  const CONNECT_TIMEOUT_MS = 30000;
  const RECONNECT_BASE_MS = 600;
  const RECONNECT_MAX_MS = 8000;
  const RECONNECT_MAX_ATTEMPTS_BEFORE_WARN = 20;
  const SERVER_SILENCE_RECONNECT_MS = 45000;
  // 实测网关 5-Key 轮换会随机绑定质量不一的上游 Key：同一配置 120s 内产出可能在 2~118 条之间波动，
  // 表现为"有时能用、有时翻两句就停、重连又好了"。看门狗在有语音却长时间无转写/无译文时主动重连换 Key。
  const NO_TRANSCRIPTION_RECONNECT_MS = 18000;
  const NO_TRANSLATION_RECONNECT_MS = 20000;
  const SESSION_ROTATE_MS = 9 * 60 * 1000;
  const AUDIO_CHUNK_SAMPLES = 1600; // 100ms @16kHz
  const AUDIO_MAX_QUEUE_CHUNKS = 30; // 握手期间最多缓存 3s 音频

  let config = Object.assign({}, DEFAULT_CONFIG);

  // ========================================================================
  // 1. 通用工具
  // ========================================================================

  /**
   * 脱敏：从任意错误信息 / URL 中抹掉 API Key。
   */
  function sanitizeErrorMessage(err) {
    if (err === null || err === undefined) return '';
    const msg = typeof err === 'string' ? err : (err.message || String(err));
    return msg.replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***');
  }

  function sanitizeUrl(url) {
    if (!url) return '';
    return String(url).replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***');
  }

  function now() {
    return Date.now();
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

  /**
   * 判断错误是否为「不可恢复的配置错误」。
   * 注意：走自定义网关时，网关注入的 Key 由服务端轮换，客户端占位 Key 本身无效，
   * 因此 4xx 也不能直接判定为客户端配置错误 —— 只把明确的 Key 无效类报文当致命。
   */
  function isTerminalError(code, reasonOrMessage) {
    const str = String(reasonOrMessage || '');
    if (/API key not valid|API_KEY_INVALID|API key expired|CONSUMER_INVALID/i.test(str)) return true;
    if (code === 401 || code === 403) {
      return /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(str);
    }
    return false;
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

  // ========================================================================
  // 2. 运行时状态
  // ========================================================================

  let isRunning = false;          // 用户是否希望服务运行（意图）
  let detectedSourceLang = 'auto';

  // 会话
  let sessionSeq = 0;
  let activeSession = null;       // 当前正在接收音频的会话
  let standbySession = null;      // 预防性轮转时正在握手的新会话
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let watchdogTimer = null;
  let sessionStartTimer = null;

  // 音频
  let audioCtx = null;
  let persistentAudioCtx = null;
  let audioSourceNode = null;
  let processorNode = null;
  let analyserNode = null;
  let mutedGainNode = null;
  let mediaStream = null;
  let currentBoundVideo = null;
  let mediaSourceCache = new WeakMap();
  let audioPipelineReady = false;
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

  // 流式重采样器状态（跨 block 保持相位，避免块间漂移）
  const resampler = {
    carry: new Float32Array(2),
    carryCount: 0,
    phase: 0,
    step: 3,
    pending: new Int16Array(AUDIO_CHUNK_SAMPLES * 4),
    pendingCount: 0,
    outScratch: new Float32Array(8192)
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

  // UI
  let isUserScrolledUp = false;
  let isDragging = false;
  const dragOffset = { x: 0, y: 0 };
  let isConnectingUI = false;

  // ========================================================================
  // 3. 静态辅助指令（仅 protocolMode === 'legacy' 回退时使用）
  // ========================================================================

  function buildDynamicSystemPrompt() {
    return '[CRITICAL DIRECTIVE]: You are a Real-Time Simultaneous Audio Interpreter. Output ONLY natural translations of the incoming speech in the target language.';
  }

  // ========================================================================
  // 4. Shadow DOM 浮窗 UI
  // ========================================================================

  const hostEl = document.createElement('div');
  hostEl.id = 'gemini-live-translator-host';
  hostEl.style.cssText = 'all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important;';

  const shadowRoot = hostEl.attachShadow({ mode: 'open' });

  const styleLink = document.createElement('link');
  styleLink.rel = 'stylesheet';
  styleLink.href = chrome.runtime ? chrome.runtime.getURL('content.css') : 'content.css';
  shadowRoot.appendChild(styleLink);

  const overlay = document.createElement('div');
  overlay.id = 'gemini-live-sub-overlay';
  overlay.style.display = 'none';

  const logoUrl = chrome.runtime ? chrome.runtime.getURL('icons/icon48.png') : '';

  overlay.innerHTML = `
    <div class="g-sub-header" id="gSubHeader">
      <div class="g-sub-brand-group">
        ${logoUrl ? `<img src="${logoUrl}" style="width: 20px; height: 20px; border-radius: 4px; object-fit: cover; vertical-align: middle;" alt="Logo" />` : ''}
        <div class="g-sub-logo">Gemini <span class="live-badge">Live</span> Translator</div>
        <button class="g-sub-toggle-btn" id="gSubToggle" title="开启/暂停实时同传字幕">
          <svg viewBox="0 0 24 24" id="gSubToggleIcon">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </button>
      </div>

      <div class="g-sub-lang-pill">
        <select class="g-sub-lang-select" id="gSubSrcLang">
          <option value="自动识别 (Auto Detect)" selected>🌐 自动识别</option>
          <option value="日语 (Japanese)">🇯🇵 日语</option>
          <option value="英语 (English)">🇺🇸 英语</option>
          <option value="韩语 (Korean)">🇰🇷 韩语</option>
          <option value="中文 (Chinese)">🇨🇳 中文</option>
        </select>
        <span class="g-sub-lang-arrow">⇄</span>
        <select class="g-sub-lang-select" id="gSubTgtLang">
          <option value="中文普通话 (Chinese)" selected>中文普通话</option>
          <option value="英语 (English)">英语</option>
          <option value="日语 (Japanese)">日语</option>
        </select>
      </div>

      <div class="g-sub-controls">
        <button class="g-sub-icon-btn" id="gSubAudioMode" title="音源切换: 网页视频 / 麦克风">🎵</button>
        <button class="g-sub-icon-btn" id="gSubReconnect" title="重置并重新连接会话">🔄</button>
        <button class="g-sub-icon-btn" id="gSubSettingsBtn" title="外观设置">⚙️</button>
        <button class="g-sub-icon-btn" id="gSubClear" title="清屏">🧹</button>
        <button class="g-sub-icon-btn close-btn" id="gSubClose" title="关闭字幕窗口">✕</button>
      </div>
    </div>

    <div class="g-sub-settings-panel" id="gSubSettingsPanel">
      <div class="g-sub-setting-row">
        <div class="g-sub-setting-label"><span>窗口不透明度</span><span id="gSubOpacityVal">65%</span></div>
        <input type="range" id="gSubOpacitySlider" min="10" max="100" value="65" class="g-sub-setting-slider">
      </div>
      <div class="g-sub-setting-row">
        <div class="g-sub-setting-label"><span>背景毛玻璃模糊度</span><span id="gSubBlurVal">3px</span></div>
        <input type="range" id="gSubBlurSlider" min="0" max="20" value="3" class="g-sub-setting-slider">
      </div>
      <div class="g-sub-setting-row">
        <div class="g-sub-setting-label"><span>译文字号大小</span><span id="gSubFontSizeVal">17px</span></div>
        <input type="range" id="gSubFontSizeSlider" min="12" max="30" value="17" class="g-sub-setting-slider">
      </div>
      <div class="g-sub-setting-row">
        <div class="g-sub-setting-label"><span>字幕显示模式</span><span></span></div>
        <select class="g-sub-setting-select" id="gSubDisplayMode">
          <option value="bilingual">双语（原文 + 译文）</option>
          <option value="trans">仅译文</option>
          <option value="orig">仅原文</option>
        </select>
      </div>
    </div>

    <div class="g-sub-body" id="gSubBody">
      <div class="g-sub-entry" id="gSubInitialPrompt">
        <div class="g-sub-trans" style="font-size: 15px; color: #94a3b8; font-weight: 500;">正在监听音轨…</div>
      </div>
    </div>

    <div class="g-sub-status-bar">
      <div class="g-sub-status-left">
        <span class="g-sub-conn-dot" id="gSubConnDot"></span>
        <span id="gSubStatusText">就绪</span>
        <span class="g-sub-vol-wrap" id="gSubVolWrap" title="输入音量"><span class="g-sub-vol-fill" id="gSubVolFill"></span></span>
      </div>
      <button class="g-sub-scroll-bottom-btn" id="gSubScrollBtn">⬇ 回到最新</button>
    </div>
  `;

  shadowRoot.appendChild(overlay);
  document.body.appendChild(hostEl);

  const btnToggle = overlay.querySelector('#gSubToggle');
  const btnToggleIcon = overlay.querySelector('#gSubToggleIcon');
  const btnReconnect = overlay.querySelector('#gSubReconnect');
  const subBody = overlay.querySelector('#gSubBody');
  const statusText = overlay.querySelector('#gSubStatusText');
  const connDot = overlay.querySelector('#gSubConnDot');
  const volFill = overlay.querySelector('#gSubVolFill');
  const scrollBottomBtn = overlay.querySelector('#gSubScrollBtn');
  const srcLangSelect = overlay.querySelector('#gSubSrcLang');
  const tgtLangSelect = overlay.querySelector('#gSubTgtLang');
  const btnAudioMode = overlay.querySelector('#gSubAudioMode');
  const btnSettings = overlay.querySelector('#gSubSettingsBtn');
  const settingsPanel = overlay.querySelector('#gSubSettingsPanel');
  const opacitySlider = overlay.querySelector('#gSubOpacitySlider');
  const opacityVal = overlay.querySelector('#gSubOpacityVal');
  const blurSlider = overlay.querySelector('#gSubBlurSlider');
  const blurVal = overlay.querySelector('#gSubBlurVal');
  const fontSizeSlider = overlay.querySelector('#gSubFontSizeSlider');
  const fontSizeVal = overlay.querySelector('#gSubFontSizeVal');
  const displayModeSelect = overlay.querySelector('#gSubDisplayMode');
  const btnClear = overlay.querySelector('#gSubClear');
  const btnClose = overlay.querySelector('#gSubClose');
  const header = overlay.querySelector('#gSubHeader');

  // ---- 状态条 ----------------------------------------------------------

  const STATUS_COLORS = {
    idle: '#94a3b8',
    ok: '#34d399',
    warn: '#f59e0b',
    err: '#ef4444',
    info: '#38bdf8'
  };

  function setStatus(kind, text) {
    if (!statusText) return;
    statusText.textContent = text;
    statusText.style.color = STATUS_COLORS[kind] || STATUS_COLORS.idle;
    if (connDot) {
      connDot.style.background = STATUS_COLORS[kind] || STATUS_COLORS.idle;
      connDot.style.boxShadow = kind === 'ok' ? '0 0 6px rgba(52,211,153,.9)' : 'none';
    }
    hostEl.dataset.gltStatus = text;
    hostEl.dataset.gltState = kind;
  }

  function setDiagnostics(partial) {
    Object.keys(partial || {}).forEach((k) => {
      hostEl.dataset['glt' + k] = String(partial[k]);
    });
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

  function getUsableViewport() {
    const docEl = document.documentElement;
    const width = (docEl && docEl.clientWidth) ? docEl.clientWidth : window.innerWidth;
    const height = (docEl && docEl.clientHeight) ? docEl.clientHeight : window.innerHeight;
    return { width: Math.max(0, width), height: Math.max(0, height) };
  }

  function ensureOverlayInViewport() {
    if (!overlay || overlay.style.display === 'none') return;
    const viewport = getUsableViewport();
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const overlayWidth = overlay.offsetWidth || config.width || 760;
    const overlayHeight = overlay.offsetHeight || config.height || 300;
    const maxLeft = Math.max(0, viewport.width - overlayWidth);
    const maxTop = Math.max(0, viewport.height - overlayHeight);

    let left, top;
    if (config.posRatio && config.posRatio.x !== undefined) {
      left = Math.round(config.posRatio.x * maxLeft);
      top = Math.round(config.posRatio.y * maxTop);
    } else if (config.pos && config.pos.left !== undefined) {
      left = typeof config.pos.left === 'number' ? config.pos.left : (parseFloat(config.pos.left) || 0);
      top = typeof config.pos.top === 'number' ? config.pos.top : (parseFloat(config.pos.top) || 0);
    } else {
      left = maxLeft;
      top = maxTop;
    }
    left = Math.max(0, Math.min(maxLeft, left));
    top = Math.max(0, Math.min(maxTop, top));
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  }

  let resizeRafId = null;
  window.addEventListener('resize', () => {
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(() => {
      ensureOverlayInViewport();
      resizeRafId = null;
    });
  });

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
    isDragging = true;
    const rect = overlay.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });

  function onDragMove(e) {
    if (!isDragging) return;
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

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
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
    saveConfig(true);
  }

  overlay.addEventListener('mouseup', (e) => {
    if (isDragging) return;
    if (e.target === header || header.contains(e.target)) return;
    const w = overlay.offsetWidth;
    const h = overlay.offsetHeight;
    if (w > 100 && h > 80 && (w !== config.width || h !== config.height)) {
      config.width = w;
      config.height = h;
      ensureOverlayInViewport();
      saveConfig(true);
    }
  });

  function applyInitialStyles() {
    overlay.style.setProperty('--g-sub-opacity', config.opacity);
    overlay.style.setProperty('--g-sub-blur', `${config.blur}px`);
    overlay.style.setProperty('--g-sub-font-size', `${config.fontSize}px`);
    if (config.width) overlay.style.width = `${config.width}px`;
    if (config.height) overlay.style.height = `${config.height}px`;
    ensureOverlayInViewport();

    if (srcLangSelect && config.sourceLang) srcLangSelect.value = config.sourceLang;
    if (tgtLangSelect && config.targetLang) tgtLangSelect.value = config.targetLang;
    if (displayModeSelect && config.displayMode) displayModeSelect.value = config.displayMode;

    opacitySlider.value = Math.round(config.opacity * 100);
    opacityVal.textContent = `${Math.round(config.opacity * 100)}%`;
    blurSlider.value = config.blur;
    blurVal.textContent = `${config.blur}px`;
    fontSizeSlider.value = config.fontSize;
    fontSizeVal.textContent = `${config.fontSize}px`;
        applyDisplayMode();
  }

  function applyDisplayMode() {
    const mode = config.displayMode || 'bilingual';
    overlay.dataset.displayMode = mode;
    const entries = subBody.querySelectorAll('.g-sub-entry');
    entries.forEach((entry) => applyDisplayModeToEntry(entry));
  }

  function applyDisplayModeToEntry(entry) {
    if (!entry || !entry._origEl || !entry._transEl) return;
    const mode = config.displayMode || 'bilingual';
    entry._origEl.style.display = (mode === 'trans') ? 'none' : '';
    entry._transEl.style.display = (mode === 'orig') ? 'none' : '';
  }

  // ---- 设置存储 --------------------------------------------------------

  let saveConfigTimer = null;
  function saveConfig(immediate = false) {
    if (saveConfigTimer) {
      clearTimeout(saveConfigTimer);
      saveConfigTimer = null;
    }
    const persist = () => {
      try {
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ geminiLiveConfig: config });
        }
      } catch (e) { /* extension context invalidated */ }
    };
    if (immediate) { persist(); return; }
    saveConfigTimer = setTimeout(persist, 250);
  }

  // ---- 滚动 ------------------------------------------------------------

  let scrollRafId = null;
  let isScrollPending = false;
  let isProgrammaticScrolling = false;

  function cancelPendingScroll() {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
      isScrollPending = false;
    }
  }

  subBody.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) {
      const distanceFromBottom = subBody.scrollHeight - subBody.scrollTop - subBody.clientHeight;
      if (distanceFromBottom > 60) {
        isUserScrolledUp = true;
        scrollBottomBtn.style.display = 'inline-block';
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
    } else if (distanceFromBottom > 60 && isUserScrolledUp) {
      scrollBottomBtn.style.display = 'inline-block';
    }
  });

  scrollBottomBtn.addEventListener('click', () => {
    cancelPendingScroll();
    isUserScrolledUp = false;
    scrollBottomBtn.style.display = 'none';
    isProgrammaticScrolling = true;
    subBody.scrollTop = subBody.scrollHeight;
    requestAnimationFrame(() => { isProgrammaticScrolling = false; });
  });

  function safeScrollToBottom() {
    if (isUserScrolledUp || isScrollPending) return;
    isScrollPending = true;
    scrollRafId = requestAnimationFrame(() => {
      isScrollPending = false;
      scrollRafId = null;
      if (!isUserScrolledUp && subBody) {
        isProgrammaticScrolling = true;
        subBody.scrollTop = subBody.scrollHeight;
        requestAnimationFrame(() => { isProgrammaticScrolling = false; });
      }
    });
  }

  // ---- UI 事件 ---------------------------------------------------------

  btnReconnect.addEventListener('click', () => {
    manualRestart('用户手动重置会话');
  });

  btnClear.addEventListener('click', clearSubtitleBody);

  btnAudioMode.addEventListener('click', () => {
    config.audioMode = config.audioMode === 'video' ? 'mic' : 'video';
    updateAudioModeButton();
    saveConfig(true);
    if (isRunning) manualRestart('切换音源');
  });

  function updateAudioModeButton() {
    btnAudioMode.textContent = config.audioMode === 'video' ? '🎵' : '🎙️';
    btnAudioMode.title = config.audioMode === 'video' ? '当前音源: 网页视频（点击切换为麦克风）' : '当前音源: 麦克风 / 系统声音（点击切换为网页视频）';
  }

  srcLangSelect.addEventListener('change', () => {
    config.sourceLang = srcLangSelect.value;
    saveConfig(true);
    // 源语言仅用于提示与展示，原生同传由模型自动识别
  });

  tgtLangSelect.addEventListener('change', () => {
    config.targetLang = tgtLangSelect.value;
    saveConfig(true);
        if (isRunning) manualRestart('切换目标语言');
  });

  btnToggle.addEventListener('click', () => {
    if (isRunning) stopSubtitleService(true);
    else startSubtitleService(true);
  });

  btnClose.addEventListener('click', () => {
    overlay.style.display = 'none';
    settingsPanel.classList.remove('show');
    if (isRunning) stopSubtitleService(true);
  });

  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    if (!path.includes(settingsPanel) && !path.includes(btnSettings)) settingsPanel.classList.remove('show');
      });

  opacitySlider.addEventListener('input', () => {
    config.opacity = parseInt(opacitySlider.value, 10) / 100;
    opacityVal.textContent = `${Math.round(config.opacity * 100)}%`;
    overlay.style.setProperty('--g-sub-opacity', config.opacity);
    saveConfig(false);
  });
  blurSlider.addEventListener('input', () => {
    config.blur = parseInt(blurSlider.value, 10);
    blurVal.textContent = `${config.blur}px`;
    overlay.style.setProperty('--g-sub-blur', `${config.blur}px`);
    saveConfig(false);
  });
  fontSizeSlider.addEventListener('input', () => {
    config.fontSize = parseInt(fontSizeSlider.value, 10);
    fontSizeVal.textContent = `${config.fontSize}px`;
    overlay.style.setProperty('--g-sub-font-size', `${config.fontSize}px`);
    saveConfig(false);
  });
  displayModeSelect.addEventListener('change', () => {
    config.displayMode = displayModeSelect.value;
    applyDisplayMode();
    saveConfig(true);
  });

  // ---- 全屏重挂载 ------------------------------------------------------

  function handleFullscreenChange() {
    const fsElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    if (fsElement) {
      if (hostEl.parentElement !== fsElement) fsElement.appendChild(hostEl);
    } else if (hostEl.parentElement !== document.body) {
      document.body.appendChild(hostEl);
    }
  }
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

  // ========================================================================
  // 5. 字幕引擎
  // ========================================================================

  const TERMINAL_PUNCT_RE = /[。！？!?…\n]$/;
  const TERMINAL_PUNCT_ANY_RE = /[。！？!?…\n]/;

  function clearSubtitleBody() {
    cancelPendingScroll();
    subBody.innerHTML = `
      <div class="g-sub-entry" id="gSubInitialPrompt">
        <div class="g-sub-trans" style="font-size: 14px; color: #64748b;">（已清屏，正在监听音轨…）</div>
      </div>
    `;
    currentStreamingEntry = null;
    currentOrigBuffer = '';
    currentTransBuffer = '';
    committedLines = 0;
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

      subBody.appendChild(entry);
      currentStreamingEntry = entry;
      applyDisplayModeToEntry(entry);
    }
    return currentStreamingEntry;
  }

  function renderStreamingLine() {
    const entry = ensureStreamingEntry();
    const mode = config.displayMode || 'bilingual';

    if (mode !== 'trans') {
      if (currentOrigBuffer) {
        entry._origEl.style.display = '';
        entry._origText.nodeValue = currentOrigBuffer;
      } else {
        entry._origEl.style.display = 'none';
      }
    } else {
      entry._origEl.style.display = 'none';
    }

    if (mode !== 'orig') {
      entry._transEl.style.display = '';
      entry._transText.nodeValue = currentTransBuffer || '…';
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

  function commitCurrentLine(force, reason) {
    const hasOrig = !!currentOrigBuffer.trim();
    const hasTrans = !!currentTransBuffer.trim();
    if (!hasOrig && !hasTrans) {
      if (currentStreamingEntry) {
        if (!force && !currentTransBuffer) currentStreamingEntry.remove();
        currentStreamingEntry = null;
      }
      return;
    }
    if (!force && !hasTrans && !(config.displayMode === 'orig' && hasOrig)) return; // 还没有译文，先留在流式行里

    const entry = currentStreamingEntry;
    if (entry) {
      entry.classList.remove('streaming');
      if (entry._transText) entry._transText.nodeValue = currentTransBuffer || '';
      if (entry._origText) entry._origText.nodeValue = currentOrigBuffer || '';
      // 同语言 echo 去重：原文与译文完全一致时隐藏原文行
      if (entry._origEl && currentOrigBuffer.trim() === currentTransBuffer.trim()) {
        entry._origEl.style.display = 'none';
      }
      currentStreamingEntry = null;
    }

    currentOrigBuffer = '';
    currentTransBuffer = '';
    committedLines++;
    setDiagnostics({ Lines: committedLines, LastCommitReason: reason || 'auto', LastCommitAt: now() });

    while (subBody.children.length > 60) subBody.removeChild(subBody.firstChild);
    safeScrollToBottom();
  }

  function bufferEndsWithTerminal(buffer) {
    const s = String(buffer || '').replace(/[\s"'”’）)\]】」』]+$/g, '');
    return TERMINAL_PUNCT_RE.test(s);
  }

  function onOriginalDelta(text) {
    if (!text) return;
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    lastTranscriptionAt = now();
    lastServerMessageAt = lastTranscriptionAt;
    currentOrigBuffer = (currentOrigBuffer + text).replace(/([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff])\s+([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff])/g, '$1$2');
    renderStreamingLine();

    if (String(config.sourceLang || '').includes('自动识别')) {
      const lang = detectLanguageFromText(currentOrigBuffer);
      if (lang !== 'auto' && lang !== detectedSourceLang) {
        detectedSourceLang = lang;
        const langMap = { ja: '🇯🇵 日语', en: '🇺🇸 英语', ko: '🇰🇷 韩语', zh: '🇨🇳 中文' };
        const optAuto = srcLangSelect.querySelector('option[value*="自动识别"]');
        if (optAuto) optAuto.textContent = `🌐 自动 (${langMap[lang] || '多语言'})`;
        setDiagnostics({ SrcLang: lang });
      }
    }
    maybeCommitByBoundary();
  }

  function onTranslationDelta(text) {
    if (!text) return;
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    // 若上一句已带句末标点，新 delta 说明下一句开始：先把上一句落成独立字幕行
    if (currentTransBuffer && bufferEndsWithTerminal(currentTransBuffer)) {
      commitCurrentLine(false, 'punctuation-next');
    }
    lastTranscriptionAt = now();
    lastServerMessageAt = lastTranscriptionAt;
    currentTransBuffer += text;
    renderStreamingLine();
    maybeCommitByBoundary();
    setDiagnostics({ LastTransAt: lastTranscriptionAt });
  }

  function maybeCommitByBoundary() {
    const mode = config.displayMode || 'bilingual';
    const trans = currentTransBuffer.trim();
    const orig = currentOrigBuffer.trim();

    // 仅原文模式：按原文标点断句
    if (mode === 'orig') {
      if (!orig) return;
      if (bufferEndsWithTerminal(currentOrigBuffer)) { commitCurrentLine(false, 'punctuation'); return; }
      if (orig.length >= 90) commitCurrentLine(false, 'max-length');
      return;
    }

    if (!trans) return;
    if (trans.length >= 90) { commitCurrentLine(false, 'max-length'); return; }

    const transEnded = bufferEndsWithTerminal(currentTransBuffer);
    if (!transEnded) return;

    // 仅译文模式：译文本句结束即提交
    if (mode === 'trans') { commitCurrentLine(false, 'punctuation'); return; }

    // 双语模式：优先等原文也结束；若译文已足够长（>=10 字）则直接提交，最多等 400ms
    if (orig && !bufferEndsWithTerminal(currentOrigBuffer)) {
      if (trans.length >= 10) { commitCurrentLine(false, 'punctuation-trans-only'); return; }
      scheduleCommit('punctuation-wait-orig', 400);
      return;
    }
    commitCurrentLine(false, 'punctuation');
  }

  // 静音断句：转写流停止一段时间后提交当前行（字幕不必等 turnComplete）
  function startSilenceFlushTimer() {
    if (silenceFlushTimer) clearInterval(silenceFlushTimer);
    silenceFlushTimer = setInterval(() => {
      if (!isRunning) return;
      const idle = now() - lastTranscriptionAt;
      if (idle > 1500 && (currentTransBuffer.trim() || currentOrigBuffer.trim())) {
        const trans = currentTransBuffer.trim();
        const orig = currentOrigBuffer.trim();
        if (trans.length >= 3) commitCurrentLine(false, 'silence');
        else if (!trans && orig.length >= 2 && idle > 4000) commitCurrentLine(true, 'silence-orig-only');
      }
      // 静止过久：清理多余的空行
      if (idle > 30000 && currentStreamingEntry && !currentOrigBuffer && !currentTransBuffer) {
        currentStreamingEntry.remove();
        currentStreamingEntry = null;
      }
    }, 500);
  }

  // ========================================================================
  // 6. 音频引擎
  // ========================================================================

  function findActiveVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    const playing = videos.find((v) => !v.paused && !v.ended && v.currentTime > 0);
    return playing || videos[0];
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

  function getOrCreateAudioGraph(video) {
    const ctx = ensureAudioContext();
    let sourceNode = mediaSourceCache.get(video);
    if (!sourceNode) {
      sourceNode = ctx.createMediaElementSource(video);
      // 保持原声直通，避免用户听不到视频声音
      sourceNode.connect(ctx.destination);
      mediaSourceCache.set(video, sourceNode);
    }
    return { audioCtx: ctx, sourceNode };
  }

  function onVideoSeeking() {
    if (isRunning) commitCurrentLine(true, 'seek');
  }

  function onVideoPause() {
    isVideoPaused = true;
    if (isRunning) {
      commitCurrentLine(true, 'pause');
      if (!isConnectingUI) setStatus('info', '⏸️ 视频已暂停（会话保持）');
    }
  }

  function onVideoPlay() {
    isVideoPaused = false;
    if (!isRunning) return;
    ensureAudioContext().resume().catch(() => {});
    if (!isConnectingUI && activeSession && activeSession.state === 'ready') setStatus('ok', '🟢 正在同传');
  }

  function rebindActiveVideo(newVideo) {
    if (!isRunning || config.audioMode === 'mic' || !newVideo || newVideo === currentBoundVideo) return;
    if (!audioCtx || !processorNode || !analyserNode) {
      currentBoundVideo = newVideo;
      return;
    }
    if (currentBoundVideo) {
      try {
        currentBoundVideo.removeEventListener('seeking', onVideoSeeking);
        currentBoundVideo.removeEventListener('pause', onVideoPause);
        currentBoundVideo.removeEventListener('play', onVideoPlay);
      } catch (e) {}
    }
    currentBoundVideo = newVideo;
    newVideo.addEventListener('seeking', onVideoSeeking);
    newVideo.addEventListener('pause', onVideoPause);
    newVideo.addEventListener('play', onVideoPlay);

    const graph = getOrCreateAudioGraph(newVideo);
    audioCtx = graph.audioCtx;
    try { audioSourceNode.disconnect(); } catch (e) {}
    audioSourceNode = graph.sourceNode;
    try { audioSourceNode.connect(analyserNode); } catch (e) {}
    try { audioSourceNode.connect(processorNode); } catch (e) {}
    commitCurrentLine(true, 'video-switch');
    ensureAudioContext().resume().catch(() => {});
  }

  // SPA 导航 / 视频切换
  let spaNavDebounce = null;
  function onSpaNavigationDetected() {
    if (!isRunning) return;
    if (spaNavDebounce) clearTimeout(spaNavDebounce);
    spaNavDebounce = setTimeout(() => {
      if (!isRunning) return;
      const newVideo = findActiveVideo();
      if (newVideo && newVideo !== currentBoundVideo) rebindActiveVideo(newVideo);
    }, 400);
  }

  (function hookHistory() {
    try {
      const origPushState = history.pushState;
      const origReplaceState = history.replaceState;
      history.pushState = function (...args) {
        const ret = origPushState.apply(this, args);
        window.dispatchEvent(new Event('locationchange'));
        return ret;
      };
      history.replaceState = function (...args) {
        const ret = origReplaceState.apply(this, args);
        window.dispatchEvent(new Event('locationchange'));
        return ret;
      };
      window.addEventListener('popstate', onSpaNavigationDetected);
      window.addEventListener('locationchange', onSpaNavigationDetected);
      window.addEventListener('yt-navigate-finish', onSpaNavigationDetected);
      const titleEl = document.querySelector('title');
      if (titleEl && window.MutationObserver) {
        new MutationObserver(onSpaNavigationDetected).observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
    } catch (e) {}
  })();

  document.addEventListener('play', (e) => {
    if (isRunning && config.audioMode === 'video' && e.target && e.target.tagName === 'VIDEO') {
      if (e.target !== currentBoundVideo) rebindActiveVideo(e.target);
    }
  }, true);

  window.addEventListener('pagehide', () => {
    if (isRunning) stopSubtitleService(true);
  });

  // bfcache 返回页面时自动恢复
  window.addEventListener('pageshow', (e) => {
    if (e && e.persisted) {
      ensureAudioContext().resume().catch(() => {});
      if (overlay.style.display !== 'none' && !isRunning) startSubtitleService(true);
    }
  });

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
   * 输出写入 resampler.pending（Int16，最多 4 个 100ms 块）。
   * 返回本次产生的 16k 采样数。
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
        s1 = input[0];
      } else {
        s0 = input[idx];
        s1 = input[idx + 1];
      }
      if (!Number.isFinite(s0)) s0 = 0;
      if (!Number.isFinite(s1)) s1 = 0;
      const sample = s0 + (s1 - s0) * frac;
      const clamped = sample > 1 ? 1 : (sample < -1 ? -1 : sample);

      if (resampler.pendingCount >= resampler.pending.length) break;
      resampler.pending[resampler.pendingCount++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      produced++;
      p += step;
    }

    // 保存最后两个采样作为下一块插值基准
    if (n >= 2) {
      resampler.carry[0] = input[n - 2];
      resampler.carry[1] = input[n - 1];
      resampler.carryCount = 2;
    } else if (n === 1) {
      resampler.carry[0] = resampler.carryCount > 0 ? resampler.carry[resampler.carryCount - 1] : input[0];
      resampler.carry[1] = input[0];
      resampler.carryCount = 2;
    }
    resampler.phase = p - n;
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
    if (!activeSession || activeSession.state !== 'ready' || activeSession.ws.readyState !== WebSocket.OPEN) return;
    while (audioSendQueue.length && activeSession && activeSession.state === 'ready') {
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
    const payload = buildAudioPayload(b64Audio);
    const s = activeSession;
    if (s && s.state === 'ready' && s.ws && s.ws.readyState === WebSocket.OPEN) {
      // 背压保护：发送队列积压过多时丢弃最旧音频块，避免弱网下内存/延迟失控
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
        // 发送失败：降级为重连
        scheduleReconnect('audio-send-error');
      }
    }
    // 握手/重连期间缓存少量音频，保持字幕连续
    if (audioSendQueue.length < AUDIO_MAX_QUEUE_CHUNKS) audioSendQueue.push(payload);
    else {
      audioSendQueue.shift();
      audioSendQueue.push(payload);
    }
  }

  function consumePendingAudio() {
    while (resampler.pendingCount >= AUDIO_CHUNK_SAMPLES) {
      const chunkBytes = new Uint8Array(resampler.pending.buffer, 0, AUDIO_CHUNK_SAMPLES * 2);
      const b64 = uint8ToBase64(chunkBytes, AUDIO_CHUNK_SAMPLES * 2);
      dispatchAudioChunk(b64);
      // 前移剩余采样
      const remain = resampler.pendingCount - AUDIO_CHUNK_SAMPLES;
      if (remain > 0) resampler.pending.copyWithin(0, AUDIO_CHUNK_SAMPLES, resampler.pendingCount);
      resampler.pendingCount = remain;
    }
  }

  function cleanupAudioPipeline() {
    if (volumeCheckInterval) { clearInterval(volumeCheckInterval); volumeCheckInterval = null; }
    if (audioResumeTimer) { clearInterval(audioResumeTimer); audioResumeTimer = null; }
    if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }
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
      try {
        currentBoundVideo.removeEventListener('seeking', onVideoSeeking);
        currentBoundVideo.removeEventListener('pause', onVideoPause);
        currentBoundVideo.removeEventListener('play', onVideoPlay);
      } catch (e) {}
      currentBoundVideo = null;
    }
    if (audioSourceNode) {
      try { audioSourceNode.disconnect(); } catch (e) {}
      if (config.audioMode !== 'mic' && audioCtx && audioCtx.state !== 'closed') {
        try { audioSourceNode.connect(audioCtx.destination); } catch (e) {}
      }
      audioSourceNode = null;
    }
    if (config.audioMode === 'mic' && audioCtx && audioCtx !== persistentAudioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close().catch(() => {}); } catch (e) {}
    }
    if (config.audioMode === 'mic' || !isRunning) {
      audioCtx = persistentAudioCtx && persistentAudioCtx.state !== 'closed' ? persistentAudioCtx : null;
    }
    audioPipelineReady = false;
    resampler.pendingCount = 0;
    audioSendQueue.length = 0;
    renderVolume(0);
  }

  // 创建失败/不可捕获时抛出可重试错误
  function makeRetryableError(message, code) {
    const err = new Error(message);
    err.retryable = true;
    err.code = code || 'RETRYABLE';
    return err;
  }

  async function initAudioCapture(session) {
    cleanupAudioPipeline();

    if (config.audioMode === 'mic') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (e) {}
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
      } catch (micErr) {
        try { if (audioCtx.state !== 'closed') audioCtx.close().catch(() => {}); } catch (e) {}
        audioCtx = null;
        throw new Error('麦克风权限被拒绝或未找到音频输入设备: ' + (micErr && micErr.message ? micErr.message : micErr));
      }
      if (session !== activeSession || !isRunning) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
        try { if (audioCtx.state !== 'closed') audioCtx.close().catch(() => {}); } catch (e) {}
        audioCtx = null;
        return;
      }
      mediaStream = stream;
      audioSourceNode = audioCtx.createMediaStreamSource(mediaStream);
    } else {
      const video = findActiveVideo();
      if (!video) throw makeRetryableError('未找到正在播放的视频。请先点击播放视频后再开启同传。', 'NO_VIDEO');
      if (session !== activeSession || !isRunning) return;
      currentBoundVideo = video;
      isVideoPaused = !!video.paused;
      video.addEventListener('seeking', onVideoSeeking);
      video.addEventListener('pause', onVideoPause);
      video.addEventListener('play', onVideoPlay);
      const graph = getOrCreateAudioGraph(video);
      audioCtx = graph.audioCtx;
      audioSourceNode = graph.sourceNode;
    }

    if (session !== activeSession || !isRunning) {
      cleanupAudioPipeline();
      return;
    }

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    audioSourceNode.connect(analyserNode);

    const volumeData = new Uint8Array(analyserNode.frequencyBinCount);
    volumeCheckInterval = setInterval(() => {
      if (!isRunning || !analyserNode) return;
      try {
        analyserNode.getByteFrequencyData(volumeData);
      } catch (e) { return; }
      let sum = 0;
      for (let i = 0; i < volumeData.length; i++) sum += volumeData[i];
      const avg = sum / volumeData.length;
      renderVolume(avg);
      if (avg > 6) lastSpeechAt = now();
      setDiagnostics({ Volume: Math.round(avg) });
      // 状态条由连接状态机独占写入，音量只更新音量条，避免“正在同传/监听音频中”闪烁
    }, 500);

    // 每 1s 尝试恢复被系统挂起的 AudioContext
    audioResumeTimer = setInterval(() => {
      if (!isRunning || !audioCtx) return;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }, 1000);

    const nativeRate = audioCtx.sampleRate || 48000;
    resetResampler(nativeRate);

    // 优先 AudioWorklet（低抖动），失败回退 ScriptProcessor
    processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!isRunning) return;
      try {
        const input = e.inputBuffer.getChannelData(0);
        resampleBlock(input);
        consumePendingAudio();
      } catch (err) {
        console.error('[Gemini Live] Audio process error:', sanitizeErrorMessage(err));
      }
    };

    audioSourceNode.connect(processorNode);
    mutedGainNode = audioCtx.createGain();
    mutedGainNode.gain.value = 0;
    processorNode.connect(mutedGainNode);
    mutedGainNode.connect(audioCtx.destination);

    audioPipelineReady = true;
    setDiagnostics({ SampleRate: nativeRate, AudioPipeline: 'running' });
    startSilenceFlushTimer();
  }

  // ========================================================================
  // 7. WebSocket 会话管理（原生 Live Translate 协议）
  // ========================================================================

  function getWebSocketUrl() {
    let host = String(config.apiHost || DEFAULT_CONFIG.apiHost).trim() || DEFAULT_CONFIG.apiHost;
    if (/^http:\/\//i.test(host)) host = 'ws://' + host.substring(7);
    else if (/^https:\/\//i.test(host)) host = 'wss://' + host.substring(8);
    else if (!/^wss?:\/\//i.test(host)) host = 'wss://' + host;

    host = host.replace(/\/+$/, '')
      .replace(/\/v1beta\/models\/?$/i, '')
      .replace(/\/v1beta\/?$/i, '')
      .replace(/\/models\/?$/i, '');

    if (!/\/ws\/google\.ai\.generativelanguage\./i.test(host)) {
      host += '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
    }

    if (config.apiKey && String(config.apiKey).trim() && !/[?&]key=/.test(host)) {
      host += (host.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(String(config.apiKey).trim());
    }
    return host;
  }

  function buildSetupPayload() {
    const model = normalizeModelName(config.model);
    const useLegacy = isLiveTranslateModel(model) && config.protocolMode === 'legacy';

    if (useLegacy) {
      // 兼容模式：真机 E2E 验证可连续同传的载荷（v1.0.4 形态 + 语境/目标语言系统提示词）
      const legacyPrompt = `${buildDynamicSystemPrompt()}\n\n[MODE]: Real-time simultaneous interpretation of the incoming audio. Output ONLY the translated text in the target language, continuously, without waiting for turns.`;
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
      lastOutAt: 0,
      connectTimer: null,
      rotationTimer: null,
      intentionallyClosed: false
    };
  }

  function clearSessionTimers(session) {
    if (!session) return;
    if (session.connectTimer) { clearTimeout(session.connectTimer); session.connectTimer = null; }
    if (session.rotationTimer) { clearTimeout(session.rotationTimer); session.rotationTimer = null; }
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

  function sessionLog(prefix, session, extra) {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[Gemini Live ${ts}] ${prefix}`, JSON.stringify(Object.assign({
      session: session ? session.id : null,
      reason: session ? session.reason : null,
      state: session ? session.state : null
    }, extra || {})));
  }

  function connectSession(session, options) {
    if (!session || !isRunning) return;
    const opts = options || {};
    const silent = !!opts.silent; // 轮转备用会话：不抢占状态条文案
    let url;
    try {
      url = getWebSocketUrl();
    } catch (e) {
      setStatus('err', '❌ 节点地址无效: ' + sanitizeErrorMessage(e));
      return;
    }

    if (/generativelanguage\.googleapis\.com/i.test(url) && (!config.apiKey || !String(config.apiKey).trim())) {
      setStatus('err', '❌ 官方 API 需要填写 Google API Key');
      stopSubtitleService(true);
      return;
    }

    if (!silent) {
      isConnectingUI = true;
      setStatus('info', '🔗 正在连接…');
      setDiagnostics({ Session: session.id, Connects: session.id });
    } else {
      sessionLog('Standby session connecting', session);
    }

    let sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      sessionLog('WS construct failed', session, { error: sanitizeErrorMessage(e) });
      setStatus('err', '❌ WebSocket 创建失败: ' + sanitizeErrorMessage(e && e.message ? e.message : e));
      scheduleReconnect('construct-failed');
      return;
    }
    session.ws = sock;

    session.connectTimer = setTimeout(() => {
      if (session.state === 'closed') return;
      if (session.state === 'connecting') {
        sessionLog('Connect/handshake timeout', session, { timeoutMs: CONNECT_TIMEOUT_MS });
        setStatus('warn', '⚠️ 握手超时，正在重试…');
        closeSession(session, 'handshake-timeout');
        if (session === activeSession || !activeSession) scheduleReconnect('handshake-timeout');
        else if (session === standbySession) standbySession = null;
      }
    }, CONNECT_TIMEOUT_MS);

    sock.onopen = () => {
      if (session.state === 'closed' || !isRunning) return;
      session.openedAt = now();
      sessionLog('WebSocket opened', session, { handshakeMs: session.openedAt - session.createdAt });
      let payload;
      try {
        payload = buildSetupPayload();
      } catch (e) {
        setStatus('err', '❌ 会话配置构造失败: ' + sanitizeErrorMessage(e));
        closeSession(session, 'setup-error');
        return;
      }
      try {
        sock.send(JSON.stringify(payload));
        sessionLog('Setup sent', session, { model: payload.setup.model });
        if (!silent) setStatus('info', '⚙️ 初始化会话…');
      } catch (e) {
        setStatus('err', '❌ 发送 setup 失败: ' + sanitizeErrorMessage(e));
        closeSession(session, 'setup-send-error');
        scheduleReconnect('setup-send-error');
      }
    };

    sock.onmessage = (event) => {
      // 异步解析 Blob
      if (typeof event.data === 'string') {
        handleServerMessage(session, event.data);
      } else if (event.data && typeof event.data.text === 'function') {
        event.data.text().then((t) => handleServerMessage(session, t)).catch((e) => sessionLog('Blob decode error', session, { error: String(e) }));
      } else if (event.data instanceof ArrayBuffer) {
        try { handleServerMessage(session, new TextDecoder().decode(event.data)); } catch (e) {}
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
      session.state = 'closed';
      session.ws = null;

      if (session.intentionallyClosed) return;

      if (wasStandby) {
        standbySession = null;
        sessionLog('Standby rotation failed, keeping current session', session);
        return; // 放弃轮转，保留当前主会话
      }

      if (!wasActive) return;

      // 主会话意外断开
      isConnectingUI = false;
      if (!isRunning) return;
      if (event.code === 1000 && !event.reason) {
        sessionLog('Normal close while running → reconnect', session);
      }
      scheduleReconnect(`close-${event.code}`);
    };
  }

  function handleServerMessage(session, rawText) {
    if (!rawText) return;
    if (session.state === 'closed') return;
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
      isConnectingUI = false;
      onSessionReady(session);
      return;
    }

    if (msg.error) {
      const errMsg = msg.error.message || JSON.stringify(msg.error);
      sessionLog('Server error', session, { code: msg.error.code, message: sanitizeErrorMessage(errMsg) });
      if (session !== activeSession) {
        // 备用/旧会话的错误不应影响主会话与整体服务
        closeSession(session, 'standby-error');
        if (session === standbySession) standbySession = null;
        return;
      }
      if (isTerminalError(msg.error.code, errMsg)) {
        setStatus('err', '❌ API 错误: ' + sanitizeErrorMessage(errMsg).slice(0, 120));
        stopSubtitleService(true);
        closeSession(session, 'terminal-error');
      } else {
        setStatus('warn', '⚠️ 服务端异常: ' + sanitizeErrorMessage(errMsg).slice(0, 80));
      }
    }

    if (msg.goAway) {
      const timeLeft = Number(msg.goAway.timeLeft || 0);
      sessionLog('goAway received', session, { timeLeft });
      setDiagnostics({ GoAway: timeLeft || 'unknown' });
      scheduleRotation(session, 'go-away', Math.max(0, timeLeft * 1000 - 1500));
    }

    // 备用/过期会话一律不渲染字幕，避免轮转期间出现重复内容
    if (session !== activeSession) return;

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      commitCurrentLine(true, 'interrupted');
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      session.lastTranscriptionAt = t;
      session.lastOrigAt = t;
      if (config.displayMode !== 'trans') onOriginalDelta(sc.inputTranscription.text);
      else lastTranscriptionAt = t;
    }

    let handled = false;
    if (sc.outputTranscription && sc.outputTranscription.text) {
      session.lastTranscriptionAt = t;
      session.lastOutAt = t;
      if (config.displayMode !== 'orig') onTranslationDelta(sc.outputTranscription.text);
      else lastTranscriptionAt = t;
      handled = true;
    }
    if (sc.outputAudioTranscription && sc.outputAudioTranscription.text) {
      session.lastTranscriptionAt = t;
      session.lastOutAt = t;
      if (config.displayMode !== 'orig') onTranslationDelta(sc.outputAudioTranscription.text);
      else lastTranscriptionAt = t;
      handled = true;
    }
    if (!handled && sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
      for (let i = 0; i < sc.modelTurn.parts.length; i++) {
        const part = sc.modelTurn.parts[i];
        if (part && part.text) {
          session.lastTranscriptionAt = t;
          if (config.displayMode !== 'orig') onTranslationDelta(part.text);
          else lastTranscriptionAt = t;
        }
        if (part && part.inlineData) {
          inlineAudioChunks++;
          if (inlineAudioChunks % 20 === 1) setDiagnostics({ InlineAudio: inlineAudioChunks });
        }
      }
    }

    if (sc.turnComplete || sc.generationComplete) {
      // 避免回合结束信号将尚未说完整的句子强行斩断为碎片；若已带句末标点则立即结行，否则延时缓冲
      if (bufferEndsWithTerminal(currentTransBuffer) || currentTransBuffer.trim().length >= 20) {
        commitCurrentLine(false, 'turn-complete');
      } else if (currentTransBuffer.trim()) {
        scheduleCommit('turn-complete-idle', 600);
      }
    }
  }

  function onSessionReady(session) {
    const isStandby = session === standbySession;

    if (isStandby) {
      // 无缝轮转：新会话就绪后再切换，旧会话无缝退场
      const old = activeSession;
      activeSession = session;
      standbySession = null;
      session.rotationTimer = null;
      sessionLog('Rotation promoted', session, { previousSession: old ? old.id : null });
      if (old) closeSession(old, 'rotated-out');
    } else {
      activeSession = session;
    }

    setStatus('ok', '🟢 正在同传');
    setDiagnostics({ Session: session.id, LastReadyAt: now() });
    renderVolume(0);

    // 首次就绪：初始化音频采集；轮转时音频管线已在运行，直接切换即可
    if (!audioPipelineReady) {
      initAudioCapture(session).then(() => {
        if (session !== activeSession || !isRunning) return;
        flushAudioQueue();
        setStatus('ok', '🟢 正在同传');
        setDiagnostics({ AudioPipeline: 'running' });
      }).catch((audioErr) => {
        sessionLog('Audio capture failed', session, { error: sanitizeErrorMessage(audioErr), retryable: !!(audioErr && audioErr.retryable) });
        if (audioErr && audioErr.retryable && isRunning && session === activeSession) {
          // 视频尚未就绪 / 可恢复错误：等待播放后自动重试，而不是直接停服
          waitForVideoAndInit(session);
          return;
        }
        setStatus('err', '❌ 音频启动失败: ' + sanitizeErrorMessage(audioErr && audioErr.message ? audioErr.message : audioErr));
        stopSubtitleService(true);
      });
    } else {
      flushAudioQueue();
    }

    // 预防性轮转（长会话）
    scheduleRotation(session, 'periodic', SESSION_ROTATE_MS);
  }

  /**
   * 视频尚未就绪（用户先开字幕、后点播放）时的等待重试循环。
   * 只要服务仍在运行且会话仍是当前会话，就每 1.5s 尝试一次，直到成功或用户停止。
   */
  function waitForVideoAndInit(session) {
    if (videoWaitTimer) clearInterval(videoWaitTimer);
    setStatus('info', '⏳ 等待视频开始播放…（播放后自动开始同传）');
    setDiagnostics({ AudioPipeline: 'waiting-video' });
    videoWaitTimer = setInterval(() => {
      if (!isRunning || session !== activeSession) {
        clearInterval(videoWaitTimer);
        videoWaitTimer = null;
        return;
      }
      const video = findActiveVideo();
      if (!video || video.paused) return;
      clearInterval(videoWaitTimer);
      videoWaitTimer = null;
      initAudioCapture(session).then(() => {
        if (session !== activeSession || !isRunning) return;
        flushAudioQueue();
        setStatus('ok', '🟢 正在同传');
        setDiagnostics({ AudioPipeline: 'running' });
      }).catch((err) => {
        sessionLog('Audio capture retry failed', session, { error: sanitizeErrorMessage(err), retryable: !!(err && err.retryable) });
        if (err && err.retryable && isRunning) {
          waitForVideoAndInit(session);
        } else {
          setStatus('err', '❌ 音频启动失败: ' + sanitizeErrorMessage(err && err.message ? err.message : err));
          stopSubtitleService(true);
        }
      });
    }, 1500);
  }

  function scheduleRotation(session, reason, delayMs) {    if (!session || session !== activeSession) return;
    if (session.rotationTimer) clearTimeout(session.rotationTimer);
    const delay = Math.max(2000, delayMs || SESSION_ROTATE_MS);
    session.rotationTimer = setTimeout(() => {
      session.rotationTimer = null;
      if (!isRunning || session !== activeSession) return;
      if (standbySession) return;
      sessionLog('Starting standby rotation', session, { reason });
      setDiagnostics({ RotationReason: reason });
      const standby = createSession('rotation');
      standbySession = standby;
      connectSession(standby, { silent: true });
    }, delay);
  }

  function scheduleReconnect(reason) {
    if (!isRunning) return;
    if (reconnectTimer) return; // 已在重连计划中
    if (isConnectingUI) isConnectingUI = false;

    reconnectAttempts++;
    const delay = calculateBackoffDelay(reconnectAttempts - 1);
    setDiagnostics({ Reconnects: reconnectAttempts, ReconnectReason: reason });
    setStatus('warn', `🔄 连接断开，${(delay / 1000).toFixed(1)}s 后重连（第 ${reconnectAttempts} 次）`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isRunning) return;
      if (activeSession && activeSession.state === 'ready') return; // 已恢复
      const session = createSession('reconnect');
      connectSession(session);
    }, delay);
  }

  function manualRestart(reason) {
    if (!isRunning) return;
    sessionLog('Manual restart', activeSession, { reason });
    commitCurrentLine(true, 'restart');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    if (standbySession) { closeSession(standbySession, 'restart'); standbySession = null; }
    if (activeSession) { closeSession(activeSession, 'restart'); activeSession = null; }
    audioSendQueue.length = 0;
    reconnectAttempts = 0;
    isConnectingUI = false;
    updateToggleIcon(true);
    setStatus('info', '🔄 正在连接…');
    setDiagnostics({ Reconnects: 0, Session: 0 });
    startWatchdog();
    startSilenceFlushTimer();
    setTimeout(() => {
      if (!isRunning) return;
      connectSession(createSession('manual-restart'));
    }, 120);
  }

  function updateToggleIcon(running) {
    if (!btnToggle || !btnToggleIcon) return;
    if (running) {
      btnToggle.classList.add('active');
      btnToggleIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
    } else {
      btnToggle.classList.remove('active');
      btnToggleIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    }
  }

  // ---- 看门狗 ----------------------------------------------------------

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!isRunning) return;

      // 未连接且没有重连计划 → 兜底重连
      if (!activeSession || activeSession.state === 'closed') {
        if (!reconnectTimer && !isConnectingUI) scheduleReconnect('watchdog-no-session');
        return;
      }

      const s = activeSession;
      if (s.state === 'ready') {
        // 视频暂停期间跳过"无转写/服务端静默"看门狗，避免暂停时反复重建会话；恢复播放后会重新计时
        const paused = config.audioMode === 'video' && isVideoPaused;
        if (!paused) {
          const serverIdle = now() - (s.lastServerMsgAt || s.readyAt || now());
          if (serverIdle > SERVER_SILENCE_RECONNECT_MS) {
            sessionLog('Watchdog: server silent too long', s, { serverIdle });
            forceReconnect('server-silent');
            return;
          }
          const speechActive = now() - lastSpeechAt < 8000;
          const transcribeIdle = now() - (s.lastTranscriptionAt || s.readyAt || now());
          if (speechActive && transcribeIdle > NO_TRANSCRIPTION_RECONNECT_MS) {
            sessionLog('Watchdog: speech but no transcription', s, { transcribeIdle });
            forceReconnect('no-transcription');
            return;
          }
          // 原文在流动但译文停摆（翻译流单独卡死）→ 重连换上游
          const origActive = now() - (s.lastOrigAt || 0) < 10000;
          const outIdle = now() - (s.lastOutAt || s.readyAt || now());
          if (origActive && s.lastOutAt && outIdle > NO_TRANSLATION_RECONNECT_MS) {
            sessionLog('Watchdog: transcription flowing but translation stalled', s, { outIdle });
            forceReconnect('translation-stall');
            return;
          }
        }
        // AudioContext 挂起检测（暂停期间也要保持音频上下文可用）
        if (audioPipelineReady && audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        // 音频长时间未发送检测
        if (audioPipelineReady && !paused && now() - lastAudioSentAt > 5000) {
          sessionLog('Watchdog: audio pipeline stalled', s, { sinceLastSent: now() - lastAudioSentAt });
          try { resetResampler(audioCtx ? audioCtx.sampleRate : 48000); } catch (e) {}
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        }
      }
    }, 2500);
  }

  function forceReconnect(reason) {
    const old = activeSession;
    if (old) {
      closeSession(old, 'force-reconnect:' + reason);
      activeSession = null;
    }
    if (!reconnectTimer) scheduleReconnect(reason);
  }

  // ========================================================================
  // 8. 服务启停
  // ========================================================================

  function startSubtitleService(isManualStart = true) {
    if (isRunning) return;
    isRunning = true;
    reconnectAttempts = 0;
    updateToggleIcon(true);
    setStatus('info', '🔄 连接中…');
    startWatchdog();
    startSilenceFlushTimer();
    activeSession = null;
    connectSession(createSession('start'));
    saveConfig(true);
  }

  function stopSubtitleService(isManual = false) {
    isRunning = false;
    isConnectingUI = false;

    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (silenceFlushTimer) { clearInterval(silenceFlushTimer); silenceFlushTimer = null; }
    if (commitGraceTimer) { clearTimeout(commitGraceTimer); commitGraceTimer = null; }
    if (spaNavDebounce) { clearTimeout(spaNavDebounce); spaNavDebounce = null; }
    if (videoWaitTimer) { clearInterval(videoWaitTimer); videoWaitTimer = null; }

    if (standbySession) { closeSession(standbySession, 'service-stop'); standbySession = null; }
    if (activeSession) { closeSession(activeSession, 'service-stop'); activeSession = null; }

    cleanupAudioPipeline();
    commitCurrentLine(true, 'service-stop');
    updateToggleIcon(false);
    if (isManual) {
      setStatus('idle', '已暂停');
      setDiagnostics({ Session: 0 });
    }
  }

  function toggleOverlayVisibility() {
    if (overlay.style.display === 'none' || !overlay.style.display) {
      overlay.style.display = 'flex';
      applyInitialStyles();
      if (!isRunning) startSubtitleService(true);
    } else {
      overlay.style.display = 'none';
      settingsPanel.classList.remove('show');
      if (isRunning) stopSubtitleService(true);
    }
  }

  // ========================================================================
  // 9. 配置加载与消息接口
  // ========================================================================

  function loadStoredConfig(callback) {
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['geminiLiveConfig'], (res) => {
          if (res && res.geminiLiveConfig) {
            config = Object.assign({}, DEFAULT_CONFIG, res.geminiLiveConfig);
          if (config.model && (/gemini-3\.1/i.test(config.model) || /gemini-2/i.test(config.model))) {
            config.model = 'models/gemini-3.5-live-translate-preview';
          }
          }
          if (callback) callback();
        });
        return;
      }
    } catch (e) {}
    if (callback) callback();
  }

  function attachMessageListener() {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg) return;
        if (msg.action === 'PING') {
          sendResponse({ status: 'PONG', version: '1.0.5', running: isRunning });
        } else if (msg.action === 'CHECK_OVERLAY_VISIBLE') {
          const isVisible = overlay && overlay.style.display !== 'none' && overlay.style.display !== '';
          sendResponse({ status: 'OK', isVisible: isVisible, running: isRunning });
        } else if (msg.action === 'SHOW_OVERLAY') {
          if (overlay.style.display === 'none' || !overlay.style.display) {
            overlay.style.display = 'flex';
            applyInitialStyles();
            if (!isRunning) startSubtitleService(true);
          }
          sendResponse({ status: 'OK', isVisible: true });
        } else if (msg.action === 'TOGGLE_OVERLAY') {
          toggleOverlayVisibility();
          sendResponse({ status: 'OK', isVisible: overlay.style.display !== 'none' });
        } else if (msg.action === 'GET_STATE') {
          sendResponse({
            status: 'OK',
            running: isRunning,
            sessionId: activeSession ? activeSession.id : 0,
            state: activeSession ? activeSession.state : 'none',
            lines: committedLines,
            audioChunks: audioChunksSent
          });
        } else if (msg.action === 'UPDATE_CONFIG') {
          const previous = config;
          const incoming = msg.config || {};
          const needsRestart = isRunning && (
            (incoming.apiKey !== undefined && incoming.apiKey !== previous.apiKey) ||
            (incoming.apiHost !== undefined && incoming.apiHost !== previous.apiHost) ||
            (incoming.model !== undefined && incoming.model !== previous.model) ||
            (incoming.sourceLang !== undefined && incoming.sourceLang !== previous.sourceLang) ||
            (incoming.targetLang !== undefined && incoming.targetLang !== previous.targetLang) ||
            (incoming.audioMode !== undefined && incoming.audioMode !== previous.audioMode) ||
            (incoming.audioFrameStyle !== undefined && incoming.audioFrameStyle !== previous.audioFrameStyle) ||
            (incoming.protocolMode !== undefined && incoming.protocolMode !== previous.protocolMode) ||
            (incoming.responseModality !== undefined && incoming.responseModality !== previous.responseModality)
          );
          config = Object.assign({}, config, incoming);
          applyInitialStyles();
          updateAudioModeButton();
          if (needsRestart) manualRestart('配置更新');
          sendResponse({ status: 'OK' });
        }
      });
    } catch (e) {}
  }

  // ---- 初始化 ----------------------------------------------------------

  function init() {
    attachMessageListener();
    // 多标签页 / popup 修改配置时保持同步（自身写入因值相同会被跳过）
    try {
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes.geminiLiveConfig || !changes.geminiLiveConfig.newValue) return;
          const incoming = changes.geminiLiveConfig.newValue;
          if (JSON.stringify(incoming) === JSON.stringify(config)) return;
          config = Object.assign({}, DEFAULT_CONFIG, incoming);
          if (config.model && (/gemini-3\.1/i.test(config.model) || /gemini-2/i.test(config.model))) {
            config.model = 'models/gemini-3.5-live-translate-preview';
          }
          applyInitialStyles();
          updateAudioModeButton();
        });
      }
    } catch (e) {}
    updateAudioModeButton();
        loadStoredConfig(() => {
      applyInitialStyles();
      updateAudioModeButton();
      if (overlay.style.display !== 'none') {
        // 若此前浮窗已打开，恢复时自动开始
      }
      console.log('[Gemini Live] Engine v2 ready. model=', config.model, 'host=', sanitizeUrl(config.apiHost));
    });
    // 暴露 DOM 数据给自动化测试与页面内诊断
    hostEl.dataset.gltVersion = '1.0.5';
    setDiagnostics({ Session: 0, Lines: 0, AudioChunks: 0 });
    setStatus('idle', '就绪');
  }

  init();
})();
