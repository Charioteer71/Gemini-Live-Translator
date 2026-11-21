/**
 * Gemini Live Translator - MV3 Offscreen Audio Capture Document
 * Handles chrome.tabCapture stream playback passthrough and 16kHz Int16 PCM encoding
 * when DOM/WebAudio capture is blocked (cross-origin iframes, CORS media, WASM players).
 */
(function () {
  'use strict';

  const AUDIO_CHUNK_SAMPLES = 1600;
  let relayPort = null;
  let activeTabId = null;
  let activeStreamId = null;
  let captureStream = null;
  let audioCtx = null;
  let sourceNode = null;
  let analyserNode = null;
  let workletNode = null;
  let processorNode = null;
  let mutedGainNode = null;
  let volumeTimer = null;
  let captureSeq = 0;

  const resampler = {
    carry: new Float32Array(2),
    carryCount: 0,
    phase: 0,
    step: 3,
    pending: new Int16Array(AUDIO_CHUNK_SAMPLES * 8),
    pendingCount: 0
  };

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

  function ensureRelayPort() {
    if (relayPort) return relayPort;
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connect === 'function') {
      try {
        relayPort = chrome.runtime.connect({ name: 'glt-offscreen' });
        if (relayPort && relayPort.onDisconnect && typeof relayPort.onDisconnect.addListener === 'function') {
          relayPort.onDisconnect.addListener(() => {
            relayPort = null;
          });
        }
      } catch (e) {
        relayPort = null;
      }
    }
    return relayPort;
  }

  function postToBackground(payload) {
    const port = ensureRelayPort();
    if (port && typeof port.postMessage === 'function') {
      try {
        port.postMessage(payload);
        return;
      } catch (e) {
        relayPort = null;
      }
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
      try {
        const res = chrome.runtime.sendMessage(payload);
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch (e) {}
    }
  }

  let currentVolume = 0;

  function flushPendingChunks(targetTabId, streamId) {
    while (resampler.pendingCount >= AUDIO_CHUNK_SAMPLES) {
      const chunkBytes = new Uint8Array(resampler.pending.buffer, 0, AUDIO_CHUNK_SAMPLES * 2);
      const b64Audio = uint8ToBase64(chunkBytes, AUDIO_CHUNK_SAMPLES * 2);
      const payload = {
        type: 'OFFSCREEN_AUDIO_CHUNK',
        targetTabId: targetTabId,
        b64Audio: b64Audio,
        volume: currentVolume
      };
      const effectiveStreamId = streamId !== undefined ? streamId : activeStreamId;
      if (effectiveStreamId) payload.streamId = effectiveStreamId;
      postToBackground(payload);
      const remain = resampler.pendingCount - AUDIO_CHUNK_SAMPLES;
      if (remain > 0) resampler.pending.copyWithin(0, AUDIO_CHUNK_SAMPLES, resampler.pendingCount);
      resampler.pendingCount = remain;
    }
  }

  function resampleBlock(input, targetTabId, streamId) {
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
        flushPendingChunks(targetTabId, streamId !== undefined ? streamId : activeStreamId);
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

  function stopCapture(notifyStopped) {
    captureSeq++;
    const prevTabId = activeTabId;
    const prevStreamId = activeStreamId;
    activeTabId = null;
    activeStreamId = null;
    currentVolume = 0;
    if (volumeTimer) {
      clearInterval(volumeTimer);
      volumeTimer = null;
    }
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
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (e) {}
      sourceNode = null;
    }
    if (captureStream) {
      try {
        captureStream.getTracks().forEach((t) => {
          try { t.stop(); } catch (e) {}
        });
      } catch (e) {}
      captureStream = null;
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close().catch(() => {}); } catch (e) {}
    }
    audioCtx = null;
    resampler.pendingCount = 0;

    if (notifyStopped && prevTabId !== null) {
      const stoppedPayload = { type: 'OFFSCREEN_STOPPED', targetTabId: prevTabId };
      if (prevStreamId) stoppedPayload.streamId = prevStreamId;
      postToBackground(stoppedPayload);
    }
  }

  async function startCapture(targetTabId, streamId) {
    stopCapture(false);
    const seq = ++captureSeq;
    activeTabId = targetTabId;
    activeStreamId = streamId || null;

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('mediaDevices.getUserMedia unavailable in offscreen document');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    if (seq !== captureSeq) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      return { ok: false, cancelled: true };
    }

    captureStream = stream;
    const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    for (let i = 0; i < tracks.length; i++) {
      if (typeof tracks[i].addEventListener === 'function') {
        tracks[i].addEventListener('ended', () => {
          if (seq === captureSeq) stopCapture(true);
        });
      }
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      try { await audioCtx.resume(); } catch (e) {}
    }
    if (seq !== captureSeq) {
      stopCapture(false);
      return { ok: false, cancelled: true };
    }

    sourceNode = audioCtx.createMediaStreamSource(stream);
    // Critical: play captured tab audio back to speakers so tabCapture does not mute the tab
    sourceNode.connect(audioCtx.destination);

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    sourceNode.connect(analyserNode);

    const volumeData = new Uint8Array(analyserNode.frequencyBinCount || 128);
    volumeTimer = setInterval(() => {
      if (!analyserNode || seq !== captureSeq) return;
      try {
        analyserNode.getByteFrequencyData(volumeData);
        let sum = 0;
        for (let i = 0; i < volumeData.length; i++) sum += volumeData[i];
        currentVolume = sum / volumeData.length;
      } catch (e) {}
    }, 250);

    resetResampler(audioCtx.sampleRate || 48000);

    function handleBlock(input) {
      if (seq !== captureSeq || !input || !input.length) return;
      resampleBlock(input, targetTabId, activeStreamId);
      flushPendingChunks(targetTabId, activeStreamId);
    }

    let tapNode = null;
    const canTryWorklet = !!(
      audioCtx.audioWorklet &&
      typeof AudioWorkletNode === 'function' &&
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.getURL === 'function'
    );

    if (canTryWorklet) {
      try {
        await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('audio_worklet.js'));
        if (seq !== captureSeq) {
          stopCapture(false);
          return { ok: false, cancelled: true };
        }
        const wn = new AudioWorkletNode(audioCtx, 'gemini-live-audio-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers'
        });
        wn.port.onmessage = (evt) => {
          const data = evt && evt.data;
          if (data && data.length) handleBlock(data);
        };
        workletNode = wn;
        tapNode = wn;
      } catch (e) {
        if (seq !== captureSeq) {
          stopCapture(false);
          return { ok: false, cancelled: true };
        }
        if (workletNode) {
          try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch (err) {}
          workletNode = null;
        }
      }
    }

    if (!tapNode) {
      processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
      processorNode.onaudioprocess = (e) => {
        try {
          handleBlock(e.inputBuffer.getChannelData(0));
        } catch (err) {}
      };
      tapNode = processorNode;
    }

    sourceNode.connect(tapNode);
    mutedGainNode = audioCtx.createGain();
    mutedGainNode.gain.value = 0;
    tapNode.connect(mutedGainNode);
    mutedGainNode.connect(audioCtx.destination);
    ensureRelayPort();
    return { ok: true };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return false;
      const cmd = msg.action || msg.type;
      if (cmd === 'OFFSCREEN_START_CAPTURE') {
        const startPromise = startCapture(msg.targetTabId, msg.streamId);
        const mySeq = captureSeq;
        startPromise
          .then((res) => {
            if ((res && res.cancelled) || mySeq !== captureSeq) {
              try { sendResponse({ ok: false, cancelled: true }); } catch (e) {}
              return;
            }
            try { sendResponse({ ok: true }); } catch (e) {}
          })
          .catch((err) => {
            if (mySeq === captureSeq) {
              stopCapture(false);
            }
            try { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); } catch (e) {}
          });
        return true;
      }
      if (cmd === 'OFFSCREEN_STOP_CAPTURE') {
        const tabMatch = (msg.targetTabId === undefined || msg.targetTabId === null || msg.targetTabId === activeTabId);
        const streamMatch = (!msg.streamId || msg.streamId === activeStreamId);
        if (tabMatch && streamMatch) {
          stopCapture(false);
        }
        try { sendResponse({ ok: true }); } catch (e) {}
        return false;
      }
      return false;
    });
  }
})();
