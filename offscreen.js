/**
 * Gemini Live Translator - Offscreen Tab Audio Capture Engine
 */

let mediaStream = null;
let audioCtx = null;
let monitorAudioCtx = null;
let processorNode = null;
let currentTabId = null;
let volumeCheckInterval = null;

const MAX_PCM_SAMPLES = 4096;
const reusablePcm16 = new Int16Array(MAX_PCM_SAMPLES);
const reusableUint8 = new Uint8Array(reusablePcm16.buffer);

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
  if (volumeCheckInterval) {
    clearInterval(volumeCheckInterval);
    volumeCheckInterval = null;
  }
  if (processorNode) {
    try { processorNode.disconnect(); } catch (e) {}
    processorNode.onaudioprocess = null;
    processorNode = null;
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
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    monitorAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (monitorAudioCtx.state === 'suspended') await monitorAudioCtx.resume();

    // 1. Lossless speaker passthrough (user hears the tab audio)
    const monitorSource = monitorAudioCtx.createMediaStreamSource(mediaStream);
    const monitorGain = monitorAudioCtx.createGain();
    monitorGain.gain.value = 1;
    monitorSource.connect(monitorGain);
    monitorGain.connect(monitorAudioCtx.destination);

    // 2. Downsampling pipeline for Gemini Live (16kHz PCM)
    const sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    const analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    sourceNode.connect(analyserNode);

    const bufferSize = 4096;
    processorNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    const nativeSampleRate = audioCtx.sampleRate || 48000;
    const targetSampleRate = 16000;
    const sampleRatio = nativeSampleRate / targetSampleRate;

    processorNode.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const outLength = Math.floor(inputData.length / sampleRatio);
      if (outLength <= 0) return;

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

      // Send PCM chunk back to background service worker for routing to content script
      chrome.runtime.sendMessage({
        type: 'TAB_AUDIO_PCM_CHUNK',
        tabId: currentTabId,
        b64Audio: b64Audio
      }).catch(() => {});
    };

    sourceNode.connect(processorNode);
    const mutedGain = audioCtx.createGain();
    mutedGain.gain.value = 0;
    processorNode.connect(mutedGain);
    mutedGain.connect(audioCtx.destination);

    const pcmVolumeData = new Uint8Array(analyserNode.frequencyBinCount);
    volumeCheckInterval = setInterval(() => {
      if (!analyserNode) return;
      analyserNode.getByteFrequencyData(pcmVolumeData);
      let sum = 0;
      for (let i = 0; i < pcmVolumeData.length; i++) sum += pcmVolumeData[i];
      const avg = sum / pcmVolumeData.length;
      chrome.runtime.sendMessage({
        type: 'TAB_AUDIO_VOLUME',
        tabId: currentTabId,
        volume: avg
      }).catch(() => {});
    }, 500);

    chrome.runtime.sendMessage({
      type: 'TAB_AUDIO_READY',
      tabId: currentTabId
    }).catch(() => {});
  } catch (err) {
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
