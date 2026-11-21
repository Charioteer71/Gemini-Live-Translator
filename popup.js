document.addEventListener('DOMContentLoaded', async () => {
  const OFFICIAL_HOST = 'https://generativelanguage.googleapis.com';
  const DEFAULT_MODEL = 'models/gemini-3.5-live-translate-preview';

  const POPUP_SVGS = {
    eye: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    eyeOff: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.4 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>',
    save: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>',
    check: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg>',
    checkCircle: '<svg class="ui-icon-xs" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.3 2.3 4.8-5"></path></svg>',
    warn: '<svg class="ui-icon-xs" viewBox="0 0 24 24"><path d="m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    warnBtn: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    error: '<svg class="ui-icon-xs" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6M9 9l6 6"></path></svg>',
    spinner: '<svg class="ui-icon-xs ui-icon-spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.55"></path></svg>',
    zap: '<svg class="ui-icon-xs" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
    info: '<svg class="ui-icon-xs" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    chevronDown: '<svg class="ui-icon ui-select-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"></polyline></svg>',
    checkOption: '<svg class="ui-icon ui-select-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg>'
  };

  function cleanInput(val) {
    return String(val || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  }

  function isPopupClosed() {
    return typeof window !== 'undefined' && Boolean(window.closed);
  }

  function isOfficialApiHost(hostRaw) {
    const h = cleanInput(hostRaw);
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

  function sanitizeErrorMessage(err) {
    if (err === null || err === undefined) return '';
    const msg = typeof err === 'string' ? err : (err.message || String(err));
    return msg
      .replace(/([?&]key=)[^&\s'"]+/gi, '$1***REDACTED***')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '***REDACTED***');
  }

  function isValidApiHost(hostRaw) {
    const h = cleanInput(hostRaw);
    if (!h) return false;
    const withoutProto = h.replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '').trim();
    return withoutProto.length > 0 && !/\s/.test(withoutProto);
  }

  function isInjectableTabUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (
      lower.startsWith('chrome://') ||
      lower.startsWith('edge://') ||
      lower.startsWith('about:') ||
      lower.startsWith('chrome-extension://') ||
      lower.startsWith('moz-extension://') ||
      lower.startsWith('devtools://') ||
      lower.startsWith('view-source:') ||
      lower.includes('chromewebstore.google.com') ||
      lower.includes('chrome.google.com/webstore') ||
      lower.includes('microsoftedge.microsoft.com/addons')
    ) {
      return false;
    }
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
      return false;
    }
    try {
      const parsed = new URL(url);
      if (parsed.pathname && /\.pdf$/i.test(parsed.pathname)) return false;
    } catch (e) {
      if (/\.pdf(?:[?#]|$)/i.test(lower)) return false;
    }
    return true;
  }

  function persistPopupConfigPatch(delta, deletions = ['forcedDomain']) {
    const safeDelta = (delta && typeof delta === 'object') ? delta : {};
    const safeDeletions = Array.isArray(deletions) ? deletions : [];

    const fallbackMergeWrite = () => new Promise((resolve) => {
      try {
        chrome.storage.local.get(['geminiLiveConfig'], (res) => {
          const merged = Object.assign({}, (res && res.geminiLiveConfig) || {}, safeDelta);
          for (let i = 0; i < safeDeletions.length; i++) {
            delete merged[safeDeletions[i]];
          }
          chrome.storage.local.set({ geminiLiveConfig: merged }, () => {
            resolve({ ok: true, config: merged });
          });
        });
      } catch (e) {
        resolve({ ok: false, config: Object.assign({}, safeDelta) });
      }
    });

    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          fallbackMergeWrite().then(resolve);
        }, 1200);
        const onResp = (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError || !resp || !resp.ok || !resp.config) {
            fallbackMergeWrite().then(resolve);
            return;
          }
          resolve(resp);
        };
        try {
          const maybePromise = chrome.runtime.sendMessage({ type: 'PATCH_CONFIG', delta: safeDelta, deletions: safeDeletions }, onResp);
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(onResp, () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              fallbackMergeWrite().then(resolve);
            });
          }
        } catch (e) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            fallbackMergeWrite().then(resolve);
          }
        }
      });
    }
    return fallbackMergeWrite();
  }

  async function ensureTabInjected(tabId) {
    if (!tabId) return false;
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      try {
        const res = await new Promise((resolve) => {
          let settled = false;
          const finish = (val) => {
            if (settled) return;
            settled = true;
            resolve(val);
          };
          try {
            const p = chrome.runtime.sendMessage({ action: 'ENSURE_INJECTED', tabId }, (r) => {
              if (chrome.runtime && chrome.runtime.lastError) finish(null);
              else finish(r || null);
            });
            if (p && typeof p.then === 'function') p.then(finish, () => finish(null));
          } catch (e) {
            finish(null);
          }
        });
        if (res && (res.ok || res.success)) return true;
      } catch (e) {}
    }
    if (typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
      try {
        try {
          await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['spa_hook.js'], world: 'MAIN' });
        } catch (spaErr) {}
        try {
          await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
        } catch (allErr) {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        }
        await new Promise((r) => setTimeout(r, 100));
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  const tabStatusBanner = document.getElementById('tabStatusBanner');
  const tabStatusIcon = document.getElementById('tabStatusIcon');
  const tabStatusText = document.getElementById('tabStatusText');

  function setTabStatusBanner(kind, iconKey, message) {
    if (!tabStatusBanner || !tabStatusText) return;
    if (!message) {
      tabStatusBanner.style.display = 'none';
      return;
    }
    tabStatusBanner.className = 'tab-status-banner ' + (kind || 'info');
    tabStatusBanner.style.display = 'flex';
    if (tabStatusIcon) tabStatusIcon.innerHTML = POPUP_SVGS[iconKey] || POPUP_SVGS.info;
    tabStatusText.textContent = sanitizeErrorMessage(message);
  }

  async function refreshActiveTabStatus(tabArg = null) {
    if (!tabStatusBanner || isPopupClosed()) return;
    if (isStandaloneOptionsTab) {
      setTabStatusBanner('info', 'info', '独立设置页模式：修改将在保存后自动同步至各网页标签页。');
      return;
    }
    let tab = tabArg;
    if (!tab && chrome.tabs && typeof chrome.tabs.query === 'function') {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (isPopupClosed()) return;
        tab = tabs && tabs[0];
      } catch (e) {
        return;
      }
    }
    if (!tab || !tab.id || !isInjectableTabUrl(tab.url)) {
      setTabStatusBanner('warn', 'warn', '当前页面为浏览器受限页面（如 chrome://、扩展商店或 PDF），不支持注入悬浮字幕，请切换至普通网页后使用。');
      return;
    }
    if (chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      let sendRes;
      let sendFailed = false;
      try {
        sendRes = chrome.tabs.sendMessage(tab.id, { action: 'GET_STATE' });
      } catch (sendErr) {
        sendFailed = true;
      }
      const st = sendFailed ? null : await Promise.resolve(sendRes).catch(() => null);
      if (isPopupClosed()) return;
      if (st && st.status === 'OK') {
        if (st.isContextValid === false) {
          setTabStatusBanner('warn', 'warn', '当前标签页扩展上下文已更新，请刷新该网页后继续使用。');
          return;
        }
        const modeLabel = st.audioMode === 'mic' ? '麦克风' : '网页音视频';
        const stateLabel = st.statusText || (st.isRunning ? '运行中' : (st.isPaused ? '已暂停' : '就绪'));
        const bannerKind = (st.statusKind === 'err' || st.statusKind === 'warn' || st.statusKind === 'ok') ? st.statusKind : 'info';
        const iconKey = bannerKind === 'ok' ? 'checkCircle' : (bannerKind === 'warn' ? 'warn' : (bannerKind === 'err' ? 'error' : 'info'));
        const mediaInfo = typeof st.mediaCount === 'number' ? ` · 媒体 ${st.mediaCount} 个` : '';
        setTabStatusBanner(bannerKind, iconKey, `当前页状态：${stateLabel}（音源：${modeLabel}${mediaInfo}）`);
      }
    }
  }

  // Update version badge dynamically
  const versionBadge = document.getElementById('versionBadge');
  if (versionBadge && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
    const ver = chrome.runtime.getManifest().version;
    if (ver) versionBadge.textContent = `Release v${ver}`;
  }

  // Read configuration once
  const cfg = await new Promise((resolve) => {
    chrome.storage.local.get(['geminiLiveConfig'], (res) => {
      resolve((res && res.geminiLiveConfig) ? Object.assign({}, res.geminiLiveConfig) : {});
    });
  });
  if (isPopupClosed()) return;

  const initialHost = cleanInput(cfg.apiHost || OFFICIAL_HOST);
  const initialKey = cleanInput(cfg.apiKey);
  const initialOfficial = !initialHost || isOfficialApiHost(initialHost);
  const isReady = initialOfficial ? initialKey.length > 0 : isValidApiHost(initialHost);

  // Deterministic check: in Chrome action popup, chrome.tabs.getCurrent() returns undefined; in an options tab, it returns the Tab object
  const ownTab = await new Promise((resolve) => {
    try {
      if (chrome.tabs && typeof chrome.tabs.getCurrent === 'function') {
        chrome.tabs.getCurrent((t) => resolve(t || null));
      } else {
        resolve(null);
      }
    } catch (e) {
      resolve(null);
    }
  });
  if (isPopupClosed()) return;
  const isStandaloneOptionsTab = !!ownTab;

  let startupTab = null;
  if (!isStandaloneOptionsTab) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (isPopupClosed()) return;
      startupTab = tab || null;
      if (isReady && tab && tab.id && isInjectableTabUrl(tab.url)) {
        let isVisible = false;
        let scriptReachable = false;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { action: 'CHECK_OVERLAY_VISIBLE' });
          if (res && res.status === 'OK') {
            scriptReachable = true;
            isVisible = !!res.isVisible;
          }
        } catch (err) {
          try {
            const injected = await ensureTabInjected(tab.id);
            if (isPopupClosed()) return;
            if (injected) {
              const res2 = await chrome.tabs.sendMessage(tab.id, { action: 'CHECK_OVERLAY_VISIBLE' });
              if (res2 && res2.status === 'OK') {
                scriptReachable = true;
                isVisible = !!res2.isVisible;
              }
            }
          } catch (e) {}
        }
        if (isPopupClosed()) return;

        if (scriptReachable && !isVisible) {
          try {
            const showRes = await chrome.tabs.sendMessage(tab.id, { action: 'SHOW_OVERLAY' });
            if (showRes && showRes.status === 'OK') {
              window.close();
              return;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  if (isPopupClosed()) return;
  refreshActiveTabStatus(startupTab);

  const btnPresetOfficial = document.getElementById('btnPresetOfficial');
  const btnPresetCustom = document.getElementById('btnPresetCustom');
  const hostTypeBadge = document.getElementById('hostTypeBadge');
  const hostHint = document.getElementById('hostHint');

  const apiHost = document.getElementById('apiHost');
  const apiKey = document.getElementById('apiKey');
  const btnTogglePwd = document.getElementById('btnTogglePwd');
  const modelSelect = document.getElementById('modelSelect');
  const customModelInput = document.getElementById('customModelInput');
  const sourceLang = document.getElementById('sourceLang');
  const targetLang = document.getElementById('targetLang');
  const fontSize = document.getElementById('fontSize');
  const fontSizeVal = document.getElementById('fontSizeVal');
  const opacity = document.getElementById('opacity');
  const opacityVal = document.getElementById('opacityVal');
  const blur = document.getElementById('blur');
  const blurVal = document.getElementById('blurVal');
  const btnSave = document.getElementById('btnSave');

  let savedCustomHost = '';
  const popupDropdowns = [];

  function closeAllPopupDropdowns(exceptDropdown = null, restoreFocus = false) {
    for (let i = 0; i < popupDropdowns.length; i++) {
      const dd = popupDropdowns[i];
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

  function enhancePopupSelect(selectEl, opts = {}) {
    if (!selectEl || !selectEl.parentNode) return null;
    const baseId = selectEl.id || ('uiSelect_' + popupDropdowns.length);
    const dropdown = document.createElement('div');
    dropdown.className = 'ui-dropdown' + (opts.dropUp ? ' drop-up' : '');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ui-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const menuEl = document.createElement('div');
    menuEl.className = 'ui-select-menu';
    menuEl.id = baseId + '-listbox';
    menuEl.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', menuEl.id);

    const assocLabel = (selectEl.id && typeof document.querySelector === 'function')
      ? document.querySelector(`label[for="${selectEl.id}"]`)
      : null;
    if (assocLabel) {
      if (!assocLabel.id) assocLabel.id = 'label_' + baseId;
      trigger.setAttribute('aria-labelledby', assocLabel.id);
      menuEl.setAttribute('aria-labelledby', assocLabel.id);
      assocLabel.addEventListener('click', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof trigger.focus === 'function') trigger.focus();
      });
    } else {
      const fallbackLabel = (selectEl.getAttribute && selectEl.getAttribute('aria-label')) || selectEl.title || baseId;
      trigger.setAttribute('aria-label', fallbackLabel);
      menuEl.setAttribute('aria-label', fallbackLabel);
    }

    const labelSpan = document.createElement('span');
    labelSpan.className = 'ui-select-label';
    trigger.appendChild(labelSpan);

    const chevronWrap = document.createElement('span');
    chevronWrap.innerHTML = POPUP_SVGS.chevronDown;
    if (chevronWrap.firstChild) trigger.appendChild(chevronWrap.firstChild);

    dropdown.appendChild(trigger);
    dropdown.appendChild(menuEl);
    dropdown._trigger = trigger;

    selectEl.classList.add('ui-native-hidden');
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
          if (typeof btn.scrollIntoView === 'function') {
            try { btn.scrollIntoView({ block: 'nearest' }); } catch (e) {}
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
          if (txtSpan && txtSpan.textContent !== optText) txtSpan.textContent = optText;
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
          itemBtn.className = 'ui-select-option' + (isSelected ? ' selected' : '');
          itemBtn.setAttribute('role', 'option');
          itemBtn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
          itemBtn.dataset.value = opt.value;

          const txtSpan = document.createElement('span');
          txtSpan.textContent = optText;
          itemBtn.appendChild(txtSpan);

          const chkWrap = document.createElement('span');
          chkWrap.innerHTML = POPUP_SVGS.checkOption;
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

    const openMenu = (initialIdx = null, shouldFocusOption = true) => {
      closeAllPopupDropdowns(dropdown, false);
      syncUI();
      dropdown.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      const options = Array.from(selectEl.options || []);
      const selIdx = options.findIndex((o) => o.value === selectEl.value);
      const startIdx = initialIdx !== null ? initialIdx : (selIdx >= 0 ? selIdx : 0);
      setActiveIndex(startIdx, shouldFocusOption);
    };

    const closeMenu = (restoreFocus = false) => {
      const wasOpen = dropdown.classList.contains('open');
      dropdown.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      for (let i = 0; i < optionButtons.length; i++) {
        optionButtons[i].classList.remove('active');
      }
      if (typeof menuEl.removeAttribute === 'function') {
        menuEl.removeAttribute('aria-activedescendant');
      }
      if (restoreFocus && wasOpen && typeof trigger.focus === 'function') {
        trigger.focus();
      }
    };

    dropdown._close = closeMenu;

    trigger.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      const willOpen = !dropdown.classList.contains('open');
      if (willOpen) {
        openMenu(null, false);
      } else {
        closeMenu(false);
      }
    });

    dropdown.addEventListener('keydown', (e) => {
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
        closeMenu(false);
      }
    });

    selectEl._syncUI = syncUI;
    popupDropdowns.push(dropdown);
    syncUI();
    return dropdown;
  }

  function syncPopupSelects() {
    if (modelSelect && typeof modelSelect._syncUI === 'function') modelSelect._syncUI();
    if (sourceLang && typeof sourceLang._syncUI === 'function') sourceLang._syncUI();
    if (targetLang && typeof targetLang._syncUI === 'function') targetLang._syncUI();
  }

  enhancePopupSelect(modelSelect);
  enhancePopupSelect(sourceLang, { dropUp: true });
  enhancePopupSelect(targetLang, { dropUp: true });

  document.addEventListener('pointerdown', (e) => {
    if (!e || !e.target || !e.target.closest || !e.target.closest('.ui-dropdown')) {
      closeAllPopupDropdowns();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e && e.key === 'Escape') {
      closeAllPopupDropdowns(null, true);
    }
  });

  function renderButtonWithIcon(btn, iconSvg, labelText) {
    btn.innerHTML = iconSvg;
    const span = document.createElement('span');
    span.textContent = labelText;
    btn.appendChild(span);
  }

  function updateHostState() {
    const raw = cleanInput(apiHost.value);
    if (isOfficialApiHost(raw)) {
      btnPresetOfficial.classList.add('active');
      btnPresetCustom.classList.remove('active');
      hostTypeBadge.textContent = 'Google 官方';
      hostTypeBadge.className = 'host-type-badge';
      hostHint.textContent = '官方 WebSocket: wss://generativelanguage.googleapis.com';
    } else {
      btnPresetOfficial.classList.remove('active');
      btnPresetCustom.classList.add('active');
      hostTypeBadge.textContent = '自定义代理';
      hostTypeBadge.className = 'host-type-badge custom';
      hostHint.textContent = '将自动连接到此代理的 Bidi WebSocket 服务';
      if (isValidApiHost(raw)) {
        savedCustomHost = raw;
      }
    }
  }

  function invalidateStaleTestResult() {
    const tr = document.getElementById('testResult');
    if (!tr || (btnTestConn && btnTestConn.disabled)) return;
    const defaultHint = '点击后向当前节点发起一次 WebSocket 握手自检。';
    if (tr.textContent && tr.textContent.trim() !== defaultHint) {
      tr.style.color = '';
      tr.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = '配置已修改，请重新点击「测试节点连接」以验证链路。';
      tr.appendChild(span);
    }
  }

  btnPresetOfficial.addEventListener('click', () => {
    const current = cleanInput(apiHost.value);
    if (isValidApiHost(current) && !isOfficialApiHost(current)) {
      savedCustomHost = current;
    }
    apiHost.value = OFFICIAL_HOST;
    updateHostState();
    invalidateStaleTestResult();
  });

  btnPresetCustom.addEventListener('click', () => {
    if (savedCustomHost) {
      apiHost.value = savedCustomHost;
    } else if (cleanInput(apiHost.value) === OFFICIAL_HOST || !cleanInput(apiHost.value)) {
      apiHost.value = 'https://';
    }
    btnPresetCustom.classList.add('active');
    btnPresetOfficial.classList.remove('active');
    hostTypeBadge.textContent = '自定义代理';
    hostTypeBadge.className = 'host-type-badge custom';
    hostHint.textContent = '请输入代理节点域名（例如 https://your-gateway.example.com）';
    invalidateStaleTestResult();
    apiHost.focus();
    if (apiHost.setSelectionRange) {
      apiHost.setSelectionRange(apiHost.value.length, apiHost.value.length);
    }
  });

  apiHost.addEventListener('input', () => {
    updateHostState();
    invalidateStaleTestResult();
  });

  apiKey.addEventListener('input', invalidateStaleTestResult);
  if (customModelInput) customModelInput.addEventListener('input', invalidateStaleTestResult);

  // Toggle Password Visibility with Vector Eye / EyeOff SVG
  btnTogglePwd.addEventListener('click', () => {
    if (apiKey.type === 'password') {
      apiKey.type = 'text';
      btnTogglePwd.innerHTML = POPUP_SVGS.eyeOff;
      if (typeof btnTogglePwd.setAttribute === 'function') {
        btnTogglePwd.setAttribute('aria-pressed', 'true');
        btnTogglePwd.setAttribute('aria-label', '隐藏 API Key');
      }
    } else {
      apiKey.type = 'password';
      btnTogglePwd.innerHTML = POPUP_SVGS.eye;
      if (typeof btnTogglePwd.setAttribute === 'function') {
        btnTogglePwd.setAttribute('aria-pressed', 'false');
        btnTogglePwd.setAttribute('aria-label', '显示 API Key');
      }
    }
  });

  // Custom Model Handling
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value === 'custom') {
      customModelInput.style.display = 'block';
      if (typeof customModelInput.focus === 'function') customModelInput.focus();
    } else {
      customModelInput.style.display = 'none';
    }
    invalidateStaleTestResult();
  });

  function applyStoredConfigToUI(nextCfg, options = {}) {
    if (!nextCfg || typeof nextCfg !== 'object') return;
    const skipActive = !!options.skipActiveInputs;
    const activeEl = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;

    if (nextCfg.apiHost !== undefined && (!skipActive || activeEl !== apiHost)) {
      const cleanedHost = cleanInput(nextCfg.apiHost);
      apiHost.value = cleanedHost || OFFICIAL_HOST;
      if (isValidApiHost(cleanedHost) && !isOfficialApiHost(cleanedHost)) {
        savedCustomHost = cleanedHost;
      }
    }
    if (nextCfg.apiKey !== undefined && (!skipActive || activeEl !== apiKey)) {
      apiKey.value = cleanInput(nextCfg.apiKey);
    }

    if (nextCfg.model) {
      let modelVal = nextCfg.model;
      if (/gemini-3\.1/i.test(modelVal) || /gemini-2\./i.test(modelVal) || /gemini-1\./i.test(modelVal)) {
        modelVal = DEFAULT_MODEL;
        if (!skipActive) {
          persistPopupConfigPatch({ model: DEFAULT_MODEL }, ['forcedDomain']).catch(() => {});
        }
      }
      const optionExists = Array.from(modelSelect.options).some((o) => o.value === modelVal);
      if (!(skipActive && activeEl === customModelInput)) {
        if (optionExists) {
          modelSelect.value = modelVal;
          customModelInput.style.display = 'none';
        } else {
          modelSelect.value = 'custom';
          customModelInput.value = modelVal;
          customModelInput.style.display = 'block';
        }
      }
    }

    if (nextCfg.sourceLang) {
      const srcMatch = Array.from(sourceLang.options).some((o) => o.value === nextCfg.sourceLang);
      if (srcMatch) sourceLang.value = nextCfg.sourceLang;
    }
    if (nextCfg.targetLang) {
      const tgtMatch = Array.from(targetLang.options).some((o) => o.value === nextCfg.targetLang);
      if (tgtMatch) targetLang.value = nextCfg.targetLang;
    }

    if (Number.isFinite(Number(nextCfg.fontSize))) {
      const fsVal = Math.min(30, Math.max(12, Math.round(Number(nextCfg.fontSize))));
      fontSize.value = fsVal;
      fontSizeVal.textContent = fsVal;
    }
    if (nextCfg.opacity !== undefined && Number.isFinite(Number(nextCfg.opacity))) {
      const opPct = Math.min(100, Math.max(10, Math.round(Number(nextCfg.opacity) * 100)));
      opacity.value = opPct;
      opacityVal.textContent = opPct;
    }
    if (nextCfg.blur !== undefined && Number.isFinite(Number(nextCfg.blur))) {
      const blVal = Math.min(20, Math.max(0, Math.round(Number(nextCfg.blur))));
      blur.value = blVal;
      blurVal.textContent = blVal;
    }
    syncPopupSelects();
    updateHostState();
  }

  // Populate UI from loaded configuration
  applyStoredConfigToUI(cfg, { skipActiveInputs: false });

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (isPopupClosed()) return;
        if (area !== 'local' || !changes || !changes.geminiLiveConfig || !changes.geminiLiveConfig.newValue) return;
        applyStoredConfigToUI(changes.geminiLiveConfig.newValue, { skipActiveInputs: true });
      });
    }
  } catch (e) {}

  // Live Sliders preview text and debounced tab + storage sync
  let popupDebounceTimer = null;
  let pendingSliderPatch = {};
  function notifyActiveTabDebounced(partialConfig) {
    if (isPopupClosed()) return;
    if (partialConfig && typeof partialConfig === 'object') {
      Object.assign(pendingSliderPatch, partialConfig);
    }
    if (popupDebounceTimer) clearTimeout(popupDebounceTimer);
    popupDebounceTimer = setTimeout(() => {
      popupDebounceTimer = null;
      if (isPopupClosed()) {
        pendingSliderPatch = {};
        return;
      }
      const mergedPatch = Object.assign({}, pendingSliderPatch);
      pendingSliderPatch = {};
      if (Object.keys(mergedPatch).length === 0) return;
      persistPopupConfigPatch(mergedPatch, []).catch(() => {});
      if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.query === 'function') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (isPopupClosed()) return;
          if (tabs && tabs[0] && tabs[0].id && isInjectableTabUrl(tabs[0].url)) {
            if (typeof chrome.tabs.sendMessage === 'function') {
              let sendRes;
              let sendFailed = false;
              try {
                sendRes = chrome.tabs.sendMessage(tabs[0].id, {
                  action: 'UPDATE_CONFIG',
                  config: mergedPatch
                });
              } catch (e) {
                sendFailed = true;
              }
              if (!sendFailed) {
                Promise.resolve(sendRes).catch(() => {});
              }
            }
          }
        });
      }
    }, 250);
  }

  fontSize.addEventListener('input', () => {
    fontSizeVal.textContent = fontSize.value;
    notifyActiveTabDebounced({ fontSize: parseInt(fontSize.value, 10) });
  });

  opacity.addEventListener('input', () => {
    opacityVal.textContent = opacity.value;
    notifyActiveTabDebounced({ opacity: parseInt(opacity.value, 10) / 100 });
  });

  blur.addEventListener('input', () => {
    blurVal.textContent = blur.value;
    notifyActiveTabDebounced({ blur: parseInt(blur.value, 10) });
  });

  let saveBtnResetTimer = null;
  function flashSaveButton(iconKey, text, state) {
    if (isPopupClosed()) return;
    if (saveBtnResetTimer) clearTimeout(saveBtnResetTimer);
    renderButtonWithIcon(btnSave, POPUP_SVGS[iconKey] || POPUP_SVGS.save, text);
    btnSave.classList.toggle('error', state === 'error');
    btnSave.classList.toggle('success', state === 'success');
    saveBtnResetTimer = setTimeout(() => {
      saveBtnResetTimer = null;
      if (isPopupClosed()) return;
      renderButtonWithIcon(btnSave, POPUP_SVGS.save, '保存并应用设置');
      btnSave.classList.remove('error', 'success');
    }, 1800);
  }

  // Save and notify active tab
  btnSave.addEventListener('click', () => {
    const rawHost = cleanInput(apiHost.value) || OFFICIAL_HOST;
    const rawKey = cleanInput(apiKey.value);
    const isOfficial = isOfficialApiHost(rawHost);

    if (!isOfficial && !isValidApiHost(rawHost)) {
      flashSaveButton('warnBtn', '请填写完整的自定义代理域名', 'error');
      apiHost.focus();
      return;
    }
    if (isOfficial && !rawKey) {
      flashSaveButton('warnBtn', '直连官方 API 请填写 API Key', 'error');
      apiKey.focus();
      return;
    }

    let chosenModel = modelSelect.value;
    if (chosenModel === 'custom') {
      const customVal = cleanInput(customModelInput.value);
      if (!customVal) {
        flashSaveButton('warnBtn', '请填写自定义模型名称', 'error');
        if (typeof customModelInput.focus === 'function') customModelInput.focus();
        return;
      }
      chosenModel = customVal;
    }

    if (popupDebounceTimer) {
      clearTimeout(popupDebounceTimer);
      popupDebounceTimer = null;
    }
    pendingSliderPatch = {};

    const newConfig = {
      apiHost: rawHost,
      apiKey: rawKey,
      model: chosenModel,
      sourceLang: sourceLang.value,
      targetLang: targetLang.value,
      fontSize: parseInt(fontSize.value, 10),
      opacity: parseInt(opacity.value, 10) / 100,
      blur: parseInt(blur.value, 10)
    };

    persistPopupConfigPatch(newConfig, ['forcedDomain']).then((patchRes) => {
      if (isPopupClosed()) return;
      const merged = (patchRes && patchRes.config) ? patchRes.config : newConfig;
      if (isStandaloneOptionsTab) {
        flashSaveButton('check', '保存成功', 'success');
        return;
      }

      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (isPopupClosed()) return;
        const tab = tabs && tabs[0];
        if (!tab || !tab.id || !isInjectableTabUrl(tab.url)) {
          flashSaveButton('warnBtn', '已保存（当前受限页面不支持悬浮窗）', 'success');
          setTabStatusBanner('warn', 'warn', '配置已保存；当前页面为受限页面（如 chrome://、扩展商店或 PDF），请切换至普通网页使用。');
          return;
        }

        let delivered = false;
        try {
          const showRes = await chrome.tabs.sendMessage(tab.id, { action: 'SHOW_OVERLAY', config: merged });
          delivered = !!(showRes && showRes.status === 'OK');
        } catch (e) {
          try {
            const injected = await ensureTabInjected(tab.id);
            if (isPopupClosed()) return;
            if (injected) {
              const showRes2 = await chrome.tabs.sendMessage(tab.id, { action: 'SHOW_OVERLAY', config: merged });
              delivered = !!(showRes2 && showRes2.status === 'OK');
            }
          } catch (err) {}
        }
        if (isPopupClosed()) return;

        if (delivered) {
          flashSaveButton('check', '保存成功', 'success');
          refreshActiveTabStatus(tab);
        } else {
          flashSaveButton('warnBtn', '已保存（当前页面不支持注入悬浮窗）', 'success');
          setTabStatusBanner('warn', 'warn', '配置已保存，但当前页面限制脚本注入，请切换至普通网页或刷新后再试。');
        }
      });
    });
  });

  // ======================================================================
  // 节点连接自检（WebSocket 握手 -> setupComplete 往返耗时）
  // ======================================================================

  const btnTestConn = document.getElementById('btnTestConn');
  const testResult = document.getElementById('testResult');
  const utf8Decoder = new TextDecoder('utf-8');

  const TEST_COLORS = {
    info: '#38bdf8',
    ok: '#34d399',
    warn: '#f59e0b',
    err: '#ef4444'
  };

  function setTestResult(kind, iconKey, message) {
    testResult.style.color = TEST_COLORS[kind] || '#64748b';
    testResult.innerHTML = POPUP_SVGS[iconKey] || '';
    const span = document.createElement('span');
    span.textContent = sanitizeErrorMessage(message);
    testResult.appendChild(span);
  }

  function mapTargetLanguageCode(value) {
    const t = String(value || '').toLowerCase();
    if (t.includes('繁體') || t.includes('繁体') || t.includes('traditional') || t.includes('zh-hant')) return 'zh-Hant';
    if (t.includes('中文') || t.includes('chinese') || t.includes('zh')) return 'zh-Hans';
    if (t.includes('英语') || t.includes('english')) return 'en';
    if (t.includes('日语') || t.includes('japanese')) return 'ja';
    if (t.includes('韩语') || t.includes('korean')) return 'ko';
    if (t.includes('法语') || t.includes('french')) return 'fr';
    if (t.includes('德语') || t.includes('german')) return 'de';
    if (t.includes('西班牙') || t.includes('spanish')) return 'es';
    if (t.includes('俄语') || t.includes('russian')) return 'ru';
    return 'zh-Hans';
  }

  function buildTestWsUrl(hostRaw, keyRaw) {
    let host = cleanInput(hostRaw) || OFFICIAL_HOST;
    const key = cleanInput(keyRaw);
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
    if (key && !/[?&]key=/.test(host)) {
      host += (host.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    }
    return host;
  }

  function getSelectedModel() {
    let chosen = modelSelect.value;
    if (chosen === 'custom') chosen = cleanInput(customModelInput.value) || DEFAULT_MODEL;
    return chosen.replace(/^models\//i, '');
  }

  let testSocket = null;
  let testConnTimer = null;

  function cleanupTestSocket() {
    if (testConnTimer) {
      clearTimeout(testConnTimer);
      testConnTimer = null;
    }
    if (testSocket) {
      try {
        testSocket.onopen = null;
        testSocket.onmessage = null;
        testSocket.onerror = null;
        testSocket.onclose = null;
        testSocket.close(1000, 'popup-close');
      } catch (e) {}
      testSocket = null;
    }
  }

  function handlePopupPageHide() {
    if (popupDebounceTimer) {
      clearTimeout(popupDebounceTimer);
      popupDebounceTimer = null;
    }
    pendingSliderPatch = {};
    if (saveBtnResetTimer) {
      clearTimeout(saveBtnResetTimer);
      saveBtnResetTimer = null;
    }
    cleanupTestSocket();
  }

  window.addEventListener('pagehide', handlePopupPageHide);

  function runConnectionTest() {
    if (isPopupClosed()) return;
    if (modelSelect.value === 'custom' && !cleanInput(customModelInput.value)) {
      setTestResult('warn', 'warn', '请先填写自定义模型名称。');
      if (typeof customModelInput.focus === 'function') customModelInput.focus();
      return;
    }
    const host = cleanInput(apiHost.value) || OFFICIAL_HOST;
    const key = cleanInput(apiKey.value);
    const model = getSelectedModel();
    const isOfficial = isOfficialApiHost(host);

    if (!isOfficial && !isValidApiHost(host)) {
      setTestResult('warn', 'warn', '请先填写完整的自定义代理节点域名。');
      return;
    }

    if (isOfficial && !key) {
      setTestResult('warn', 'warn', '直连 Google 官方 API 需要先填写 API Key。');
      return;
    }

    cleanupTestSocket();

    setTestResult('info', 'spinner', '正在连接' + (isOfficial ? ' Google 官方节点' : '自定义节点') + '…');
    btnTestConn.disabled = true;

    const t0 = performance.now();
    let settled = false;
    let ws = null;

    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      if (testConnTimer) {
        clearTimeout(testConnTimer);
        testConnTimer = null;
      }
      if ((ws && testSocket !== ws) || isPopupClosed()) {
        if (ws && testSocket === ws) cleanupTestSocket();
        return;
      }
      btnTestConn.disabled = false;
      setTestResult(ok ? 'ok' : 'err', ok ? 'checkCircle' : 'error', message);
      cleanupTestSocket();
    };

    try {
      ws = new WebSocket(buildTestWsUrl(host, key));
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      finish(false, '地址无效: ' + sanitizeErrorMessage(e));
      return;
    }
    testSocket = ws;
    testConnTimer = setTimeout(() => {
      if (testSocket !== ws || isPopupClosed()) return;
      finish(false, '35s 内未收到 setupComplete（网关握手超时/节点不可达）');
    }, 35000);

    ws.onopen = () => {
      if (testSocket !== ws || isPopupClosed() || settled) return;
      setTestResult('info', 'zap', 'WebSocket 已连接，正在发送 setup 帧…');
      const isTranslate = /live-translate/i.test(model);
      let setup;
      if (isTranslate) {
        setup = {
          setup: {
            model: 'models/' + model,
            generationConfig: {
              responseModalities: ['AUDIO'],
              translationConfig: {
                targetLanguageCode: mapTargetLanguageCode(targetLang.value),
                echoTargetLanguage: true
              }
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} }
          }
        };
      } else {
        setup = {
          setup: {
            model: 'models/' + model,
            generationConfig: { responseModalities: ['AUDIO'], temperature: 0.3 },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
            systemInstruction: { parts: [{ text: 'You are a real-time interpreter. Translate all incoming audio into ' + mapTargetLanguageCode(targetLang.value) + '.' }] }
          }
        };
      }
      try {
        ws.send(JSON.stringify(setup));
      } catch (e) {
        finish(false, '发送 setup 失败: ' + sanitizeErrorMessage(e));
      }
    };

    const handleMsgText = (rawText) => {
      if (!rawText || testSocket !== ws || isPopupClosed() || settled) return;
      let msg;
      try { msg = JSON.parse(rawText); } catch (e) { return; }
      if (msg.setupComplete !== undefined) {
        const ms = Math.round(performance.now() - t0);
        finish(true, `握手成功！setupComplete 往返 ${ms} ms（模型 ${model}）`);
      } else if (msg.error) {
        finish(false, '服务端拒绝: ' + sanitizeErrorMessage(msg.error.message || JSON.stringify(msg.error)).slice(0, 160));
      }
    };

    ws.onmessage = (ev) => {
      if (testSocket !== ws || isPopupClosed() || settled) return;
      if (typeof ev.data === 'string') {
        handleMsgText(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        try { handleMsgText(utf8Decoder.decode(ev.data)); } catch (e) {}
      } else if (ev.data && typeof ev.data.text === 'function') {
        ev.data.text().then(handleMsgText).catch(() => {});
      }
    };

    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (testSocket !== ws || isPopupClosed() || settled) return;
      if (!settled) finish(false, `连接被关闭 (code ${ev.code}${ev.reason ? '，' + sanitizeErrorMessage(ev.reason) : ''})`);
    };
  }

  if (btnTestConn) btnTestConn.addEventListener('click', runConnectionTest);
});
