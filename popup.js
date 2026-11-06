document.addEventListener('DOMContentLoaded', async () => {
  // Check configuration readiness and active tab overlay status
  const cfg = await new Promise((resolve) => {
    chrome.storage.local.get(['geminiLiveConfig'], (res) => {
      resolve(res.geminiLiveConfig || {});
    });
  });

  const host = (cfg.apiHost || 'https://generativelanguage.googleapis.com').trim();
  const key = (cfg.apiKey || '').trim();
  const isOfficial = !host || host.includes('generativelanguage.googleapis.com');
  const isReady = isOfficial ? key.length > 0 : host.length > 0;

  if (isReady) {
    // Configured: Check if in-page subtitle overlay is currently visible on the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && !tab.url?.startsWith('chrome://') && !tab.url?.startsWith('edge://')) {
      let isVisible = false;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'CHECK_OVERLAY_VISIBLE' });
        isVisible = res && res.isVisible;
      } catch (err) {
        // Not injected: inject scripts
        try {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 100));
          const res2 = await chrome.tabs.sendMessage(tab.id, { action: 'CHECK_OVERLAY_VISIBLE' });
          isVisible = res2 && res2.isVisible;
        } catch (e) {}
      }

      if (!isVisible) {
        // First click on this tab: Just pop up the in-page subtitle window and close popup immediately!
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'SHOW_OVERLAY' });
        } catch (e) {}
        window.close();
        return;
      }
      // If isVisible is true: Overlay is already open on page, so we keep popup OPEN as settings page!
    }
  }

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

  const OFFICIAL_HOST = 'https://generativelanguage.googleapis.com';
  let savedCustomHost = '';

  function updateHostState() {
    const val = apiHost.value.trim().toLowerCase();
    if (val.includes('generativelanguage.googleapis.com')) {
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
      if (apiHost.value.trim()) {
        savedCustomHost = apiHost.value.trim();
      }
    }
  }

  btnPresetOfficial.addEventListener('click', () => {
    const current = apiHost.value.trim();
    if (current && !current.toLowerCase().includes('generativelanguage.googleapis.com')) {
      savedCustomHost = current;
    }
    apiHost.value = OFFICIAL_HOST;
    updateHostState();
  });

  btnPresetCustom.addEventListener('click', () => {
    if (savedCustomHost) {
      apiHost.value = savedCustomHost;
    } else if (apiHost.value === OFFICIAL_HOST || !apiHost.value.trim()) {
      apiHost.value = 'https://';
    }
    btnPresetCustom.classList.add('active');
    btnPresetOfficial.classList.remove('active');
    hostTypeBadge.textContent = '自定义代理';
    hostTypeBadge.className = 'host-type-badge custom';
    hostHint.textContent = '将自动连接到此代理的 Bidi WebSocket 服务';
    apiHost.focus();
    if (apiHost.setSelectionRange) {
      apiHost.setSelectionRange(apiHost.value.length, apiHost.value.length);
    }
  });

  apiHost.addEventListener('input', updateHostState);

  // Toggle Password Visibility
  btnTogglePwd.addEventListener('click', () => {
    if (apiKey.type === 'password') {
      apiKey.type = 'text';
      btnTogglePwd.textContent = '🙈';
    } else {
      apiKey.type = 'password';
      btnTogglePwd.textContent = '👁️';
    }
  });

  // Custom Model Handling
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value === 'custom') {
      customModelInput.style.display = 'block';
      customModelInput.focus();
    } else {
      customModelInput.style.display = 'none';
    }
  });

  // Load saved configuration
  chrome.storage.local.get(['geminiLiveConfig'], (res) => {
    if (res.geminiLiveConfig) {
      const cfg = res.geminiLiveConfig;
      if (cfg.apiHost !== undefined) {
        apiHost.value = cfg.apiHost;
        const h = cfg.apiHost.trim();
        if (h && !h.toLowerCase().includes('generativelanguage.googleapis.com')) {
          savedCustomHost = h;
        }
      }
      if (cfg.apiKey !== undefined) apiKey.value = cfg.apiKey;

      if (cfg.model) {
        if (/gemini-3\.1/i.test(cfg.model) || /gemini-2/i.test(cfg.model)) {
          cfg.model = 'models/gemini-3.5-live-translate-preview';
          try { chrome.storage.sync.set({ geminiLiveConfig: cfg }); } catch (e) {}
        }
        const optionExists = Array.from(modelSelect.options).some(o => o.value === cfg.model);
        if (optionExists) {
          modelSelect.value = cfg.model;
          customModelInput.style.display = 'none';
        } else {
          modelSelect.value = 'custom';
          customModelInput.value = cfg.model;
          customModelInput.style.display = 'block';
        }
      }

      if (cfg.sourceLang) sourceLang.value = cfg.sourceLang;
      if (cfg.targetLang) targetLang.value = cfg.targetLang;

      if (cfg.fontSize) {
        fontSize.value = cfg.fontSize;
        fontSizeVal.textContent = cfg.fontSize;
      }
      if (cfg.opacity !== undefined) {
        opacity.value = Math.round(cfg.opacity * 100);
        opacityVal.textContent = Math.round(cfg.opacity * 100);
      }
      if (cfg.blur !== undefined) {
        blur.value = cfg.blur;
        blurVal.textContent = cfg.blur;
      }
    }
    updateHostState();
  });

  // Live Sliders preview text and debounced tab sync
  let popupDebounceTimer = null;
  function notifyActiveTabDebounced(partialConfig) {
    if (popupDebounceTimer) clearTimeout(popupDebounceTimer);
    popupDebounceTimer = setTimeout(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'UPDATE_CONFIG',
            config: partialConfig
          }).catch(() => {});
        }
      });
      popupDebounceTimer = null;
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

  // Save and notify active tab
  btnSave.addEventListener('click', () => {
    let chosenModel = modelSelect.value;
    if (chosenModel === 'custom') {
      chosenModel = customModelInput.value.trim() || 'models/gemini-3.5-live-translate-preview';
    }

    const newConfig = {
      apiHost: apiHost.value.trim() || OFFICIAL_HOST,
      apiKey: apiKey.value.trim(),
      model: chosenModel,
      sourceLang: sourceLang.value,
      targetLang: targetLang.value,
      fontSize: parseInt(fontSize.value, 10),
      opacity: parseInt(opacity.value, 10) / 100,
      blur: parseInt(blur.value, 10)
    };

    chrome.storage.local.get(['geminiLiveConfig'], (res) => {
      const merged = { ...(res.geminiLiveConfig || {}), ...newConfig };
      chrome.storage.local.set({ geminiLiveConfig: merged }, () => {
        btnSave.textContent = '✅ 保存成功！';
        setTimeout(() => {
          btnSave.textContent = '💾 保存并应用设置';
        }, 1500);

        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
          if (tabs[0] && tabs[0].id) {
            const host = (merged.apiHost || '').trim();
            const key = (merged.apiKey || '').trim();
            const isOfficial = !host || host.includes('generativelanguage.googleapis.com');
            const isReady = isOfficial ? key.length > 0 : host.length > 0;

            if (isReady) {
              try {
                await chrome.tabs.sendMessage(tabs[0].id, { action: 'SHOW_OVERLAY' });
              } catch (e) {
                try {
                  await chrome.scripting.insertCSS({ target: { tabId: tabs[0].id }, files: ['content.css'] });
                  await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
                  await new Promise(r => setTimeout(r, 100));
                  await chrome.tabs.sendMessage(tabs[0].id, { action: 'SHOW_OVERLAY' });
                } catch (err) {}
              }
            }

            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'UPDATE_CONFIG',
              config: merged
            }).catch(() => {});
          }
        });
      });
    });
  });

  // ======================================================================
  // 节点连接自检（WebSocket 握手 → setupComplete 往返耗时）
  // ======================================================================

  const btnTestConn = document.getElementById('btnTestConn');
  const testResult = document.getElementById('testResult');

  function mapTargetLanguageCode(value) {
    const t = String(value || '').toLowerCase();
    if (t.includes('英语') || t.includes('english')) return 'en';
    if (t.includes('日语') || t.includes('japanese')) return 'ja';
    return 'zh-Hans';
  }

  function buildTestWsUrl(hostRaw, key) {
    let host = String(hostRaw || '').trim() || OFFICIAL_HOST;
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
    if (key && String(key).trim() && !/[?&]key=/.test(host)) {
      host += (host.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(String(key).trim());
    }
    return host;
  }

  function getSelectedModel() {
    let chosen = modelSelect.value;
    if (chosen === 'custom') chosen = customModelInput.value.trim() || 'models/gemini-3.5-live-translate-preview';
    return chosen.replace(/^models\//i, '');
  }

  let testSocket = null;

  function runConnectionTest() {
    const host = apiHost.value.trim() || OFFICIAL_HOST;
    const key = apiKey.value.trim();
    const model = getSelectedModel();
    const isOfficial = host.includes('generativelanguage.googleapis.com');

    if (isOfficial && !key) {
      testResult.textContent = '⚠️ 直连 Google 官方 API 需要先填写 API Key。';
      testResult.style.color = '#f59e0b';
      return;
    }

    if (testSocket) {
      try { testSocket.close(); } catch (e) {}
      testSocket = null;
    }

    testResult.textContent = '⏳ 正在连接' + (isOfficial ? ' Google 官方节点' : '自定义节点') + '…';
    testResult.style.color = '#38bdf8';
    btnTestConn.disabled = true;

    const t0 = performance.now();
    let settled = false;
    let timer = null;

    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      btnTestConn.disabled = false;
      testResult.textContent = text;
      testResult.style.color = ok ? '#34d399' : '#ef4444';
      try { if (testSocket) testSocket.close(); } catch (e) {}
      testSocket = null;
    };

    let ws;
    try {
      ws = new WebSocket(buildTestWsUrl(host, key));
    } catch (e) {
      finish(false, '❌ 地址无效: ' + (e && e.message ? e.message : e));
      return;
    }
    testSocket = ws;
    timer = setTimeout(() => finish(false, '❌ 35s 内未收到 setupComplete（网关握手超时/节点不可达）'), 35000);

    ws.onopen = () => {
      testResult.textContent = '⚡ WebSocket 已连接，正在发送 setup 帧…';
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
            outputAudioTranscription: {}
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
        finish(false, '❌ 发送 setup 失败: ' + (e && e.message ? e.message : e));
      }
    };

    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      if (!text) return;
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg.setupComplete !== undefined) {
        const ms = Math.round(performance.now() - t0);
        finish(true, `✅ 握手成功！setupComplete 往返 ${ms} ms（模型 ${model}）`);
      } else if (msg.error) {
        finish(false, '❌ 服务端拒绝: ' + (msg.error.message || JSON.stringify(msg.error)).slice(0, 160));
      }
    };

    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (!settled) finish(false, `❌ 连接被关闭 (code ${ev.code}${ev.reason ? '，' + ev.reason : ''})`);
    };
  }

  if (btnTestConn) btnTestConn.addEventListener('click', runConnectionTest);
});
