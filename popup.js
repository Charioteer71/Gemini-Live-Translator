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

  // Export / Import Configuration (.json)
  const btnExportConfig = document.getElementById('btnExportConfig');
  const btnImportConfig = document.getElementById('btnImportConfig');
  const importFileInput = document.getElementById('importFileInput');

  if (btnExportConfig) {
    btnExportConfig.addEventListener('click', () => {
      chrome.storage.local.get(['geminiLiveConfig'], (res) => {
        const currentCfg = res.geminiLiveConfig || {};
        let chosenModel = modelSelect.value;
        if (chosenModel === 'custom') {
          chosenModel = customModelInput.value.trim() || 'models/gemini-3.5-live-translate-preview';
        }

        const exportData = {
          ...currentCfg,
          apiHost: apiHost.value.trim() || OFFICIAL_HOST,
          apiKey: apiKey.value.trim(),
          model: chosenModel,
          sourceLang: sourceLang.value,
          targetLang: targetLang.value,
          fontSize: parseInt(fontSize.value, 10),
          opacity: parseInt(opacity.value, 10) / 100,
          blur: parseInt(blur.value, 10),
          _exportedAt: new Date().toISOString()
        };

        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'gemini_live_translator_config.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        btnExportConfig.textContent = '✅ 已导出！';
        setTimeout(() => {
          btnExportConfig.textContent = '📤 导出配置 (.json)';
        }, 1500);
      });
    });
  }

  if (btnImportConfig && importFileInput) {
    btnImportConfig.addEventListener('click', () => {
      importFileInput.click();
    });

    importFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const imported = JSON.parse(event.target.result);
          if (typeof imported !== 'object' || imported === null) {
            throw new Error('配置文件不是有效的 JSON 对象');
          }

          if (imported.apiHost) apiHost.value = imported.apiHost;
          if (imported.apiKey !== undefined) apiKey.value = imported.apiKey;
          if (imported.model) {
            if (['models/gemini-3.5-live-translate-preview', 'models/gemini-3.1-flash-live-preview', 'models/gemini-2.0-flash-exp'].includes(imported.model)) {
              modelSelect.value = imported.model;
              customModelInput.style.display = 'none';
            } else {
              modelSelect.value = 'custom';
              customModelInput.value = imported.model;
              customModelInput.style.display = 'block';
            }
          }
          if (imported.sourceLang) sourceLang.value = imported.sourceLang;
          if (imported.targetLang) targetLang.value = imported.targetLang;
          if (imported.fontSize) {
            fontSize.value = imported.fontSize;
            fontSizeVal.textContent = imported.fontSize;
          }
          if (imported.opacity) {
            const opInt = Math.round(imported.opacity * 100);
            opacity.value = opInt;
            opacityVal.textContent = opInt;
          }
          if (imported.blur !== undefined) {
            blur.value = imported.blur;
            blurVal.textContent = imported.blur;
          }

          updateHostState();

          const toSave = { ...imported };
          delete toSave._exportedAt;

          chrome.storage.local.get(['geminiLiveConfig'], (res) => {
            const merged = { ...(res.geminiLiveConfig || {}), ...toSave };
            chrome.storage.local.set({ geminiLiveConfig: merged }, () => {
              btnImportConfig.textContent = '✅ 导入成功！';
              setTimeout(() => {
                btnImportConfig.textContent = '📥 导入配置 (.json)';
              }, 1500);

              chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0] && tabs[0].id) {
                  chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'UPDATE_CONFIG',
                    config: merged
                  }).catch(() => {});
                }
              });
            });
          });
        } catch (err) {
          alert('导入失败：' + (err.message || '无效的 JSON 配置文件'));
        } finally {
          importFileInput.value = '';
        }
      };
      reader.readAsText(file);
    });
  }
});
