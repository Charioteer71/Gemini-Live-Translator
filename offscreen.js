/**
 * Gemini Live Translator - Offscreen Tab Audio Capture Engine
 * High-Performance Dual-Graph Audio Processing Pipeline:
 *   1. Monitor Graph: Native hardware sample rate (44.1k/48k) -> speakers (prevents tab mute).
 *   2. Processing Graph: 16kHz mono -> AudioWorklet -> 16-bit linear PCM -> Base64 streaming.
 */

let mediaStream = null;
let audioCtx = null;
let monitorAudioCtx = null;
let monitorSource = null;
let monitorGain = null;
let sourceNode = null;
let workletNode = null;
let currentTabId = null;
let lastVolumeSent = 0;

const WORKLET_URL = chrome.runtime.getURL('audio-worklet-processor.js');

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

function cleanupCapture() {
  if (workletNode) {
    try { workletNode.disconnect(); } catch (e) {}
    workletNode = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch (e) {}
    sourceNode = null;
  }
  if (monitorGain) {
    try { monitorGain.disconnect(); } catch (e) {}
    monitorGain = null;
  }
  if (monitorSource) {
    try { monitorSource.disconnect(); } catch (e) {}
    monitorSource = null;
  }
  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach((track) => track.stop());
    } catch (e) {}
    mediaStream = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    try { audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
  if (monitorAudioCtx && monitorAudioCtx.state !== 'closed') {
    try { monitorAudioCtx.close(); } catch (e) {}
    monitorAudioCtx = null;
  }
  currentTabId = null;
}

async function startTabCapture(streamId, tabId) {
  cleanupCapture();
  currentTabId = tabId;

  try {
    // 1. Capture browser tab audio stream
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // 2. Monitor Graph: Passthrough to speakers at native hardware sample rate (no muting)
    monitorAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (monitorAudioCtx.state === 'suspended') {
      await monitorAudioCtx.resume();
    }
    monitorSource = monitorAudioCtx.createMediaStreamSource(mediaStream);
    monitorGain = monitorAudioCtx.createGain();
    monitorGain.gain.value = 1.0;
    monitorSource.connect(monitorGain);
    monitorGain.connect(monitorAudioCtx.destination);

    // 3. Processing Graph: 16,000 Hz dedicated AudioContext for Gemini Live
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000
    });
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    await audioCtx.audioWorklet.addModule(WORKLET_URL);

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'gemini-audio-processor', {
      processorOptions: { frameSize: 1600 },
      numberOfOutputs: 0
    });

    workletNode.port.onmessage = ({ data: pcm }) => {
      if (!currentTabId || audioCtx?.state !== 'running') return;

      const byteLength = pcm.length * 2;
      const uint8 = new Uint8Array(pcm.buffer, pcm.byteOffset, byteLength);
      const b64Audio = uint8ToBase64(uint8, byteLength);

      // Stream PCM chunk to background worker
      chrome.runtime.sendMessage({
        type: 'TAB_AUDIO_PCM_CHUNK',
        tabId: currentTabId,
        b64Audio: b64Audio
      }).catch(() => {});

      // Calculate audio amplitude for UI volume meter
      const now = Date.now();
      if (now - lastVolumeSent >= 200) {
        lastVolumeSent = now;
        let sum = 0;
        const step = 4;
        for (let i = 0; i < pcm.length; i += step) {
          sum += Math.abs(pcm[i]);
        }
        const avg = sum / (pcm.length / step);
        const volume = Math.min(100, Math.round((avg / 32768) * 200));

        chrome.runtime.sendMessage({
          type: 'TAB_AUDIO_VOLUME',
          tabId: currentTabId,
          volume: volume
        }).catch(() => {});
      }
    };

    sourceNode.connect(workletNode);

    chrome.runtime.sendMessage({
      type: 'TAB_AUDIO_READY',
      tabId: currentTabId
    }).catch(() => {});

  } catch (err) {
    console.error('[Offscreen] startTabCapture failed:', err);
    cleanupCapture();
    chrome.runtime.sendMessage({
      type: 'TAB_AUDIO_ERROR',
      tabId: currentTabId,
      error: err.message || String(err)
    }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'OFFSCREEN_START_CAPTURE') {
    startTabCapture(msg.streamId, msg.tabId);
  } else if (msg.action === 'OFFSCREEN_STOP_CAPTURE') {
    if (msg.tabId === currentTabId || !msg.tabId) {
      cleanupCapture();
    }
  }
});
