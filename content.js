/**
 * Gemini Live Translator - Chrome Extension Content Script (Release Edition)
 * Modular Multi-Domain Context-Aware Translation Engine with Verse-Level Metric Lyric & Speech Segmentation
 */

(function () {
  if (window.__geminiLiveTranslatorLoaded) return;
  window.__geminiLiveTranslatorLoaded = true;

  // Default Settings State
  let config = {
    apiHost: 'https://generativelanguage.googleapis.com',
    apiKey: '',
    model: 'models/gemini-3.5-live-translate-preview',
    sourceLang: '自动识别 (Auto Detect)',
    targetLang: '中文普通话 (Chinese)',
    forcedDomain: 'GENERAL', // 'GENERAL' (default), 'CINEMA', 'VTUBER', 'TECH_LECTURE', 'GAMING', 'auto'
    fontSize: 17,
    opacity: 0.65,
    blur: 3,
    audioMode: 'video',
    width: 760,
    height: 300,
    pos: null
  };

  // Runtime State
  let isRunning = false;
  let detectedSourceLang = 'auto';
  let activeDomain = 'GENERAL';
  let ws = null;
  let audioCtx = null;
  let audioSourceNode = null;
  let processorNode = null;
  let analyserNode = null;
  let mutedGainNode = null;
  let mediaStream = null;
  let currentBoundVideo = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let isManualDisconnect = false;
  const MAX_RECONNECT_ATTEMPTS = 5;

  /**
   * Zero API Key Leakage & Privacy Protection Helper
   * Strips API keys and tokens from all error messages, URL traces, and exception dumps.
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

  /**
   * Exponential Backoff with Jitter:
   * delay = Math.min(1000 * 2^attempt * (0.8 + Math.random() * 0.4), 16000)
   */
  function calculateBackoffDelay(attempt) {
    const base = 1000 * Math.pow(2, attempt);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(Math.round(base * jitter), 16000);
  }

  /**
   * Differentiates terminal fatal errors (invalid key, 401/403, 1008 policy violation)
   * from transient network drops.
   */
  function isTerminalError(code, reasonOrMessage) {
    if (code === 1008 || code === 4400 || code === 4401 || code === 4403 || (code >= 4000 && code <= 4999)) {
      return true;
    }
    if (code === 400 || code === 401 || code === 403 || code === 404) {
      return true;
    }
    const str = String(reasonOrMessage || '');
    return /API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|API key not valid|RESOURCE_EXHAUSTED|Quota exceeded|BILLING_DISABLED/i.test(str);
  }

  // Web Audio Source Cache (WeakMap prevents GC leaks and InvalidStateError)
  const mediaSourceCache = new WeakMap();

  // Pre-allocated Static Audio Buffers for Zero-GC Downsampling
  const MAX_PCM_SAMPLES = 4096;
  const reusablePcm16 = new Int16Array(MAX_PCM_SAMPLES);
  const reusableUint8 = new Uint8Array(reusablePcm16.buffer);
  
  // Subtitle Sentence Aggregation Buffers
  let currentStreamingEntry = null;
  let currentOrigBuffer = '';
  let currentTransBuffer = '';
  let lastAudioTime = Date.now();
  let silenceFlushTimer = null;
  let isUserScrolledUp = false;
  let volumeCheckInterval = null;

  // Language Detection Heuristic Helper (Zero-Allocation charCodeAt single pass)
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
        if (kanaCount >= 2) return 'ja'; // Fast early-exit for Japanese
      } else if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF) || (code >= 0x3130 && code <= 0x318F)) {
        hangulCount++;
        if (hangulCount >= 2) return 'ko'; // Fast early-exit for Korean
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

  // Load saved settings
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['geminiLiveConfig'], (res) => {
      if (res.geminiLiveConfig) {
        config = { ...config, ...res.geminiLiveConfig };
        applyInitialStyles();
      }
    });
  }

  // 1. Create Shadow Host Element & Open ShadowRoot
  const hostEl = document.createElement('div');
  hostEl.id = 'gemini-live-translator-host';
  hostEl.style.cssText = 'all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important;';

  const shadowRoot = hostEl.attachShadow({ mode: 'open' });

  // Adopt content.css Inside ShadowRoot
  const styleLink = document.createElement('link');
  styleLink.rel = 'stylesheet';
  styleLink.href = chrome.runtime ? chrome.runtime.getURL('content.css') : 'content.css';
  shadowRoot.appendChild(styleLink);

  // Floating Overlay DOM inside ShadowRoot
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

    <!-- Live Settings Dropdown Panel -->
    <div class="g-sub-settings-panel" id="gSubSettingsPanel">
      <div class="g-sub-setting-row">
        <div class="g-sub-setting-label">
          <span>窗口不透明度</span>
          <span id="gSubOpacityVal">65%</span>
        </div>
        <input type="range" id="gSubOpacitySlider" min="10" max="100" value="65" class="g-sub-setting-slider">
      </div>

      <div class="g-sub-setting-row">
        <div class="g-sub-setting-label">
          <span>背景毛玻璃模糊度</span>
          <span id="gSubBlurVal">3px</span>
        </div>
        <input type="range" id="gSubBlurSlider" min="0" max="20" value="3" class="g-sub-setting-slider">
      </div>

      <div class="g-sub-setting-row">
        <div class="g-sub-setting-label">
          <span>译文字号大小</span>
          <span id="gSubFontSizeVal">17px</span>
        </div>
        <input type="range" id="gSubFontSizeSlider" min="12" max="30" value="17" class="g-sub-setting-slider">
      </div>
    </div>

    <div class="g-sub-body" id="gSubBody">
      <div class="g-sub-entry" id="gSubInitialPrompt">
        <div class="g-sub-trans" style="font-size: 15px; color: #94a3b8; font-weight: 500;">正在监听音轨…</div>
      </div>
    </div>

    <div class="g-sub-status-bar">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span id="gSubStatusText">就绪</span>
        <button class="g-sub-domain-btn" id="gSubDomainBtn" title="点击手动切换翻译语境模式">
          <span id="gSubDomainText">🌐 综合通用模式</span> ▾
        </button>
      </div>
      <button class="g-sub-scroll-bottom-btn" id="gSubScrollBtn">⬇ 回到最新</button>

      <!-- Domain Mode Dropdown Menu -->
      <div class="g-sub-domain-menu" id="gSubDomainMenu">
        <div class="g-sub-domain-item active" data-domain="GENERAL">🌐 综合通用模式 (默认)</div>
        <div class="g-sub-domain-item" data-domain="CINEMA">🎬 影视 / 动漫与剧场模式</div>
        <div class="g-sub-domain-item" data-domain="VTUBER">🎙️ VTuber / 圈内与歌回</div>
        <div class="g-sub-domain-item" data-domain="TECH_LECTURE">🎓 科技 / 学术演讲模式</div>
        <div class="g-sub-domain-item" data-domain="GAMING">🎮 游戏实况 / 电竞模式</div>
        <div class="g-sub-domain-item" data-domain="auto">🤖 自动检测（测试中）</div>
      </div>
    </div>
  `;

  shadowRoot.appendChild(overlay);
  document.body.appendChild(hostEl);

  // Element references
  const btnToggle = overlay.querySelector('#gSubToggle');
  const btnToggleIcon = overlay.querySelector('#gSubToggleIcon');
  const btnReconnect = overlay.querySelector('#gSubReconnect');
  const subBody = overlay.querySelector('#gSubBody');
  const statusText = overlay.querySelector('#gSubStatusText');
  const domainBtn = overlay.querySelector('#gSubDomainBtn');
  const domainText = overlay.querySelector('#gSubDomainText');
  const domainMenu = overlay.querySelector('#gSubDomainMenu');
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
  const btnClear = overlay.querySelector('#gSubClear');
  const btnClose = overlay.querySelector('#gSubClose');
  const header = overlay.querySelector('#gSubHeader');

  // Manual Reconnect Action
  btnReconnect.addEventListener('click', () => {
    statusText.textContent = '🔄 正在重置会话...';
    restartSession();
  });

  // Toggle Overlay Visibility Function
  function toggleOverlayVisibility() {
    if (overlay.style.display === 'none' || !overlay.style.display) {
      overlay.style.display = 'flex';
      applyInitialStyles();
      if (!isRunning) startSubtitleService(true);
    } else {
      overlay.style.display = 'none';
      settingsPanel.classList.remove('show');
      domainMenu.classList.remove('show');
      if (isRunning) stopSubtitleService(true);
    }
  }

  // Domain Mode Menu Handling & In-Session Steering
  domainBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    domainMenu.classList.toggle('show');
  });

  domainMenu.querySelectorAll('.g-sub-domain-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetDomain = item.getAttribute('data-domain');
      config.forcedDomain = targetDomain;
      saveConfig(true);

      domainMenu.querySelectorAll('.g-sub-domain-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      domainMenu.classList.remove('show');

      applyDomainSwitch(targetDomain);
    });
  });

  function applyDomainSwitch(forced) {
    const pageCtx = getPageContext();
    domainText.textContent = pageCtx.domainLabel;
    activeDomain = pageCtx.domain;

    if (isRunning && ws && ws.readyState === WebSocket.OPEN) {
      const tgtRule = getTargetLanguageRule(config.targetLang);
      const steeringPrompt = `[语境切换]已切换为【${pageCtx.domainLabel}】模式，请以此语境风格同传。`;
      const directiveTurn = {
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: steeringPrompt }]
            }
          ],
          turnComplete: true
        }
      };
      try {
        ws.send(JSON.stringify(directiveTurn));
      } catch (err) {}
    }
  }

  // Settings Panel Toggle & Live Sliders
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('show');
  });

  // Retargeting-Aware Outside Click Detection (Shadow DOM Compatible)
  document.addEventListener('click', (e) => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    if (!path.includes(settingsPanel) && !path.includes(btnSettings)) {
      settingsPanel.classList.remove('show');
    }
    if (!path.includes(domainMenu) && !path.includes(domainBtn)) {
      domainMenu.classList.remove('show');
    }
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

  let saveConfigTimer = null;
  /**
   * Persists configuration to chrome.storage.local.
   * @param {boolean} [immediate=false] When true, writes immediately without debounce delay.
   */
  function saveConfig(immediate = false) {
    if (saveConfigTimer) {
      clearTimeout(saveConfigTimer);
      saveConfigTimer = null;
    }

    if (immediate) {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ geminiLiveConfig: config });
      }
      return;
    }

    saveConfigTimer = setTimeout(() => {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ geminiLiveConfig: config });
      }
      saveConfigTimer = null;
    }, 250);
  }

  function applyInitialStyles() {
    overlay.style.setProperty('--g-sub-opacity', config.opacity);
    overlay.style.setProperty('--g-sub-blur', `${config.blur}px`);
    overlay.style.setProperty('--g-sub-font-size', `${config.fontSize}px`);

    if (config.width) overlay.style.width = `${config.width}px`;
    if (config.height) overlay.style.height = `${config.height}px`;

    ensureOverlayInViewport();

    if (srcLangSelect && config.sourceLang) srcLangSelect.value = config.sourceLang;
    if (tgtLangSelect && config.targetLang) tgtLangSelect.value = config.targetLang;

    opacitySlider.value = Math.round(config.opacity * 100);
    opacityVal.textContent = `${Math.round(config.opacity * 100)}%`;

    blurSlider.value = config.blur;
    blurVal.textContent = `${config.blur}px`;

    fontSizeSlider.value = config.fontSize;
    fontSizeVal.textContent = `${config.fontSize}px`;

    const activeForced = config.forcedDomain || 'GENERAL';
    domainMenu.querySelectorAll('.g-sub-domain-item').forEach((item) => {
      if (item.getAttribute('data-domain') === activeForced) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    const pageCtx = getPageContext();
    domainText.textContent = pageCtx.domainLabel;
  }

  // 2. Gesture-Aware Scroll Tracking & Anti-Flicker rAF Batching
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

  // Detect explicit user manual scroll gestures (Wheel & Touch)
  subBody.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) {
      // User scrolled UP explicitly
      const distanceFromBottom = subBody.scrollHeight - subBody.scrollTop - subBody.clientHeight;
      if (distanceFromBottom > 60) {
        isUserScrolledUp = true;
        scrollBottomBtn.style.display = 'inline-block';
        cancelPendingScroll();
      }
    } else if (e.deltaY > 0) {
      // User scrolled DOWN - restore auto-scroll if near bottom
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
    requestAnimationFrame(() => {
      isProgrammaticScrolling = false;
    });
  });

  function safeScrollToBottom() {
    if (isUserScrolledUp) return;
    if (isScrollPending) return;

    isScrollPending = true;
    scrollRafId = requestAnimationFrame(() => {
      isScrollPending = false;
      scrollRafId = null;
      if (!isUserScrolledUp && subBody) {
        isProgrammaticScrolling = true;
        subBody.scrollTop = subBody.scrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrolling = false;
        });
      }
    });
  }

  // 3. Robust Viewport Clamping & Adaptive Window Resize Engine (Scrollbar-Aware)
  function getUsableViewport() {
    const docEl = document.documentElement;
    // clientWidth/clientHeight strictly measure the usable content area inside the browser scrollbars
    const width = (docEl && docEl.clientWidth) ? docEl.clientWidth : window.innerWidth;
    const height = (docEl && docEl.clientHeight) ? docEl.clientHeight : window.innerHeight;
    return {
      width: Math.max(0, width),
      height: Math.max(0, height)
    };
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
      // Default: Clean bottom-right corner flush against window edges (left of scrollbar)
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

  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

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
    const overlayWidth = overlay.offsetWidth || 760;
    const overlayHeight = overlay.offsetHeight || 300;

    const maxLeft = Math.max(0, viewport.width - overlayWidth);
    const maxTop = Math.max(0, viewport.height - overlayHeight);

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
    const overlayWidth = overlay.offsetWidth || 760;
    const overlayHeight = overlay.offsetHeight || 300;

    const maxLeft = Math.max(0, viewport.width - overlayWidth);
    const maxTop = Math.max(0, viewport.height - overlayHeight);

    const currentLeft = Math.max(0, Math.min(maxLeft, parseFloat(overlay.style.left) || 0));
    const currentTop = Math.max(0, Math.min(maxTop, parseFloat(overlay.style.top) || 0));

    config.pos = {
      left: currentLeft,
      top: currentTop
    };

    config.posRatio = {
      x: maxLeft > 0 ? currentLeft / maxLeft : 1,
      y: maxTop > 0 ? currentTop / maxTop : 1
    };

    overlay.style.left = `${currentLeft}px`;
    overlay.style.top = `${currentTop}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';

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

  // 4. UI Actions
  btnClose.addEventListener('click', () => {
    overlay.style.display = 'none';
    settingsPanel.classList.remove('show');
    domainMenu.classList.remove('show');
    if (isRunning) stopSubtitleService(true);
  });

  btnClear.addEventListener('click', () => {
    cancelPendingScroll();
    subBody.innerHTML = `
      <div class="g-sub-entry" id="gSubInitialPrompt">
        <div class="g-sub-trans" style="font-size: 14px; color: #64748b;">（已清屏，正在监听音轨…）</div>
      </div>
    `;
    currentStreamingEntry = null;
    currentOrigBuffer = '';
    currentTransBuffer = '';
    subBody.scrollTop = 0;
  });

  btnAudioMode.addEventListener('click', () => {
    config.audioMode = config.audioMode === 'video' ? 'mic' : 'video';
    btnAudioMode.textContent = config.audioMode === 'video' ? '🎵' : '🎙️';
    btnAudioMode.title = config.audioMode === 'video' ? '当前音源: 网页视频' : '当前音源: 麦克风/系统声音';
    saveConfig(true);
    if (isRunning) restartSession();
  });

  srcLangSelect.addEventListener('change', () => {
    config.sourceLang = srcLangSelect.value;
    saveConfig(true);
    if (isRunning) restartSession();
  });

  tgtLangSelect.addEventListener('change', () => {
    config.targetLang = tgtLangSelect.value;
    saveConfig(true);
    if (isRunning) restartSession();
  });

  btnToggle.addEventListener('click', () => {
    if (isRunning) {
      stopSubtitleService(true);
    } else {
      startSubtitleService(true);
    }
  });

  // 5. Cross-Lingual Syntactic Clause & Prosodic Lyric Segmentation Engine
  const TERMINAL_PUNCTUATION_REGEX = /[。！？!?\n]/;
  
  // Forbidden tail words: A sentence or lyric verse must NEVER be severed right after these open tokens
  const ZH_UNFINISHED_TAIL = /(的|地|得|在|于|把|被|让|从|向|为|给|和|与|或|以及|因为|所以|如果|虽然|但是|而且|不仅|却|即使|即便|着|会|能|想|要|去|什么|那|这|那个|某|那时候|这个时候|当时|时|的时候|然后|之后|接下来|后来|非常|特别|十分|很|极|挺|过于|太|更|最|相当|稍微|格外|正在|准备|打算|因为是|觉得|感觉)\s*$/;
  const JA_UNFINISHED_TAIL = /(の|に|へ|で|と|を|から|より|まで|は|が|も|って|という|けど|けれど|ので|のに|ても|でも|て|で|ながら|たり|し|あの|その|この|えっと|時|とき|その時|あの時|すごく|とても|めっちゃ|なんか|なんかさ|って感じ|ていうか|やはり|やっぱり)\s*$/;
  const EN_UNFINISHED_TAIL = /\b(for|to|in|on|at|of|with|by|from|about|into|through|during|before|after|and|or|but|that|which|who|whom|whose|where|when|while|because|although|if|as|than|the|a|an|is|are|was|were|be|been|being|have|has|had|very|really|quite|extremely|then|when|while)\s*$/i;

  // Short conversational fillers that MUST NOT be split into individual lines
  const IS_STANDALONE_FILLER = /^(嗯|好的|啊|好|对|是的|算了吧|算了|好吧|行|真的吗|诶|哎|也就是|那个|等等|稍等|好吧|对啊|就是|对的|好的好的|嗯嗯|哈|呀|吧|呼|了呢|是这样|然后呢|那么)[。！？!?，,\s]*$/;

  function isSentenceSyntacticallyComplete(orig, trans) {
    const trimmedOrig = (orig || '').trim();
    const trimmedTrans = (trans || '').trim();

    if (!trimmedTrans) return false;

    const hasTerminal = /[。！？!?\n]/.test(trimmedTrans) || /[。！？!?\n]/.test(trimmedOrig);
    const isDangling = ZH_UNFINISHED_TAIL.test(trimmedTrans);

    if (hasTerminal && !isDangling && trimmedTrans.length >= 2) {
      return true;
    }

    if (trimmedTrans.length >= 24 && !isDangling) {
      return true;
    }

    return trimmedTrans.length >= 35;
  }

  function commitActiveSentence() {
    const trimmed = currentTransBuffer.trim();
    if (!trimmed) {
      if (currentStreamingEntry && !currentOrigBuffer.trim()) {
        currentStreamingEntry.remove();
        currentStreamingEntry = null;
      }
      return;
    }

    if (currentStreamingEntry) {
      currentStreamingEntry.classList.remove('streaming');
      if (currentStreamingEntry._transText) {
        currentStreamingEntry._transText.nodeValue = currentTransBuffer;
      }
      currentStreamingEntry = null;
    }
    currentOrigBuffer = '';
    currentTransBuffer = '';

    while (subBody.children.length > 50) {
      subBody.removeChild(subBody.firstChild);
    }
    safeScrollToBottom();
  }

  // Target Language Rule Factory (Fully Dynamic per Selected Target Language)
  function getTargetLanguageRule(targetLang) {
    const t = (targetLang || '').toLowerCase();
    if (t.includes('英语') || t.includes('english') || t.includes('en')) {
      return {
        id: 'en',
        name: 'English',
        nameEn: 'English (US/UK)',
        systemPrompt: `[CRITICAL DIRECTIVE]: You are a Real-Time Simultaneous Audio Interpreter.
TARGET LANGUAGE: Strictly English.
INPUT AUDIO: Japanese / Chinese / Spanish / Foreign Language Speech & Singing.

RULES:
1. OUTPUT LANGUAGE MUST ALWAYS BE 100% English.
2. Translate all non-English speech directly into natural English.
3. NEVER output Chinese characters (汉字) or Japanese Kana (假名).
4. Only output the translated English text. Never output notes or explanations.`,
        negativeRule: '必须全部翻译为 English 输出，严禁输出中文汉字或日文假名。',
        initTurnText: '[Initialization]: Translate all incoming audio in real-time strictly into English. Never output original foreign speech.',
        driftWarning: '[Language Drift]: Target language is English. Please output all translations in English only!'
      };
    } else if (t.includes('日语') || t.includes('japanese') || t.includes('ja')) {
      return {
        id: 'ja',
        name: '日本語',
        nameEn: 'Japanese (日本語)',
        systemPrompt: `[CRITICAL DIRECTIVE]: あなたはリアルタイムの同時通訳システムです。
TARGET LANGUAGE: 日本語 (Japanese).
INPUT AUDIO: 英語・中国語などの外国語音声。

RULES:
1. 出力言語は100%【日本語】で統一してください。
2. 外国語の音声を自然で流暢な日本語に翻訳して出力してください。
3. 英語や中国語の原文をそのまま出力しないでください。
4. 翻訳結果のテキストのみを出力し、説明や注釈は出力しないでください。`,
        negativeRule: '翻訳結果はすべて日本語で出力してください。外国語の原文を出力しないでください。',
        initTurnText: '【通訳初期化指示】：すべての音声をリアルタイムで【日本語】に通訳して出力してください。',
        driftWarning: '【言語修正】：ターゲット言語は日本語です。翻訳結果はすべて日本語で出力してください。'
      };
    }

    // Default: Simplified Chinese
    return {
      id: 'zh',
      name: '简体中文',
      nameEn: 'Simplified Chinese (zh-CN)',
      systemPrompt: `[CRITICAL DIRECTIVE]: You are a Real-Time Simultaneous Audio Interpreter.
TARGET LANGUAGE: Strictly Simplified Chinese (简体中文 / zh-CN).
INPUT AUDIO: Japanese / English / Foreign Language Speech & Audio.

RULES:
1. OUTPUT LANGUAGE MUST ALWAYS BE 100% Simplified Chinese (简体中文).
2. Translate all foreign speech directly into natural Simplified Chinese.
3. NEVER output English translations or Japanese transcriptions when the target is Chinese.
4. Only output the translated Chinese text. Never output notes or explanations.

【翻译铁律】：
1. 输出语言唯一：无论输入的原始音频是何种语言，输出文本必须 100% 全部使用【简体中文】。
2. 严禁原文复述：绝对严禁输出任何英文翻译或日文假名原文。
3. 仅输出翻译文本，不要输出任何解释或注释。`,
      negativeRule: '必须全部同传翻译为简体中文输出，严禁输出英文或日文假名。',
      initTurnText: '【同传初始化指令】：请将接收到的全部音频内容同声传译为【简体中文】。严禁输出英文或日文。',
      driftWarning: '【系统指令】：目标语言是【简体中文】！请立即将接收到的音频全部同声传译为简体中文输出！严禁输出英文或日文！'
    };
  }

  /**
   * Fast Zero-Allocation Language Drift Checker
   * Uses single-pass charCodeAt with early-exit conditions.
   */
  function isLanguageDrifted(chunk, targetId) {
    if (!chunk || typeof chunk !== 'string') return false;
    const len = chunk.length;

    if (targetId === 'zh') {
      let hasChinese = false;
      let latinCount = 0;
      for (let i = 0; i < len; i++) {
        const code = chunk.charCodeAt(i);
        // Immediate early-exit on Kana or Hangul when target is Chinese
        if ((code >= 0x3040 && code <= 0x30FF) || 
            (code >= 0xAC00 && code <= 0xD7AF) || 
            (code >= 0x1100 && code <= 0x11FF) || 
            (code >= 0x3130 && code <= 0x318F)) {
          return true;
        }
        if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
          hasChinese = true;
        } else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          latinCount++;
        }
      }
      // Only drifted if Latin words dominate without any Chinese ideographs
      return !hasChinese && latinCount > 3;
    }

    if (targetId === 'en') {
      for (let i = 0; i < len; i++) {
        const code = chunk.charCodeAt(i);
        // Immediate early-exit on any Asian character when target is English
        if ((code >= 0x4E00 && code <= 0x9FFF) || 
            (code >= 0x3400 && code <= 0x4DBF) || 
            (code >= 0x3040 && code <= 0x30FF) || 
            (code >= 0xAC00 && code <= 0xD7AF) || 
            (code >= 0x1100 && code <= 0x11FF) || 
            (code >= 0x3130 && code <= 0x318F)) {
          return true;
        }
      }
      return false;
    }

    if (targetId === 'ja') {
      let hasKanaOrKanji = false;
      let latinCount = 0;
      for (let i = 0; i < len; i++) {
        const code = chunk.charCodeAt(i);
        // Immediate early-exit on Hangul when target is Japanese
        if ((code >= 0xAC00 && code <= 0xD7AF) || 
            (code >= 0x1100 && code <= 0x11FF) || 
            (code >= 0x3130 && code <= 0x318F)) {
          return true;
        }
        if ((code >= 0x3040 && code <= 0x30FF) || 
            (code >= 0x4E00 && code <= 0x9FFF) || 
            (code >= 0x3400 && code <= 0x4DBF)) {
          hasKanaOrKanji = true;
        } else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          latinCount++;
        }
      }
      return !hasKanaOrKanji && latinCount > 3;
    }

    return false;
  }

  let lastDriftWarningTime = 0;
  function checkAndCorrectLanguageDrift(chunk) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const tgtRule = getTargetLanguageRule(config.targetLang);

    if (isLanguageDrifted(chunk, tgtRule.id) && Date.now() - lastDriftWarningTime > 1000) {
      lastDriftWarningTime = Date.now();
      console.warn(`[Gemini Live] Target language drift detected (${tgtRule.name}), sending immediate steering turn...`);
      try {
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{
              role: 'user',
              parts: [{ text: tgtRule.driftWarning }]
            }],
            turnComplete: true
          }
        }));
      } catch (e) {}
    }
  }

  function handleIncomingOriginalChunk(chunk) {
    const initPrompt = overlay.querySelector('#gSubInitialPrompt');
    if (initPrompt) initPrompt.remove();

    currentOrigBuffer += chunk;
    updateActiveStreamingEntry();
    lastAudioTime = Date.now();

    if (config.sourceLang.includes('自动识别')) {
      const lang = detectLanguageFromText(currentOrigBuffer);
      if (lang !== 'auto' && lang !== detectedSourceLang) {
        detectedSourceLang = lang;
        const langMap = {
          'ja': '🇯🇵 日语',
          'en': '🇺🇸 英语',
          'ko': '🇰🇷 韩语',
          'zh': '🇨🇳 中文'
        };
        const detectedName = langMap[lang] || '多语言';
        const optAuto = srcLangSelect.querySelector('option[value*="自动识别"]');
        if (optAuto) {
          optAuto.textContent = `🌐 自动 (${detectedName})`;
        }
      }
    }
  }

  function handleIncomingTranslatedChunk(chunk) {
    const initPrompt = overlay.querySelector('#gSubInitialPrompt');
    if (initPrompt) initPrompt.remove();

    currentTransBuffer += chunk;
    updateActiveStreamingEntry();
    lastAudioTime = Date.now();

    // Dynamically check for target language drift
    checkAndCorrectLanguageDrift(currentTransBuffer);

    if (isSentenceSyntacticallyComplete(currentOrigBuffer, currentTransBuffer)) {
      splitAndCommitSentences();
    }
  }

  /**
   * Zero-Reflow Subtitle Streaming Renderer
   * Mutates persistent Text nodes directly without HTML parsing or DOM recreation.
   */
  function updateActiveStreamingEntry() {
    const initPrompt = overlay.querySelector('#gSubInitialPrompt');
    if (initPrompt) initPrompt.remove();

    if (!currentStreamingEntry) {
      const entry = document.createElement('div');
      entry.className = 'g-sub-entry streaming';

      // Original speech container & Text node
      const origEl = document.createElement('div');
      origEl.className = 'g-sub-orig';
      origEl.style.display = 'none';
      const origTextNode = document.createTextNode('');
      origEl.appendChild(origTextNode);

      // Translation container & Text node
      const transEl = document.createElement('div');
      transEl.className = 'g-sub-trans';
      const transTextNode = document.createTextNode('...');
      transEl.appendChild(transTextNode);

      entry.appendChild(origEl);
      entry.appendChild(transEl);

      // Cache references on the DOM entry instance for zero-lookup access
      entry._origEl = origEl;
      entry._origText = origTextNode;
      entry._transEl = transEl;
      entry._transText = transTextNode;

      subBody.appendChild(entry);
      currentStreamingEntry = entry;
    }

    // Mutate Original Speech Text Node
    if (currentOrigBuffer) {
      if (currentStreamingEntry._origEl.style.display === 'none') {
        currentStreamingEntry._origEl.style.display = '';
      }
      currentStreamingEntry._origText.nodeValue = currentOrigBuffer;
    } else {
      if (currentStreamingEntry._origEl.style.display !== 'none') {
        currentStreamingEntry._origEl.style.display = 'none';
      }
    }

    // Mutate Translated Speech Text Node
    currentStreamingEntry._transText.nodeValue = currentTransBuffer || '...';

    // Request batched scroll update
    safeScrollToBottom();
  }

  function splitAndCommitSentences() {
    if (currentTransBuffer.trim().length > 3 || currentOrigBuffer.trim().length > 4) {
      if (currentStreamingEntry) {
        currentStreamingEntry.classList.remove('streaming');
        if (currentStreamingEntry._transText) {
          currentStreamingEntry._transText.nodeValue = currentTransBuffer;
        }
        currentStreamingEntry = null;
      }
      currentOrigBuffer = '';
      currentTransBuffer = '';

      // Maintain max history buffer (40 entries) to prevent DOM bloat
      while (subBody.children.length > 40) {
        subBody.removeChild(subBody.firstChild);
      }
      safeScrollToBottom();
    }
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

  /**
   * High-performance full DOM sanitizer escaping &, <, >, ", ', and `
   * Uses non-allocating fast-path check for strings without special chars.
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const s = typeof str === 'string' ? str : String(str);
    if (!HTML_ESCAPE_REGEX.test(s)) return s;
    return s.replace(HTML_ESCAPE_REGEX, (ch) => HTML_ESCAPE_MAP[ch]);
  }

  // 6. Universal Multi-Dimensional Domain Classifier
  // Relies on Platform Native Metadata & Generic Structural Format Identifiers (No hardcoded individual names)
  function getPageContext() {
    let title = document.title || '';
    title = title.replace(/\s*-\s*YouTube$/i, '').replace(/\s*-\s*Twitch$/i, '').replace(/\s*_\s*哔哩哔哩_bilibili$/i, '').trim();

    let channelName = '';
    const channelEl = document.querySelector('#owner #channel-name a, ytd-channel-name a, #upload-info #channel-name a, [data-a-target="user-channel-link"], .up-name, .username, .up-info--right .name, #channel-header-container');
    if (channelEl) {
      channelName = channelEl.textContent.trim();
    }

    // Extract native platform category metadata
    let platformGenre = '';
    const genreMeta = document.querySelector('meta[itemprop="genre"], meta[property="og:video:type"], meta[name="category"]');
    if (genreMeta && genreMeta.content) platformGenre += ' ' + genreMeta.content;

    let metaTags = '';
    const tagMeta = document.querySelectorAll('meta[property="og:video:tag"], meta[name="keywords"], meta[property="og:title"]');
    tagMeta.forEach(m => {
      if (m.content) metaTags += ' ' + m.content;
    });

    const extraTagElements = document.querySelectorAll('.tag-link, .video-tag a, .breadcrumb-item, a[href*="/v/"], .video-tag-container a, yt-formatted-string.super-title a, a[href*="/hashtag/"], ytd-badge-supported-renderer, [data-a-target="stream-game-link"]');
    extraTagElements.forEach(t => {
      if (t.textContent) metaTags += ' ' + t.textContent;
    });

    // Check manual override
    if (config.forcedDomain && config.forcedDomain !== 'auto') {
      const labels = {
        'CINEMA': '🎬 影视 / 动漫与剧场',
                'VTUBER': '🎙️ VTuber / 圈内与歌回',
        'TECH_LECTURE': '🎓 科技 / 学术演讲',
        'GAMING': '🎮 游戏实况 / 电竞',
        'GENERAL': '🌐 综合通用模式'
      };
      return {
        title: title.slice(0, 150),
        channel: channelName.slice(0, 80),
        domain: config.forcedDomain,
        domainLabel: labels[config.forcedDomain] || '🏷️ 自定义模式'
      };
    }

    const titleLower = title.toLowerCase();
    const channelLower = channelName.toLowerCase();
    const metaLower = (metaTags + ' ' + platformGenre).toLowerCase();
    const fullText = `${titleLower} ${channelLower} ${metaLower}`;

    const scores = { CINEMA: 0, VTUBER: 0, TECH_LECTURE: 0, GAMING: 0 };

    // 1. Platform Native Category Mapping (+30 score)
        if (/gaming|游戏|单机游戏|网游/.test(metaLower)) scores.GAMING += 30;
    if (/film & animation|anime|bangumi|番剧|动画|影视|电影/.test(metaLower)) scores.CINEMA += 30;
    if (/education|science & technology|知识|公开课|科技/.test(metaLower)) scores.TECH_LECTURE += 30;
    if (/just chatting|virtual youtuber|雑談/.test(metaLower)) scores.VTUBER += 30;

    // 2. Comprehensive Generic Structural Format Identifiers
    const formatPatterns = {
      VTUBER: [
        'vtuber', 'vstreamer', 'バーチャル', '生配信', '雑談', '歌枠', '歌雑', '凸待ち', 'メン限', 'ms限定',
        '切り抜き', 'virtual youtuber', 'v-tuber', 'sub ch', 'sub channel', 'メンバーシップ', '初配信', '3dお披露目',
        '自己紹介', 'ラジオ', 'radio', '生放送', '放送', '新衣装', '定期配信', 'コラボ', 'collab', '企画', '耐久', '朝活', '夜活',
        '初投稿', '観測部', 'ファンクラブ', 'fanclub', '枠', 'ライバー', 'liver'
      ],
      CINEMA: [
        'anime', 'animation', 'theatrical', 'ova', 'ona', 'movie', 'film', 'cinema', 'drama', 'series', 'season', 'trailer', 'teaser',
        'アニメ', '劇場版', '映画', 'ドラマ', '番剧', '新番', '剧场版', '动画', '声優', '配音', '熟肉', '超清中字', '汉化', '中字', '字幕',
        '预告片', '予告', '特報', '本編', '前編', '後編', '総集編', '作画', '正片', '全集', '吹き替え', 'アフレコ'
      ],
      TECH_LECTURE: [
        'keynote', 'symposium', 'colloquium', 'lecture', 'seminar', 'conference', 'presentation', 'tutorial', 'course', 'workshop',
        'ted', 'tedx', 'panel discussion', 'roundtable', 'fireside chat', 'interview', 'debate', 'dialogue', 'documentary',
        '公开课', '学术报告', '研讨会', '讲座', '论坛', '教程', '访谈', '学术', '演讲'
      ],
      GAMING: [
        'gameplay', 'walkthrough', 'playthrough', 'speedrun', 'esports', 'lets play', "let's play", 'boss fight',
        '実況', 'ゲーム実況', 'ゲーム配信', 'ゲームプレイ', 'プレイ動画', '初見', '縛りプレイ', 'クリア',
        '游戏实况', '实况解说', '通关攻略', '对决', '试玩'
      ]
    };

    // Regex check for episodic anime/series patterns: e.g. 第1話, 第12集, EP01, #01, etc.
    if (/第\s*\d+\s*[話话集期]|ep\s*\d+|全\s*\d+\s*[話话集]|#\s*\d+/i.test(titleLower)) {
      scores.CINEMA += 25;
    }

    // Match structural terms across title (weight 20) and metadata (weight 10)
    for (const [domainKey, terms] of Object.entries(formatPatterns)) {
      terms.forEach(term => {
        if (titleLower.includes(term) || channelLower.includes(term)) {
          scores[domainKey] += 20;
        } else if (metaLower.includes(term)) {
          scores[domainKey] += 10;
        }
      });
    }

    let maxDomain = 'GENERAL';
    let maxScore = 0;

    for (const [domainKey, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        maxDomain = domainKey;
      }
    }

    // Lower threshold to 8 to ensure single strong signal immediately matches
    if (maxScore < 8) {
      maxDomain = 'GENERAL';
    }

    const domainLabels = {
      'CINEMA': '🎬 影视 / 动漫与剧场',
            'VTUBER': '🎙️ VTuber / 圈内与歌回',
      'TECH_LECTURE': '🎓 科技 / 学术演讲',
      'GAMING': '🎮 游戏实况 / 电竞',
      'GENERAL': '🌐 综合通用模式'
    };

    return {
      title: title.slice(0, 150),
      channel: channelName.slice(0, 80),
      domain: maxDomain,
      domainLabel: domainLabels[maxDomain]
    };
  }

  // 7. Modular System Prompt Factory
  function buildDynamicSystemPrompt(pageCtx) {
    const srcLangDesc = config.sourceLang.includes('自动')
      ? '自动识别（根据音频输入实时判断源语言）'
      : config.sourceLang;

    const tgtRule = getTargetLanguageRule(config.targetLang);

    const baseHeader = `${tgtRule.systemPrompt}

【视频参考背景】：
- 标题：${pageCtx.title || '无'}
- 频道：${pageCtx.channel || '无'}
- 源语言：${srcLangDesc}
- 目标语言：【${tgtRule.name}】`;

    let domainModule = '';

    switch (pageCtx.domain) {
      case 'CINEMA':
        domainModule = `
【影视动漫与剧场场景】：
- 风格引导：地道生动的影视译制与动漫配词风格，生动传达人物性格、情绪起伏与戏剧张力。
- 对白节奏：契合剧情对话节奏，多人交替对白时保持各句清晰独立。
- 声音过滤：专注人物台词与画外音，忽略环境拟音、打斗与背景垫乐。`;
        break;

      case 'VTUBER':
        domainModule = `
【VTuber 与网络直播场景】：
- 交流风格：口语生动自然、亲切连贯，精准传达主播的语气情绪与幽默感。
- 互动节奏：契合直播交流节奏，清晰传达主播与观众的互动氛围与生动表达。`;
        break;

      case 'TECH_LECTURE':
        domainModule = `
【科技与学术演讲场景】：
- 风格引导：严谨准确、逻辑清晰，符合学术论坛与行业会议的规范表达。
- 论述完整：完整传达复合长句与从句的逻辑脉络，行业术语使用通用标准称谓。`;
        break;

      case 'GAMING':
        domainModule = `
【游戏实况与电竞场景】：
- 风格引导：节奏明快、生动传神，准确传递玩家的操作情绪、战术沟通与临场反应。
- 游戏概念：贴合玩家习惯，准确翻译核心机制、技能、装备与赛场术语。`;
        break;

      case 'GENERAL':
      default:
        domainModule = `
【通用视频场景】：
- 风格引导：流畅通顺、通俗自然，准确传达说话人的原意、态度与语气。`;
        break;
    }

    return `${baseHeader}\n${domainModule}`;
  }

  /**
   * High-performance Chunked Base64 encoder for TypedArrays.
   * Avoids V8 maximum call stack size limits while eliminating per-character string allocation.
   */
  function uint8ToBase64(uint8Arr, byteLength) {
    let binary = '';
    const CHUNK_SIZE = 8192;
    const view = uint8Arr.subarray(0, byteLength);
    for (let i = 0; i < byteLength; i += CHUNK_SIZE) {
      const chunk = view.subarray(i, Math.min(i + CHUNK_SIZE, byteLength));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  // 8. Non-Intrusive High-Fidelity Audio Capture Engine
  let persistentAudioCtx = null;

  function getOrCreateAudioGraph(video) {
    if (!persistentAudioCtx || persistentAudioCtx.state === 'closed') {
      persistentAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (persistentAudioCtx.state === 'suspended') {
      persistentAudioCtx.resume().catch(() => {});
    }

    let sourceNode = mediaSourceCache.get(video);
    if (!sourceNode) {
      sourceNode = persistentAudioCtx.createMediaElementSource(video);
      // Lossless speaker passthrough to keep audio in sync with native video clock
      sourceNode.connect(persistentAudioCtx.destination);
      mediaSourceCache.set(video, sourceNode);
    }
    return { audioCtx: persistentAudioCtx, sourceNode };
  }

  function findActiveVideo() {
    const videos = Array.from(document.querySelectorAll('video, audio'));
    if (videos.length === 0) return null;
    const playing = videos.find((v) => !v.paused && v.currentTime > 0);
    return playing || videos[0];
  }

  function onVideoSeeking() {
    if (isRunning) {
      commitActiveSentence();
    }
  }

  function onVideoPause() {
    if (isRunning) {
      commitActiveSentence();
      if (statusText && !isConnecting) {
        statusText.textContent = '⏸️ 视频已暂停';
        statusText.style.color = '#94a3b8';
      }
    }
  }

  function onVideoPlay() {
    if (isRunning) {
      if (persistentAudioCtx && persistentAudioCtx.state === 'suspended') {
        persistentAudioCtx.resume().catch(() => {});
      }
    }
  }

  /**
   * Dynamically rebinds audio pipeline to a newly detected active video element
   * without interrupting WebSocket streaming session.
   */
  function rebindActiveVideo(newVideo) {
    if (!isRunning || config.audioMode === 'mic' || !newVideo || newVideo === currentBoundVideo) return;
    if (!audioCtx || !processorNode || !analyserNode) return;

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

    if (audioSourceNode) {
      try { audioSourceNode.disconnect(); } catch (e) {}
      try { audioSourceNode.connect(audioCtx.destination); } catch (e) {}
    }

    audioSourceNode = graph.sourceNode;
    audioSourceNode.connect(analyserNode);
    audioSourceNode.connect(processorNode);

    commitActiveSentence();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  // Multi-Platform SPA Navigation & Dynamic Media Detection
  let spaNavDebounce = null;
  function onSpaNavigationDetected() {
    if (!isRunning) return;
    if (spaNavDebounce) clearTimeout(spaNavDebounce);
    spaNavDebounce = setTimeout(() => {
      if (isRunning) {
        const newVideo = findActiveVideo();
        if (newVideo && newVideo !== currentBoundVideo) {
          rebindActiveVideo(newVideo);
        }
        // Update page context and domain if title or path mutated
        const pageCtx = getPageContext();
        domainText.textContent = pageCtx.domainLabel;
        activeDomain = pageCtx.domain;
      }
    }, 400);
  }

  // Intercept HTML5 History API (Bilibili, Netflix, Coursera, Twitter, Twitch, etc.)
  (function hookHistory() {
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

    // Title mutation observer fallback for complex SPA frameworks
    const titleEl = document.querySelector('title');
    if (titleEl) {
      const titleObserver = new MutationObserver(() => {
        onSpaNavigationDetected();
      });
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  })();

  // Global Video Play Event Listener (Capture Phase)
  // Automatically detects when a new video starts playing without needing full session reset
  document.addEventListener('play', (e) => {
    if (isRunning && config.audioMode === 'video' && e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
      if (e.target !== currentBoundVideo) {
        rebindActiveVideo(e.target);
      }
    }
  }, true);

  // HTML5 Fullscreen Reparenting Support
  // Reparents hostEl into document.fullscreenElement to overcome Top Layer rendering exclusion
  function handleFullscreenChange() {
    const fsElement = document.fullscreenElement || 
                      document.webkitFullscreenElement || 
                      document.mozFullScreenElement || 
                      document.msFullscreenElement;
    if (fsElement) {
      if (hostEl.parentElement !== fsElement) {
        fsElement.appendChild(hostEl);
      }
    } else {
      if (hostEl.parentElement !== document.body) {
        document.body.appendChild(hostEl);
      }
    }
  }

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  document.addEventListener('mozfullscreenchange', handleFullscreenChange);
  document.addEventListener('MSFullscreenChange', handleFullscreenChange);

  // Clean shutdown on page unload / navigate away
  window.addEventListener('pagehide', () => {
    if (isRunning) {
      stopSubtitleService(true);
    }
  });

  let activeSessionId = 0;
  let sessionRotationTimer = null;
  let isConnecting = false;

  /**
   * Thoroughly cleans up all active audio nodes, intervals, and stops hardware microphone streams.
   */
  function cleanupAudioPipeline() {
    chrome.runtime.sendMessage({ action: 'STOP_TAB_CAPTURE' }).catch(() => {});
    if (volumeCheckInterval) {
      clearInterval(volumeCheckInterval);
      volumeCheckInterval = null;
    }
    if (silenceFlushTimer) {
      clearInterval(silenceFlushTimer);
      silenceFlushTimer = null;
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
    // Hardening: Stop hardware microphone track immediately to release indicator & conserve power
    if (mediaStream) {
      try {
        mediaStream.getTracks().forEach((track) => {
          if (track && typeof track.stop === 'function') {
            track.stop();
          }
        });
      } catch (e) {
        console.warn('[Gemini Live] Failed to stop media stream tracks:', sanitizeErrorMessage(e));
      }
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
      // Restore lossless speaker passthrough for video element
      if (config.audioMode !== 'mic' && audioCtx && audioCtx.state !== 'closed') {
        try { audioSourceNode.connect(audioCtx.destination); } catch (e) {}
      }
      audioSourceNode = null;
    }
    // Dedicated microphone AudioContext teardown
    if (config.audioMode === 'mic' && audioCtx && audioCtx !== persistentAudioCtx) {
      try {
        if (audioCtx.state !== 'closed') {
          audioCtx.close().catch(() => {});
        }
      } catch (e) {}
      audioCtx = null;
    }
  }

  // Receive offscreen tab audio streaming events
  chrome.runtime.onMessage.addListener((msg) => {
    if (!isRunning) return;
    if (msg.type === 'TAB_AUDIO_PCM_CHUNK') {
      if (ws && ws.readyState === WebSocket.OPEN && msg.b64Audio) {
        const payload = `{"realtimeInput":{"mediaChunks":[{"mimeType":"audio/pcm;rate=16000","data":"${msg.b64Audio}"}]}}`;
        try { ws.send(payload); } catch (e) {}
      }
      lastAudioTime = Date.now();
    } else if (msg.type === 'TAB_AUDIO_VOLUME') {
      if (statusText && !isConnecting) {
        const vol = msg.volume || 0;
        if (vol > 2) {
          statusText.textContent = `🎙️ 正在同传 (音量 ${Math.min(100, Math.round(vol * 2))}%)`;
          statusText.style.color = '#34d399';
        } else {
          statusText.textContent = '⏳ 监听音频中...';
          statusText.style.color = '#94a3b8';
        }
      }
    } else if (msg.type === 'TAB_AUDIO_READY') {
      if (statusText && !isConnecting) {
        statusText.textContent = '⏳ 监听音频中...';
        statusText.style.color = '#94a3b8';
      }
    } else if (msg.type === 'TAB_AUDIO_ERROR') {
      if (statusText && isRunning) {
        statusText.textContent = `❌ 音频捕获失败: ${msg.error || '未知错误'}`;
        statusText.style.color = '#f87171';
      }
    }
  });

  async function initAudioCapture(sessionId) {
    cleanupAudioPipeline();

    if (config.audioMode === 'mic') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      if (sessionId !== activeSessionId || !isRunning) {
        if (audioCtx && audioCtx.state !== 'closed') {
          audioCtx.close().catch(() => {});
        }
        audioCtx = null;
        return;
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false }
        });
      } catch (micErr) {
        if (audioCtx && audioCtx.state !== 'closed') {
          audioCtx.close().catch(() => {});
        }
        audioCtx = null;
        throw new Error('麦克风权限被拒绝或未找到音频输入设备: ' + (micErr.message || micErr));
      }

      // Async session generation guard: ensure late-resolving getUserMedia tracks in an aborted session are immediately terminated and not leaked
      if (sessionId !== activeSessionId || !isRunning) {
        try {
          stream.getTracks().forEach((track) => {
            if (track && typeof track.stop === 'function') {
              track.stop();
            }
          });
        } catch (e) {}
        if (audioCtx && audioCtx.state !== 'closed') {
          audioCtx.close().catch(() => {});
        }
        audioCtx = null;
        return;
      }

      mediaStream = stream;
      audioSourceNode = audioCtx.createMediaStreamSource(mediaStream);

      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      audioSourceNode.connect(analyserNode);

      const pcmVolumeData = new Uint8Array(analyserNode.frequencyBinCount);
      volumeCheckInterval = setInterval(() => {
        if (!isRunning || !analyserNode) return;
        analyserNode.getByteFrequencyData(pcmVolumeData);
        let sum = 0;
        for (let i = 0; i < pcmVolumeData.length; i++) sum += pcmVolumeData[i];
        const avg = sum / pcmVolumeData.length;
        if (avg > 2) {
          statusText.textContent = `🎙️ 正在同传 (音量 ${Math.min(100, Math.round(avg * 2))}%)`;
          statusText.style.color = '#34d399';
        } else {
          statusText.textContent = '⏳ 监听音频中...';
          statusText.style.color = '#94a3b8';
        }
      }, 500);

      // Dynamic downsampling from Native SampleRate (44.1k/48k) to 16kHz PCM with Linear Interpolation
      const bufferSize = 4096;
      processorNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      const nativeSampleRate = audioCtx.sampleRate || 48000;
      const targetSampleRate = 16000;
      const sampleRatio = nativeSampleRate / targetSampleRate;

      processorNode.onaudioprocess = (e) => {
        if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const outLength = Math.floor(inputData.length / sampleRatio);
        if (outLength <= 0) return;

        // High-fidelity linear interpolation resampler
        for (let i = 0; i < outLength; i++) {
          const srcPos = i * sampleRatio;
          const idx0 = Math.floor(srcPos);
          const idx1 = idx0 + 1 < inputData.length ? idx0 + 1 : inputData.length - 1;
          const frac = srcPos - idx0;
          const s0 = Number.isFinite(inputData[idx0]) ? inputData[idx0] : 0;
          const s1 = Number.isFinite(inputData[idx1]) ? inputData[idx1] : 0;
          const sample = (1 - frac) * s0 + frac * s1;
          const clamped = Math.max(-1, Math.min(1, sample));
          reusablePcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        }

        const byteLength = outLength * 2;
        const b64Audio = uint8ToBase64(reusableUint8, byteLength);
        const payload = `{"realtimeInput":{"mediaChunks":[{"mimeType":"audio/pcm;rate=16000","data":"${b64Audio}"}]}}`;

        try {
          ws.send(payload);
        } catch (err) {}
      };

      audioSourceNode.connect(processorNode);

      // Muted GainNode passthrough keeps processorNode active without speaker pops
      mutedGainNode = audioCtx.createGain();
      mutedGainNode.gain.value = 0;
      processorNode.connect(mutedGainNode);
      mutedGainNode.connect(audioCtx.destination);
    } else {
      // Tab Audio Mode: Request background service worker to capture tab via Offscreen Document
      const tabRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'START_TAB_CAPTURE' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { success: false, error: '未收到响应' });
          }
        });
      });

      if (!tabRes || !tabRes.success) {
        throw new Error('标签页音频捕获失败: ' + (tabRes?.error || '未知错误'));
      }
    }

    if (sessionId !== activeSessionId || !isRunning) {
      cleanupAudioPipeline();
      return;
    }

    // Natural sentence boundary flush timer (1400ms)
    silenceFlushTimer = setInterval(() => {
      if (isRunning && Date.now() - lastAudioTime > 1400) {
        commitActiveSentence();
      }
    }, 300);
  }

  // 9. Smart WebSocket URL Builder (Decoupled: Supports Official Google API & Custom Proxies)
  function getWebSocketUrl() {
    let host = (config.apiHost || 'https://generativelanguage.googleapis.com').trim();
    
    // Normalize protocol
    if (host.startsWith('http://')) {
      host = 'ws://' + host.substring(7);
    } else if (host.startsWith('https://')) {
      host = 'wss://' + host.substring(8);
    } else if (!host.startsWith('ws://') && !host.startsWith('wss://')) {
      host = 'wss://' + host;
    }

    // Clean standard REST trailing paths
    host = host.replace(/\/v1beta\/models\/?$/, '')
               .replace(/\/v1beta\/?$/, '')
               .replace(/\/models\/?$/, '')
               .replace(/\/+$/, '');

    // Append Google BidiGenerateContent WebSocket service path if not already included
    if (!host.includes('/ws/google.ai.generativelanguage.')) {
      host += '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
    }

    // Append API Key query parameter if provided
    if (config.apiKey && config.apiKey.trim()) {
      const separator = host.includes('?') ? '&' : '?';
      host += `${separator}key=${encodeURIComponent(config.apiKey.trim())}`;
    }
    return host;
  }

  async function startSubtitleService(isManualStart = true) {
    if (isManualStart) {
      reconnectAttempts = 0;
      isManualDisconnect = false;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Teardown any dangling old session
    if (ws || processorNode || analyserNode) {
      stopSubtitleService(false);
    }

    const currentSession = ++activeSessionId;
    isRunning = true;
    isConnecting = true;

    btnToggle.classList.add('active');
    btnToggleIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
    statusText.textContent = '🔄 连接中...';
    statusText.style.color = '#38bdf8';

    try {
      const wsUrl = getWebSocketUrl();

      // Check if official Google API is selected without an API Key
      if (wsUrl.includes('generativelanguage.googleapis.com') && (!config.apiKey || !config.apiKey.trim())) {
        statusText.textContent = '❌ 请在设置中填写 Google API Key';
        statusText.style.color = '#ef4444';
        stopSubtitleService(true);
        return;
      }

      let currentWs;
      try {
        currentWs = new WebSocket(wsUrl);
        ws = currentWs;
      } catch (constructErr) {
        console.error('[Gemini Live] WebSocket creation failed:', sanitizeErrorMessage(constructErr));
        statusText.textContent = '❌ WebSocket 创建失败: ' + sanitizeErrorMessage(constructErr.message || constructErr);
        statusText.style.color = '#ef4444';
        stopSubtitleService(true);
        return;
      }

      currentWs.onopen = () => {
        if (currentSession !== activeSessionId) {
          try { currentWs.close(); } catch (e) {}
          return;
        }

        statusText.textContent = '初始化会话...';
        statusText.style.color = '#34d399';

        const pageCtx = getPageContext();
        domainText.textContent = pageCtx.domainLabel;
        activeDomain = pageCtx.domain;

        const dynamicPrompt = buildDynamicSystemPrompt(pageCtx);

        const setupPayload = {
          setup: {
            model: config.model,
            generationConfig: {
              responseModalities: ['TEXT'],
              temperature: 0.3
            },
            inputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: dynamicPrompt }]
            }
          }
        };

        currentWs.send(JSON.stringify(setupPayload));
      };

      currentWs.onmessage = async (e) => {
        if (currentSession !== activeSessionId) return;

        let text = '';
        if (typeof e.data === 'string') {
          text = e.data;
        } else if (e.data instanceof Blob) {
          text = await e.data.text();
        } else if (e.data instanceof ArrayBuffer) {
          text = new TextDecoder().decode(e.data);
        }

        try {
          const msg = JSON.parse(text);

          // 1. Server Error Payload Detection & Terminal Error Handling
          if (msg.error) {
            const errObj = msg.error;
            const errCode = errObj.code || 0;
            const errMsg = errObj.message || JSON.stringify(errObj);
            console.error('[Gemini Live Translator] Server returned error:', sanitizeErrorMessage(errMsg));

            if (isTerminalError(errCode, errMsg)) {
              statusText.textContent = '❌ API 错误: ' + sanitizeErrorMessage(errMsg);
              statusText.style.color = '#ef4444';
              stopSubtitleService(true);
              return;
            } else {
              statusText.textContent = '⚠️ API 异常: ' + sanitizeErrorMessage(errMsg);
              statusText.style.color = '#f59e0b';
            }
          }

          // 2. Setup Complete Handshake Acknowledgement
          if (msg.setupComplete !== undefined) {
            reconnectAttempts = 0; // Handshake successful, reset reconnect backoff count
            try {
              await initAudioCapture(currentSession);
              if (currentSession !== activeSessionId || !isRunning) return;
              isConnecting = false;
              statusText.textContent = '🎙️ 实时翻译中';
              statusText.style.color = '#34d399';
            } catch (audioErr) {
              console.error('[Gemini Live] Audio capture failed:', sanitizeErrorMessage(audioErr));
              statusText.textContent = '❌ 音频启动失败: ' + sanitizeErrorMessage(audioErr.message || audioErr);
              statusText.style.color = '#ef4444';
              stopSubtitleService(true);
              return;
            }
          }

          // 3. Multimodal Live Server Content & Signal Processing
          if (msg.serverContent) {
            const sc = msg.serverContent;

            // Signal A: Interruption Event (User interrupted or audio stream reset)
            if (sc.interrupted) {
              commitActiveSentence();
            }

            // Signal B: Original Input Audio Transcription
            if (sc.inputTranscription && sc.inputTranscription.text) {
              handleIncomingOriginalChunk(sc.inputTranscription.text);
            }

            // Signal C: Output Translation Stream (Real-time Streaming Text)
            if (sc.modelTurn && sc.modelTurn.parts) {
              for (const part of sc.modelTurn.parts) {
                if (part.text) {
                  handleIncomingTranslatedChunk(part.text);
                }
              }
            } else if (sc.outputTranscription && sc.outputTranscription.text) {
              handleIncomingTranslatedChunk(sc.outputTranscription.text);
            } else if (sc.outputAudioTranscription && sc.outputAudioTranscription.text) {
              handleIncomingTranslatedChunk(sc.outputAudioTranscription.text);
            }

            // Signal D: Sentence or Turn Completion Boundary
            if (sc.turnComplete || sc.generationComplete) {
              commitActiveSentence();
            }
          }
        } catch (err) {
          console.error('[Gemini Live Translator] Parse error:', sanitizeErrorMessage(err));
        }
      };

      sessionRotationTimer = setInterval(() => {
        if (isRunning && currentSession === activeSessionId && ws === currentWs && ws.readyState === WebSocket.OPEN) {
          console.log('[Gemini Live Translator] Periodic session refresh...');
          restartSession();
        }
      }, 10 * 60 * 1000);

      currentWs.onerror = (e) => {
        if (currentSession !== activeSessionId) return;
        statusText.textContent = '连接异常';
        statusText.style.color = '#ef4444';
      };

      currentWs.onclose = (e) => {
        if (currentSession !== activeSessionId) return; // Stale session closed, ignore
        if (sessionRotationTimer) {
          clearInterval(sessionRotationTimer);
          sessionRotationTimer = null;
        }

        if (isManualDisconnect) {
          return;
        }

        // Terminal error close check
        if (isTerminalError(e.code, e.reason)) {
          console.warn(`[Gemini Live] Terminal close code: ${e.code}, reason: ${sanitizeErrorMessage(e.reason || 'None')}`);
          statusText.textContent = '❌ 认证或权限异常，请检查 API Key';
          statusText.style.color = '#ef4444';
          stopSubtitleService(true);
          return;
        }

        if (isRunning) {
          if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.warn(`[Gemini Live] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Halting auto-reconnect.`);
            statusText.textContent = '❌ 连接重试超限，请检查网络或配置';
            statusText.style.color = '#ef4444';
            stopSubtitleService(true);
            return;
          }

          const delay = calculateBackoffDelay(reconnectAttempts);
          reconnectAttempts++;
          const currentAttempt = reconnectAttempts;
          console.log(`[Gemini Live Translator] Connection closed (code: ${e.code}). Reconnecting in ${delay}ms (attempt ${currentAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
          statusText.textContent = `🔄 连接断开，${Math.round(delay / 1000)}秒后重试 (${currentAttempt}/${MAX_RECONNECT_ATTEMPTS})...`;
          statusText.style.color = '#38bdf8';

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (isRunning && !isManualDisconnect && currentSession === activeSessionId) {
              startSubtitleService(false);
            }
          }, delay);
        } else {
          stopSubtitleService();
        }
      };
    } catch (err) {
      if (currentSession !== activeSessionId) return;
      console.error('[Gemini Live] Start error:', sanitizeErrorMessage(err));
      statusText.textContent = '启动失败: ' + sanitizeErrorMessage(err.message || err);
      statusText.style.color = '#ef4444';
      stopSubtitleService(true);
    }
  }

  function stopSubtitleService(isManual = false) {
    isRunning = false;
    isConnecting = false;
    activeSessionId++; // Invalidate any in-flight session or reconnect callbacks

    if (isManual) {
      isManualDisconnect = true;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    btnToggle.classList.remove('active');
    btnToggleIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
    if (isManual && !statusText.textContent.startsWith('❌')) {
      statusText.textContent = '已暂停';
      statusText.style.color = '#94a3b8';
    }

    if (sessionRotationTimer) {
      clearInterval(sessionRotationTimer);
      sessionRotationTimer = null;
    }

    // Call unified audio pipeline & hardware track cleanup
    cleanupAudioPipeline();

    if (ws) {
      const oldWs = ws;
      ws = null;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      oldWs.onclose = null;
      try { oldWs.close(); } catch (e) {}
    }
  }

  function restartSession() {
    stopSubtitleService(true);
    isManualDisconnect = false;
    reconnectAttempts = 0;
    statusText.textContent = '🔄 正在重启并重新连接...';
    statusText.style.color = '#38bdf8';
    btnToggle.classList.add('active');
    btnToggleIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
    setTimeout(() => {
      startSubtitleService(true);
    }, 150);
  }

  // Listen for messages from background / popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'PING') {
      sendResponse({ status: 'PONG' });
    } else if (msg.action === 'CHECK_OVERLAY_VISIBLE') {
      const isVisible = overlay && overlay.style.display !== 'none' && overlay.style.display !== '';
      sendResponse({ status: 'OK', isVisible: isVisible });
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
    } else if (msg.action === 'UPDATE_CONFIG') {
      const needsRestart = msg.config && (
        (msg.config.apiKey !== undefined && msg.config.apiKey !== config.apiKey) ||
        (msg.config.apiHost !== undefined && msg.config.apiHost !== config.apiHost) ||
        (msg.config.model !== undefined && msg.config.model !== config.model) ||
        (msg.config.sourceLang !== undefined && msg.config.sourceLang !== config.sourceLang) ||
        (msg.config.targetLang !== undefined && msg.config.targetLang !== config.targetLang) ||
        (msg.config.forcedDomain !== undefined && msg.config.forcedDomain !== config.forcedDomain) ||
        (msg.config.audioMode !== undefined && msg.config.audioMode !== config.audioMode)
      );

      config = { ...config, ...msg.config };
      applyInitialStyles();
      if (isRunning && needsRestart) {
        restartSession();
      }
      sendResponse({ status: 'OK' });
    }
  });
})();
