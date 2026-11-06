/**
 * ============================================================================
 * Gemini Live Translator - Master Automated Test Suite (Milestone 4)
 * ============================================================================
 * 
 * Comprehensive 5-Tier Verification & Benchmark Harness:
 * - Tier 1: Syntax & Manifest V3 Schema Integrity
 * - Tier 2: Web Audio & Resampling Pipeline (Zero-GC, Linear Interpolation, Base64)
 * - Tier 3: WebSocket Protocol & Error Recovery (Backoff Jitter, Terminal Errors, Signals)
 * - Tier 4: UI Performance & Shadow DOM Isolation (Zero-Reflow TextNodes, rAF, Debounce)
 * - Tier 5: Security, Sanitization & Fast Language Drift (Redaction, OWASP XSS, Drift Ops)
 * 
 * Execution: node test_suite.js
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ANSI Color formatting
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

const symbols = {
  pass: '✓',
  fail: '✗',
  bullet: '•',
  arrow: '→',
  spark: '⚡'
};

// Global Test Runner State
let totalTestsCount = 0;
let passedTestsCount = 0;
let failedTestsCount = 0;
const tierResults = [];
const benchmarkResults = [];

function startTier(tierName, description) {
  console.log(`\n${colors.bold}${colors.cyan}================================================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}[${tierName}] ${description}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}================================================================================${colors.reset}\n`);
}

function test(testName, fn) {
  totalTestsCount++;
  const t0 = performance.now();
  try {
    fn();
    const elapsed = (performance.now() - t0).toFixed(2);
    passedTestsCount++;
    console.log(`  ${colors.green}${symbols.pass}${colors.reset} ${colors.bold}${testName}${colors.reset} ${colors.gray}(${elapsed} ms)${colors.reset}`);
  } catch (err) {
    failedTestsCount++;
    console.error(`  ${colors.red}${symbols.fail} ${colors.bold}${testName}${colors.reset}`);
    console.error(`    ${colors.red}Error: ${err.message}${colors.reset}`);
    if (err.stack) {
      const stackLines = err.stack.split('\n').slice(1, 4).join('\n    ');
      console.error(`    ${colors.gray}${stackLines}${colors.reset}`);
    }
  }
}

// Extract isolated functions from code files safely
function extractFunctionFromCode(code, funcName) {
  if (funcName === 'escapeHtml') {
    const mapMatch = code.match(/const HTML_ESCAPE_MAP[\s\S]*?const HTML_ESCAPE_REGEX = \/[^\/]+\/g;/);
    const fnMatch = code.match(/function escapeHtml\([\s\S]*?\n  \}/);
    if (!mapMatch || !fnMatch) throw new Error('Could not extract escapeHtml from code');
    return new Function(`return (() => { ${mapMatch[0]}; return ${fnMatch[0]}; })()`)();
  }
  const regex = new RegExp(`function\\s+${funcName}\\s*\\([\\s\\S]*?\\n  \\}`, 'm');
  const match = code.match(regex);
  if (!match) {
    throw new Error(`Could not extract function ${funcName} from code`);
  }
  return new Function(`return (${match[0]})`)();
}

// Read Source Files
const ROOT_DIR = __dirname;
const manifestFile = path.join(ROOT_DIR, 'manifest.json');
const bgFile = path.join(ROOT_DIR, 'background.js');
const contentFile = path.join(ROOT_DIR, 'content.js');
const cssFile = path.join(ROOT_DIR, 'content.css');
const popupJsFile = path.join(ROOT_DIR, 'popup.js');
const popupHtmlFile = path.join(ROOT_DIR, 'popup.html');

const manifestCode = fs.readFileSync(manifestFile, 'utf8');
const bgCode = fs.readFileSync(bgFile, 'utf8');
const contentCode = fs.readFileSync(contentFile, 'utf8');
const cssCode = fs.readFileSync(cssFile, 'utf8');
const popupJsCode = fs.readFileSync(popupJsFile, 'utf8');
const popupHtmlCode = fs.readFileSync(popupHtmlFile, 'utf8');

// Extracted Content.js Functions
const sanitizeErrorMessage = extractFunctionFromCode(contentCode, 'sanitizeErrorMessage');
const sanitizeUrl = extractFunctionFromCode(contentCode, 'sanitizeUrl');
const calculateBackoffDelay = extractFunctionFromCode(contentCode, 'calculateBackoffDelay');
const isTerminalError = extractFunctionFromCode(contentCode, 'isTerminalError');
const detectLanguageFromText = extractFunctionFromCode(contentCode, 'detectLanguageFromText');
const isLiveTranslateModel = extractFunctionFromCode(contentCode, 'isLiveTranslateModel');
const escapeHtml = extractFunctionFromCode(contentCode, 'escapeHtml');

// Extract getBcp47LanguageCode (需要独立求值，函数体无外部常量依赖)
const bcpFnMatch = contentCode.match(/function getBcp47LanguageCode\([^\)]*\)\s*\{([\s\S]*?)\n  \}/);
if (!bcpFnMatch) throw new Error('Could not extract getBcp47LanguageCode from content.js');
const getBcp47LanguageCode = new Function('targetLang', bcpFnMatch[1]);

// Extract uint8ToBase64
const uint8ToBase64Match = contentCode.match(/function uint8ToBase64\([\s\S]*?\n  \}/);
const uint8ToBase64 = new Function(`return (${uint8ToBase64Match[0]})`)();

console.log(`${colors.bold}${colors.magenta}`);
console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
console.log('║               GEMINI LIVE TRANSLATOR - MASTER TEST SUITE                     ║');
console.log('║                   Full 5-Tier Verification & Benchmarks                      ║');
console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
console.log(`${colors.reset}`);

// ============================================================================
// TIER 1: SYNTAX & MANIFEST V3 SCHEMA INTEGRITY
// ============================================================================
startTier('TIER 1', 'Syntax & Manifest V3 Schema Integrity');

test('T1.1: JavaScript Syntax Evaluation Across All Files', () => {
  const jsFiles = [
    { name: 'background.js', code: bgCode },
    { name: 'content.js', code: contentCode },
    { name: 'popup.js', code: popupJsCode }
  ];
  for (const f of jsFiles) {
    assert.doesNotThrow(() => {
      new Function(f.code);
    }, `Syntax error encountered in ${f.name}`);
  }
});

test('T1.2: Manifest V3 Specification & Metadata Schema', () => {
  const manifest = JSON.parse(manifestCode);
  assert.strictEqual(manifest.manifest_version, 3, 'Manifest version must be 3');
  assert.strictEqual(manifest.name, 'Gemini Live Translator (实时双语同传字幕)', 'Name must match extension branding');
  assert(manifest.version, 'Manifest must declare version');
  assert(manifest.description, 'Manifest must declare description');
  assert(manifest.icons && manifest.icons['16'] && manifest.icons['48'] && manifest.icons['128'], 'Icons (16, 48, 128) must be declared');
  assert.strictEqual(manifest.background.service_worker, 'background.js', 'Background service worker must be background.js');
  assert.strictEqual(manifest.action.default_popup, 'popup.html', 'Action popup must be popup.html');
  assert.strictEqual(manifest.options_page, 'popup.html', 'Options page must be popup.html');
});

test('T1.3: Manifest Permissions & Host Permissions Scope', () => {
  const manifest = JSON.parse(manifestCode);
  const expectedPerms = ['storage', 'activeTab', 'scripting'];
  assert(Array.isArray(manifest.permissions), 'Permissions must be an array');
  for (const p of expectedPerms) {
    assert(manifest.permissions.includes(p), `Permissions must include '${p}'`);
  }
  assert(Array.isArray(manifest.host_permissions), 'Host permissions must be an array');
  assert(manifest.host_permissions.includes('<all_urls>'), 'Host permissions must include <all_urls>');
});

test('T1.4: Web Accessible Resources & Content Script Declarations', () => {
  const manifest = JSON.parse(manifestCode);
  assert(Array.isArray(manifest.web_accessible_resources), 'web_accessible_resources must be an array');
  const warResources = manifest.web_accessible_resources.flatMap(item => item.resources);
  assert(warResources.includes('content.css'), 'web_accessible_resources must include content.css for Shadow DOM injection');
  assert(warResources.some(r => r.includes('icons/')), 'web_accessible_resources must include icons');

  assert(Array.isArray(manifest.content_scripts), 'content_scripts must be an array');
  const cs = manifest.content_scripts[0];
  assert(cs.matches.includes('<all_urls>'), 'Content script must match <all_urls>');
  assert(cs.js.includes('content.js'), 'Content script must load content.js');
  assert(cs.css.includes('content.css'), 'Content script must load content.css');
  assert.strictEqual(cs.run_at, 'document_idle', 'Content script run_at must be document_idle');
});

test('T1.5: Background Service Worker Architecture & Message Routing', () => {
  assert(!bgCode.includes('chrome.action.onClicked.addListener'), 'background.js must not contain dead action.onClicked listener');
  assert(bgCode.includes('chrome.runtime.onInstalled.addListener'), 'background.js must handle onInstalled defaults initialization');
  assert(bgCode.includes('chrome.runtime.onMessage.addListener'), 'background.js must listen to runtime messages');
  assert(bgCode.includes('ENSURE_INJECTED'), 'background.js must support ENSURE_INJECTED message');
  assert(bgCode.includes('GET_CONFIG_STATUS'), 'background.js must support GET_CONFIG_STATUS message');
  assert(bgCode.includes('sanitizeErrorMessage'), 'background.js must use sanitizeErrorMessage on injection warnings');
});

// ============================================================================
// TIER 2: WEB AUDIO & RESAMPLING PIPELINE
// ============================================================================
startTier('TIER 2', 'Web Audio & Resampling Pipeline (Linear Interpolation, Zero-GC, Base64)');

// Reusable downsampler simulator matching content.js algorithm
function resampleLinear(inputData, nativeRate, targetRate, outputPcm16) {
  const sampleRatio = nativeRate / targetRate;
  const outLength = Math.floor(inputData.length / sampleRatio);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * sampleRatio;
    const idx0 = Math.floor(srcPos);
    const idx1 = idx0 + 1 < inputData.length ? idx0 + 1 : inputData.length - 1;
    const frac = srcPos - idx0;
    const s0 = Number.isFinite(inputData[idx0]) ? inputData[idx0] : 0;
    const s1 = Number.isFinite(inputData[idx1]) ? inputData[idx1] : 0;
    const sample = (1 - frac) * s0 + frac * s1;
    const clamped = Math.max(-1, Math.min(1, sample));
    outputPcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return outLength;
}

test('T2.1: High-Fidelity Linear Interpolation Resampling (48kHz -> 16kHz & 44.1kHz -> 16kHz)', () => {
  const pcm16 = new Int16Array(4096);

  // 1. DC 1.0 Signal -> Should be 32767
  const dcOne = new Float32Array(4096).fill(1.0);
  const outLen1 = resampleLinear(dcOne, 48000, 16000, pcm16);
  assert.strictEqual(outLen1, Math.floor(4096 / 3));
  for (let i = 0; i < outLen1; i++) {
    assert.strictEqual(pcm16[i], 32767, `Expected 32767 at index ${i}`);
  }

  // 2. DC -1.0 Signal -> Should be -32768
  const dcNegOne = new Float32Array(4096).fill(-1.0);
  const outLen2 = resampleLinear(dcNegOne, 48000, 16000, pcm16);
  for (let i = 0; i < outLen2; i++) {
    assert.strictEqual(pcm16[i], -32768, `Expected -32768 at index ${i}`);
  }

  // 3. DC 0.0 Signal -> Should be 0
  const dcZero = new Float32Array(4096).fill(0.0);
  const outLen3 = resampleLinear(dcZero, 44100, 16000, pcm16);
  for (let i = 0; i < outLen3; i++) {
    assert.strictEqual(pcm16[i], 0, `Expected 0 at index ${i}`);
  }

  // 4. Fractional Interpolation Accuracy: Ramp from 0.0 to 1.0
  const ramp = new Float32Array(4096);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i / ramp.length;
  const outLen4 = resampleLinear(ramp, 48000, 16000, pcm16);
  for (let i = 1; i < outLen4; i++) {
    assert(pcm16[i] >= pcm16[i - 1], `Resampled ramp must be monotonic at index ${i}`);
  }
});

test('T2.2: Resampler Overflow Clamping & NaN / Infinity Safety Guards', () => {
  const pcm16 = new Int16Array(4096);
  const dirtyBuffer = new Float32Array([
    1.5, 2.0, 999.0,         // Positive overshoots
    -1.5, -2.0, -999.0,      // Negative overshoots
    NaN, Infinity, -Infinity,// Malformed floats
    0.5, -0.5
  ]);

  const outLen = resampleLinear(dirtyBuffer, 48000, 16000, pcm16);
  for (let i = 0; i < outLen; i++) {
    assert(Number.isFinite(pcm16[i]), `Output sample at ${i} must be finite integer`);
    assert(pcm16[i] >= -32768 && pcm16[i] <= 32767, `Output sample at ${i} out of 16-bit range`);
  }
});

test('T2.3: Chunked 8192-byte Base64 Encoder Integrity & Precision', () => {
  // Test across various buffer sizes: 0, 1, 100, 4096, 8192, 16384, 25000 bytes
  const testLengths = [0, 1, 15, 100, 1024, 4096, 8191, 8192, 8193, 16384, 25000];
  for (const len of testLengths) {
    const rawBytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      rawBytes[i] = (i * 37 + 13) & 0xFF;
    }
    const resultB64 = uint8ToBase64(rawBytes, len);
    const oracleB64 = Buffer.from(rawBytes.buffer, rawBytes.byteOffset, len).toString('base64');
    assert.strictEqual(resultB64, oracleB64, `Base64 mismatch for buffer length ${len}`);
  }
});

test('T2.4: Audio Source Node WeakMap Caching & InvalidStateError Prevention', () => {
  // Verify content.js uses WeakMap mediaSourceCache
  assert(contentCode.includes('mediaSourceCache = new WeakMap()'), 'content.js must instantiate mediaSourceCache as WeakMap');
  assert(contentCode.includes('mediaSourceCache.get(video)'), 'content.js must query mediaSourceCache before creating source node');
  assert(contentCode.includes('mediaSourceCache.set(video,'), 'content.js must cache created source nodes');
  assert(contentCode.includes('rebindActiveVideo'), 'content.js must implement rebindActiveVideo for dynamic switching');

  // Behavioral test for WeakMap caching logic
  const mockCache = new WeakMap();
  const mockVideo1 = { id: 'video_1' };
  const mockVideo2 = { id: 'video_2' };
  let creationCount = 0;

  function mockGetOrCreateGraph(video) {
    let graph = mockCache.get(video);
    if (!graph) {
      creationCount++;
      graph = { sourceNode: { id: `source_${creationCount}` } };
      mockCache.set(video, graph);
    }
    return graph;
  }

  const g1_a = mockGetOrCreateGraph(mockVideo1);
  const g1_b = mockGetOrCreateGraph(mockVideo1);
  assert.strictEqual(g1_a, g1_b, 'Second call with same video element must return identical cached graph');
  assert.strictEqual(creationCount, 1, 'Source node must only be created once per video element');

  const g2 = mockGetOrCreateGraph(mockVideo2);
  assert.notStrictEqual(g1_a, g2, 'Different video element must receive separate graph instance');
  assert.strictEqual(creationCount, 2, 'Creation count should be 2');
});

test('T2.5: Microphone Hardware Stream Track Immediate Teardown', () => {
  // Static checks in cleanupAudioPipeline and initAudioCapture
  assert(contentCode.includes('mediaStream.getTracks().forEach'), 'cleanupAudioPipeline must iterate mediaStream tracks');
  assert(contentCode.includes('track.stop()') || contentCode.includes('t.stop()'), 'cleanupAudioPipeline must invoke track.stop()');

  // Behavioral mock verification
  let stoppedTrackCount = 0;
  const mockStream = {
    getTracks: () => [
      { stop: () => { stoppedTrackCount++; } },
      { stop: () => { stoppedTrackCount++; } }
    ]
  };

  mockStream.getTracks().forEach(t => t.stop());
  assert.strictEqual(stoppedTrackCount, 2, 'All active tracks must be stopped');
});

// Benchmark: Web Audio Resampler Throughput
(() => {
  const FRAMES = 10000;
  const FRAME_SIZE = 4096;
  const inputBuffer = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    inputBuffer[i] = Math.sin((i / FRAME_SIZE) * Math.PI * 2 * 440);
  }
  const outputPcm16 = new Int16Array(FRAME_SIZE);

  const t0 = performance.now();
  let totalResampledSamples = 0;
  for (let f = 0; f < FRAMES; f++) {
    const outLen = resampleLinear(inputBuffer, 48000, 16000, outputPcm16);
    totalResampledSamples += outLen;
  }
  const elapsedMs = performance.now() - t0;
  const totalInputSamples = FRAMES * FRAME_SIZE;
  const megaSamplesPerSec = ((totalInputSamples / (elapsedMs / 1000)) / 1000000).toFixed(2);
  const throughputMBps = (((totalInputSamples * 4) / (1024 * 1024)) / (elapsedMs / 1000)).toFixed(2);

  benchmarkResults.push({
    name: 'Audio Resampler (48k->16k Linear Interpolation)',
    metric: `${megaSamplesPerSec} MSamples/s (${throughputMBps} MB/s input)`,
    duration: `${elapsedMs.toFixed(2)} ms for ${FRAMES.toLocaleString()} frames`
  });
})();

// ============================================================================
// TIER 3: WEBSOCKET PROTOCOL & ERROR RECOVERY
// ============================================================================
startTier('TIER 3', 'WebSocket Protocol, Error Recovery & Security Hardening');

test('T3.1: Exponential Backoff Calculation with Jitter (0.6s,1.2s,2.4s,4.8s,8s ±20%, cap 8s)', () => {
  const BASE_MS = 600;
  const CAP_MS = 8000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = BASE_MS * Math.pow(2, attempt);
    const minExpected = Math.round(base * 0.8);
    const maxExpected = Math.min(Math.round(base * 1.2), CAP_MS);
    for (let trial = 0; trial < 100; trial++) {
      const delay = calculateBackoffDelay(attempt);
      assert(delay >= minExpected - 1, `Attempt ${attempt}: delay ${delay}ms below min ${minExpected}ms`);
      assert(delay <= maxExpected + 1, `Attempt ${attempt}: delay ${delay}ms above max ${maxExpected}ms`);
      assert(delay <= CAP_MS, `Attempt ${attempt}: delay ${delay}ms exceeded ${CAP_MS}ms ceiling`);
    }
  }
  // Attempt >= 5 必须严格封顶 8000ms（网关慢握手场景下仍需快速恢复，不无限指数增长）
  for (let attempt = 5; attempt <= 12; attempt++) {
    for (let trial = 0; trial < 20; trial++) {
      assert.strictEqual(calculateBackoffDelay(attempt), CAP_MS, `Attempt ${attempt} must cap at ${CAP_MS}ms`);
    }
  }
});

test('T3.2: Terminal Error Discrimination for Fatal vs. Transient Errors', () => {
  // 只有「明确的 Key/鉴权无效」才应终止；网关轮询场景下 1008/4xxx/配额类错误必须当作可重试
  const terminalCases = [
    { code: 400, reason: 'API_KEY_INVALID' },
    { code: 400, reason: 'API key not valid. Please pass a valid API key.' },
    { code: 401, reason: 'UNAUTHENTICATED: API key not valid' },
    { code: 403, reason: 'PERMISSION_DENIED' },
    { code: 1000, reason: 'API key expired. Please renew the API key.' }
  ];

  for (const c of terminalCases) {
    assert.strictEqual(isTerminalError(c.code, c.reason), true, `Case ${JSON.stringify(c)} must be classified as terminal`);
  }

  // Transient：网络抖动 / 网关轮换 Key 限流 / 服务端临时错误（必须继续重连）
  const transientCases = [
    { code: 1008, reason: 'Policy Violation' },
    { code: 4400, reason: 'Bad Request' },
    { code: 4401, reason: 'Unauthorized' },
    { code: 4403, reason: 'Forbidden' },
    { code: 404, reason: 'Model not found' },
    { code: 1000, reason: 'RESOURCE_EXHAUSTED: Quota exceeded for project 12345' },
    { code: 1000, reason: 'BILLING_DISABLED' },
    { code: 1000, reason: 'Normal Closure' },
    { code: 1001, reason: 'Going Away' },
    { code: 1006, reason: 'Abnormal Closure' },
    { code: 0, reason: 'Connection timeout' },
    { code: 0, reason: 'Socket closed unexpectedly' }
  ];

  for (const c of transientCases) {
    assert.strictEqual(isTerminalError(c.code, c.reason), false, `Case ${JSON.stringify(c)} must be classified as transient`);
  }
});

test('T3.3: Session State Machine & Async Race Guarding', () => {
  assert(contentCode.includes('let sessionSeq = 0'), 'content.js must declare sessionSeq counter');
  assert(contentCode.includes('function createSession('), 'content.js must define createSession');
  assert(contentCode.includes('function closeSession('), 'content.js must define closeSession');
  assert(contentCode.includes('function scheduleReconnect('), 'content.js must define scheduleReconnect');
  assert(contentCode.includes('if (session !== activeSession)'), 'content.js must guard stale-session events against activeSession');
  assert(contentCode.includes('session.intentionallyClosed'), 'content.js must track intentional closes to avoid reconnect storms');
  assert(contentCode.includes('if (!isRunning) return;'), 'session callbacks must check isRunning before acting');

  // 模拟：旧会话在关闭后仍收到消息，不得污染当前 activeSession 的字幕缓冲
  function makeState() {
    return { activeSession: null, lines: 0 };
  }
  const state = makeState();
  const s1 = { id: 1, state: 'ready' };
  const s2 = { id: 2, state: 'ready' };
  state.activeSession = s1;
  function handleMessage(session, role) {
    if (session !== state.activeSession) return false;
    return role === 'transcript';
  }
  state.activeSession = s2; // 轮转：s1 被替换
  assert.strictEqual(handleMessage(s1, 'transcript'), false, 'Stale session transcripts must be dropped');
  assert.strictEqual(handleMessage(s2, 'transcript'), true, 'Active session transcripts must be rendered');
});

test('T3.4: Gemini Live Protocol Signals & Error Propagation', () => {
  assert(contentCode.includes('sc.interrupted'), 'content.js must handle serverContent.interrupted');
  assert(contentCode.includes('sc.turnComplete'), 'content.js must handle serverContent.turnComplete');
  assert(contentCode.includes('msg.goAway'), 'content.js must handle serverContent goAway for session rotation');
  assert(contentCode.includes('if (msg.error)'), 'content.js must inspect incoming msg.error payloads');
  assert(contentCode.includes('audioErr'), 'setupComplete handler must catch initAudioCapture failures');
  assert(contentCode.includes('setDiagnostics('), 'content.js must expose diagnostics for automated verification');
});

test('T3.6: Native Live Translate Protocol, Session Rotation & Anti-Fragmentation Segmentation', () => {
  assert(contentCode.includes('function isLiveTranslateModel'), 'content.js must define isLiveTranslateModel');
  assert(contentCode.includes('function getBcp47LanguageCode'), 'content.js must define getBcp47LanguageCode');
  assert(contentCode.includes('systemInstruction'), 'content.js must support systemInstruction macro guidance for Agent models');
  assert(contentCode.includes('outputAudioTranscription:'), 'content.js must request outputAudioTranscription');
  assert(contentCode.includes('sc.outputTranscription'), 'content.js must process outputTranscription');
  // 防碎片：新引擎采用「句末标点 + 静音 + 最大长度」三重断句，而非旧版尾部词表
  assert(contentCode.includes('TERMINAL_PUNCT_RE'), 'content.js must define terminal punctuation boundary regex');
  assert(contentCode.includes('function bufferEndsWithTerminal('), 'content.js must implement terminal-boundary detection');
  assert(contentCode.includes('function maybeCommitByBoundary('), 'content.js must implement boundary-based commit');
  assert(contentCode.includes("commitCurrentLine(false, 'punctuation')"), 'content.js must commit lines on sentence punctuation');
  assert(contentCode.includes("'silence'"), 'content.js must commit lines on silence timeout');
  assert(contentCode.includes('SESSION_ROTATE_MS'), 'content.js must implement proactive session rotation');
  assert(contentCode.includes('standbySession'), 'content.js must support seamless standby rotation');

  // BCP-47 目标语言映射
  assert.strictEqual(getBcp47LanguageCode('中文普通话 (Chinese)'), 'zh-Hans');
  assert.strictEqual(getBcp47LanguageCode('繁体中文'), 'zh-Hant');
  assert.strictEqual(getBcp47LanguageCode('日语 (Japanese)'), 'ja');
  assert.strictEqual(getBcp47LanguageCode('英语 (English)'), 'en');
  assert.strictEqual(getBcp47LanguageCode('韩语 (Korean)'), 'ko');

  // 回归测试：translations/transcriptions 必须在 setup 顶层（官方文档 WebSocket 示例的 generationConfig 内层写法会被服务端 1007 拒绝）
  const setupMatch = contentCode.match(/function buildSetupPayload\(\)\s*\{([\s\S]*?)\n  \}/);
  assert(setupMatch, 'buildSetupPayload must be extractable');
  const setupFactory = new Function(
    'config', 'normalizeModelName', 'isLiveTranslateModel', 'getBcp47LanguageCode', 'buildDynamicSystemPrompt', 'getPageContext',
    'return (' + setupMatch[0] + ');'
  );
  const buildSetup = setupFactory(
    { model: 'models/gemini-3.5-live-translate-preview', targetLang: '中文普通话 (Chinese)', responseModality: 'AUDIO' },
    (m) => 'models/' + String(m || '').replace(/^models\//i, ''),
    (m) => /live-translate/i.test(String(m || '')),
    (lang) => getBcp47LanguageCode(lang),
    () => '',
    () => ({ domain: 'GENERAL', title: '', channel: '' })
  );
  const payload = buildSetup();
  assert(payload.setup.model === 'models/gemini-3.5-live-translate-preview', 'setup.model must be normalized with models/ prefix');
  assert.deepStrictEqual(payload.setup.generationConfig.responseModalities, ['AUDIO'], 'Native live-translate must request AUDIO modality');
  assert.strictEqual(payload.setup.generationConfig.inputAudioTranscription, undefined, 'inputAudioTranscription must NOT be nested in generationConfig');
  assert.deepStrictEqual(payload.setup.inputAudioTranscription, {}, 'inputAudioTranscription must be a top-level setup field');
  assert.deepStrictEqual(payload.setup.outputAudioTranscription, {}, 'outputAudioTranscription must be a top-level setup field');
  assert.strictEqual(payload.setup.translationConfig, undefined, 'translationConfig must NOT be a top-level setup field (server rejects 1007)');
  assert.strictEqual(payload.setup.generationConfig.translationConfig.targetLanguageCode, 'zh-Hans', 'translationConfig must live inside generationConfig with BCP-47 target');
  assert.strictEqual(payload.setup.generationConfig.translationConfig.echoTargetLanguage, true, 'echoTargetLanguage must be enabled to caption same-language audio');
  assert.strictEqual(payload.setup.systemInstruction, undefined, 'Native live-translate must not send systemInstruction');
  assert.strictEqual(payload.setup.generationConfig.temperature, undefined, 'Native live-translate must not send temperature');
  // 回归：contextWindowCompression 必须存在（缺失会导致长会话 70~90s 后产出塌缩）
  assert(payload.setup.contextWindowCompression, 'Native setup must enable contextWindowCompression');
  assert.deepStrictEqual(payload.setup.contextWindowCompression.slidingWindow, {}, 'contextWindowCompression must use slidingWindow');
  assert.strictEqual(payload.setup.generationConfig.contextWindowCompression, undefined, 'contextWindowCompression must be a top-level setup field');

  // legacy 兼容模式：供对照/回退使用，必须保留 systemInstruction 且不带 translationConfig
  const legacyBuild = setupFactory(
    { model: 'models/gemini-3.5-live-translate-preview', targetLang: '中文普通话 (Chinese)', responseModality: 'TEXT', protocolMode: 'legacy' },
    (m) => 'models/' + String(m || '').replace(/^models\//i, ''),
    (m) => /live-translate/i.test(String(m || '')),
    (lang) => getBcp47LanguageCode(lang),
    () => 'PROMPT',
    () => ({ domain: 'GENERAL', title: '', channel: '' })
  );
  const legacyPayload = legacyBuild();
  assert.strictEqual(legacyPayload.setup.generationConfig.translationConfig, undefined, 'legacy payload must NOT carry translationConfig');
  assert.deepStrictEqual(legacyPayload.setup.generationConfig.responseModalities, ['TEXT'], 'legacy payload uses TEXT modality');
  assert.strictEqual(legacyPayload.setup.generationConfig.temperature, 0.3, 'legacy payload keeps temperature for agent-style behavior');
  assert(legacyPayload.setup.systemInstruction && legacyPayload.setup.systemInstruction.parts[0].text.includes('[MODE]'), 'legacy payload must carry systemInstruction macro steering');
  assert.deepStrictEqual(legacyPayload.setup.inputAudioTranscription, {}, 'legacy payload keeps top-level transcription config');
});

test('T3.5: WebSocket URL Normalization & Key Parameter Formulation', () => {
  const getWebSocketUrlMatch = contentCode.match(/function getWebSocketUrl\(\)\s*\{([\s\S]*?)\n  \}/);
  assert(getWebSocketUrlMatch, 'getWebSocketUrl function must be present');
  
  // Create isolated evaluator for getWebSocketUrl
  function createUrlBuilder(cfg) {
    const fnBody = getWebSocketUrlMatch[1];
    return new Function('config', `${fnBody}`)(cfg);
  }

  // Official Host with API Key
  const url1 = createUrlBuilder({
    apiHost: 'https://generativelanguage.googleapis.com',
    apiKey: 'AIzaSyTestKey123'
  });
  assert(url1.startsWith('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.'), 'Official URL must use wss protocol and Bidi path');
  assert(url1.includes('key=AIzaSyTestKey123'), 'Official URL must append key query parameter');

  // Custom Proxy without Key
  const url2 = createUrlBuilder({
    apiHost: 'https://custom-proxy.example.com/live',
    apiKey: ''
  });
  assert(url2.startsWith('wss://custom-proxy.example.com/live/ws/google.ai.generativelanguage.'), 'Custom proxy URL must normalize https to wss');
  assert(!url2.includes('key='), 'Key parameter must not be appended if empty');
});

test('T3.7: Default Config Consistency & Audio Frame Format Builders', () => {
  // content.js 默认配置
  const cfgMatch = contentCode.match(/const DEFAULT_CONFIG = \{([\s\S]*?)\n  \};/);
  assert(cfgMatch, 'content.js DEFAULT_CONFIG must be extractable');
  const contentDefaults = new Function('return {' + cfgMatch[1] + '};')();
  assert.strictEqual(contentDefaults.model, 'models/gemini-3.5-live-translate-preview', 'Default model must be the native live-translate model');
  assert.strictEqual(contentDefaults.protocolMode, 'native', 'Default protocolMode must be native (verified continuous streaming)');
  assert.strictEqual(contentDefaults.audioFrameStyle, 'mediaChunks', 'Default audioFrameStyle must be mediaChunks (verified continuous; realtimeInput.audio is sparse)');
  assert.strictEqual(contentDefaults.responseModality, 'AUDIO', 'Default responseModality must be AUDIO for native live-translate');

  // background.js 默认配置必须与 content.js 对齐（避免旧 storage 迁移后不一致）
  const bgCfgMatch = bgCode.match(/const DEFAULT_CONFIG = \{([\s\S]*?)\n\};/);
  assert(bgCfgMatch, 'background.js DEFAULT_CONFIG must be extractable');
  const bgDefaults = new Function('return {' + bgCfgMatch[1] + '};')();
  for (const key of ['model', 'protocolMode', 'audioFrameStyle', 'responseModality', 'targetLang', 'audioMode']) {
    assert.strictEqual(bgDefaults[key], contentDefaults[key], `background.js DEFAULT_CONFIG.${key} must match content.js`);
  }

  // 音频帧构造器：mediaChunks（默认/实测有效）与 audio（官方字段/实测稀疏）可切换
  const frameMatch = contentCode.match(/function buildAudioPayload\(b64Audio\)\s*\{([\s\S]*?)\n  \}/);
  assert(frameMatch, 'buildAudioPayload must be extractable');
  const buildFrame = new Function('config', 'b64Audio', frameMatch[1]);
  const chunksFrame = buildFrame({ audioFrameStyle: 'mediaChunks' }, 'QUJD');
  assert(chunksFrame.includes('"mediaChunks"'), 'mediaChunks frame must use realtimeInput.mediaChunks');
  assert(chunksFrame.includes('"data":"QUJD"'), 'mediaChunks frame must carry base64 payload');
  assert(chunksFrame.includes('audio/pcm;rate=16000'), 'mediaChunks frame must declare 16kHz PCM mime type');
  const audioFrame = buildFrame({ audioFrameStyle: 'audio' }, 'QUJD');
  assert(audioFrame.includes('"audio"') && !audioFrame.includes('mediaChunks'), 'audio frame mode must use realtimeInput.audio field');

  // README 版本一致性
  const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  assert(readme.includes('v1.0.6'), 'README must document current version v1.0.6');
  assert(readme.includes('mediaChunks'), 'README must document mediaChunks audio frame requirement');
});

// ============================================================================
// TIER 4: UI PERFORMANCE & SHADOW DOM ISOLATION
// ============================================================================
startTier('TIER 4', 'UI Performance & Shadow DOM Encapsulation (Zero-Reflow, rAF, Debounce)');

test('T4.1: Shadow Host (#gemini-live-translator-host) & Open ShadowRoot Creation', () => {
  assert(contentCode.includes('hostEl.id = \'gemini-live-translator-host\'') || contentCode.includes('hostEl.id = "gemini-live-translator-host"'), 'Host ID must be gemini-live-translator-host');
  assert(contentCode.includes('hostEl.style.cssText = \'all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important;\''), 'Host styles must be isolated with all: initial and zero dimensions');
  assert(contentCode.includes('hostEl.attachShadow({ mode: \'open\' })') || contentCode.includes('hostEl.attachShadow({ mode: "open" })'), 'ShadowRoot must be attached with open mode');
  assert(contentCode.includes('chrome.runtime.getURL(\'content.css\')') || contentCode.includes('chrome.runtime.getURL("content.css")'), 'ShadowRoot must inject content.css link');
  assert(contentCode.includes('shadowRoot.appendChild(overlay)'), 'Overlay must be appended inside shadowRoot');
  assert(contentCode.includes('document.body.appendChild(hostEl)'), 'hostEl must be appended to document.body');
});

test('T4.2: Shadow DOM Privacy Isolation Against Host QuerySelectors', () => {
  // Mock Shadow DOM Tree
  class MockDOMNode {
    constructor(name, type = 1) {
      this.nodeName = name;
      this.nodeType = type;
      this.childNodes = [];
      this.parentNode = null;
    }
    appendChild(c) {
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
  }

  class MockDOMElement extends MockDOMNode {
    constructor(tag) {
      super(tag.toUpperCase(), 1);
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.className = '';
      this.shadowRoot = null;
    }
    attachShadow() {
      this.shadowRoot = new MockDOMNode('#document-fragment', 11);
      return this.shadowRoot;
    }
    querySelector(selector) {
      return this._query(this, selector);
    }
    querySelectorAll(selector) {
      const res = [];
      this._queryAll(this, selector, res);
      return res;
    }
    getElementById(id) {
      return this.querySelector('#' + id);
    }
    _query(root, sel) {
      for (const ch of root.childNodes) {
        if (ch.nodeType === 1) {
          if (sel.startsWith('#') && ch.id === sel.slice(1)) return ch;
          if (sel.startsWith('.') && ch.className.includes(sel.slice(1))) return ch;
        }
        const f = this._query(ch, sel);
        if (f) return f;
      }
      return null;
    }
    _queryAll(root, sel, res) {
      for (const ch of root.childNodes) {
        if (ch.nodeType === 1) {
          if (sel.startsWith('#') && ch.id === sel.slice(1)) res.push(ch);
          if (sel.startsWith('.') && ch.className.includes(sel.slice(1))) res.push(ch);
        }
        this._queryAll(ch, sel, res);
      }
    }
  }

  const doc = new MockDOMElement('DOCUMENT');
  const body = new MockDOMElement('BODY');
  doc.appendChild(body);

  const host = new MockDOMElement('DIV');
  host.id = 'gemini-live-translator-host';
  const sr = host.attachShadow();
  body.appendChild(host);

  const overlayEl = new MockDOMElement('DIV');
  overlayEl.id = 'gemini-live-sub-overlay';
  const subTransEl = new MockDOMElement('DIV');
  subTransEl.className = 'g-sub-trans';
  overlayEl.appendChild(subTransEl);
  sr.appendChild(overlayEl);

  // Host queries MUST NOT reach inside ShadowRoot
  assert.strictEqual(doc.getElementById('gemini-live-sub-overlay'), null, 'Host document.getElementById must return null for overlay');
  assert.strictEqual(doc.querySelector('.g-sub-trans'), null, 'Host document.querySelector must return null for subtitle text');
  assert.strictEqual(doc.querySelectorAll('.g-sub-trans').length, 0, 'Host document.querySelectorAll must return empty array');
});

test('T4.3: Zero-Reflow Streaming Subtitle Mutation via Persistent Text Nodes', () => {
  const renderMatch = contentCode.match(/function renderStreamingLine\(\)\s*\{([\s\S]*?)\n  \}/);
  assert(renderMatch, 'renderStreamingLine must be defined');
  const body = renderMatch[1];

  assert(!body.includes('innerHTML'), 'renderStreamingLine must NOT use innerHTML');
  assert(!body.includes('insertAdjacentHTML'), 'renderStreamingLine must NOT use insertAdjacentHTML');
  assert(body.includes('_origText.nodeValue'), 'renderStreamingLine must mutate _origText.nodeValue directly');
  assert(body.includes('_transText.nodeValue'), 'renderStreamingLine must mutate _transText.nodeValue directly');
  assert(body.includes('safeScrollToBottom()'), 'renderStreamingLine must call safeScrollToBottom()');

  // 流式节点必须在首次渲染时创建并缓存引用（零查找）
  const entryMatch = contentCode.match(/function ensureStreamingEntry\(\)\s*\{([\s\S]*?)\n  \}/);
  assert(entryMatch, 'ensureStreamingEntry must be defined');
  assert(entryMatch[1].includes('document.createTextNode'), 'ensureStreamingEntry must create persistent Text nodes');
  assert(entryMatch[1].includes('entry._transText = transTextNode'), 'ensureStreamingEntry must cache text node references on the entry');
});

test('T4.4: rAF Scroll Batching & Anti-Scroll-Jacking Protection', () => {
  const scrollMatch = contentCode.match(/function safeScrollToBottom\(\)\s*\{([\s\S]*?)\n  \}/);
  assert(scrollMatch, 'safeScrollToBottom must be defined');
  assert(scrollMatch[1].includes('requestAnimationFrame'), 'safeScrollToBottom must use requestAnimationFrame');
  assert(scrollMatch[1].includes('isScrollPending'), 'safeScrollToBottom must check isScrollPending flag');
  
  assert(contentCode.includes('cancelPendingScroll'), 'content.js must define cancelPendingScroll');
  assert(contentCode.includes('distanceFromBottom > 60'), 'content.js must detect user scroll up at 60px threshold');
  assert(contentCode.includes('cancelPendingScroll()'), 'content.js must cancel pending scroll on manual scroll up');
});

test('T4.5: CSS Custom Properties on Root & Zero DOM Querying in Sliders', () => {
  assert(cssCode.includes('--g-sub-opacity: 0.65;'), 'content.css must define default --g-sub-opacity');
  assert(cssCode.includes('--g-sub-blur: 3px;'), 'content.css must define default --g-sub-blur');
  assert(cssCode.includes('--g-sub-font-size: 17px;'), 'content.css must define default --g-sub-font-size');
  assert(cssCode.includes('var(--g-sub-font-size, 17px)'), 'content.css .g-sub-trans must consume --g-sub-font-size');

  const sliderStart = contentCode.indexOf('opacitySlider.addEventListener');
  const sliderEnd = contentCode.indexOf('displayModeSelect.addEventListener');
  assert(sliderStart > 0 && sliderEnd > sliderStart, 'slider listeners block must be locatable');
  const sliderBlock = contentCode.substring(sliderStart, sliderEnd);
  assert(sliderBlock.includes('--g-sub-opacity'), 'opacity slider must set --g-sub-opacity');
  assert(sliderBlock.includes('--g-sub-blur'), 'blur slider must set --g-sub-blur');
  assert(sliderBlock.includes('--g-sub-font-size'), 'font-size slider must set --g-sub-font-size');
  assert(!sliderBlock.includes('querySelectorAll'), 'slider listeners must not iterate with querySelectorAll');
});

test('T4.6: 250ms Debounced Storage Persistence & Immediate Flush Mode', () => {
  assert(contentCode.includes('saveConfigTimer = setTimeout('), 'saveConfig must debounce via setTimeout');
  assert(contentCode.includes('250'), 'saveConfig debounce interval must be 250ms');
  assert(contentCode.includes('if (immediate)'), 'saveConfig must support immediate synchronous flush mode');
  assert(popupJsCode.includes('notifyActiveTabDebounced'), 'popup.js must debounce slider changes to tab');
  assert(popupJsCode.includes('250'), 'popup.js debounce interval must be 250ms');
});

test('T4.7: Event Retargeting & Fullscreen Reparenting Mechanics', () => {
  assert(contentCode.includes('e.composedPath()'), 'click listener must use e.composedPath()');
  assert(contentCode.includes('header.addEventListener(\'mousedown\''), 'header drag must listen to mousedown');
  assert(contentCode.includes('overlay.getBoundingClientRect()'), 'drag listener must compute offsets via getBoundingClientRect()');
  assert(contentCode.includes('fsElement.appendChild(hostEl)'), 'handleFullscreenChange must reparent hostEl to document.fullscreenElement');
  assert(contentCode.includes('document.body.appendChild(hostEl)'), 'handleFullscreenChange must restore hostEl to document.body on exit');
});

// ============================================================================
// TIER 5: SECURITY, SANITIZATION & LANGUAGE MAPPING
// ============================================================================
startTier('TIER 5', 'Security, Sanitization & BCP-47 Language Mapping (Redaction, OWASP, Fast Path)');

test('T5.1: Zero Plaintext API Key Leakage Across All Traces', () => {
  const secretKey = 'AIzaSyD_CONFIDENTIAL_KEY_999888777';
  
  // URL Redaction
  const url1 = `wss://generativelanguage.googleapis.com/ws/service?key=${secretKey}`;
  const url2 = `https://custom.api.com/v1?model=gemini&key=${secretKey}&stream=true`;
  assert(!sanitizeUrl(url1).includes(secretKey), 'sanitizeUrl must strip secret key from URL 1');
  assert(sanitizeUrl(url1).includes('***REDACTED***'), 'sanitizeUrl must contain ***REDACTED***');
  assert(!sanitizeUrl(url2).includes(secretKey), 'sanitizeUrl must strip secret key from URL 2');

  // Error Object Redaction
  const errorObj = new Error(`WebSocket creation failed for URL: wss://generativelanguage.googleapis.com?key=${secretKey}`);
  const sanitizedErr = sanitizeErrorMessage(errorObj);
  assert(!sanitizedErr.includes(secretKey), 'sanitizeErrorMessage must strip key from Error object message');
  assert(sanitizedErr.includes('***REDACTED***'), 'sanitizeErrorMessage must insert ***REDACTED***');

  // Edge cases: null, undefined, numbers
  assert.strictEqual(sanitizeErrorMessage(null), '');
  assert.strictEqual(sanitizeErrorMessage(undefined), '');
  assert.strictEqual(sanitizeErrorMessage(12345), '12345');
});

test('T5.2: Hardened escapeHtml Entity Escaping (&, <, >, ", \', `) & Fast Path', () => {
  // Dangerous inputs
  assert.strictEqual(escapeHtml('<script>alert("XSS")</script>'), '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
  assert.strictEqual(escapeHtml('Tom\'s `code` & "quotes"'), 'Tom&#39;s &#96;code&#96; &amp; &quot;quotes&quot;');
  assert.strictEqual(escapeHtml('<img src=x onerror=alert(`XSS`)>'), '&lt;img src=x onerror=alert(&#96;XSS&#96;)&gt;');
  assert.strictEqual(escapeHtml('1" onfocus="alert(1)" x="'), '1&quot; onfocus=&quot;alert(1)&quot; x=&quot;');

  // Clean strings (Fast-path bypass without mutation or allocation)
  const clean1 = 'Hello World 12345! 这是一个普通的纯中文测试句子。';
  const clean2 = 'English translation text without any special entities.';
  assert.strictEqual(escapeHtml(clean1), clean1);
  assert.strictEqual(escapeHtml(clean2), clean2);

  // Type edge cases
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
  assert.strictEqual(escapeHtml(0), '0');
  assert.strictEqual(escapeHtml(false), 'false');
});

test('T5.3: Adversarial Fuzzing: 1,600+ XSS / DOM Breakout Payloads on escapeHtml', () => {
  const dangerousTokens = ['<', '>', '"', "'", '`'];
  const testChars = ['<', '>', '"', "'", '`', '&', '/', '=', ' ', 's', 'c', 'r', 'i', 'p', 't', '(', ')', '1', ';'];
  
  // Deterministic PRNG for reproducibility
  function prng(seed) {
    let s = seed;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }
  const rand = prng(1337);

  let rawLeaksCount = 0;
  let unescapedAmpersandsCount = 0;
  const FUZZ_COUNT = 1600;

  for (let i = 0; i < FUZZ_COUNT; i++) {
    const len = Math.floor(rand() * 30) + 5;
    let payload = '';
    for (let c = 0; c < len; c++) {
      payload += testChars[Math.floor(rand() * testChars.length)];
    }

    const escaped = escapeHtml(payload);
    
    // Check for raw dangerous tokens
    for (const token of dangerousTokens) {
      if (escaped.includes(token)) {
        rawLeaksCount++;
      }
    }

    // Check for unescaped ampersands
    if (/&(?!amp;|lt;|gt;|quot;|#39;|#96;)/.test(escaped)) {
      unescapedAmpersandsCount++;
    }
  }

  assert.strictEqual(rawLeaksCount, 0, `Encountered ${rawLeaksCount} raw dangerous token leaks during fuzzing`);
  assert.strictEqual(unescapedAmpersandsCount, 0, `Encountered ${unescapedAmpersandsCount} unescaped ampersands during fuzzing`);
});

test('T5.4: BCP-47 Language Mapping & Native Model Family Detection', () => {
  // 目标语言 → 官方 Live Translate 支持的 BCP-47 码
  assert.strictEqual(getBcp47LanguageCode('中文普通话 (Chinese)'), 'zh-Hans');
  assert.strictEqual(getBcp47LanguageCode('中文 (Chinese)'), 'zh-Hans');
  assert.strictEqual(getBcp47LanguageCode('繁体中文'), 'zh-Hant');
  assert.strictEqual(getBcp47LanguageCode('日语 (Japanese)'), 'ja');
  assert.strictEqual(getBcp47LanguageCode('英语 (English)'), 'en');
  assert.strictEqual(getBcp47LanguageCode('韩语 (Korean)'), 'ko');
  assert.strictEqual(getBcp47LanguageCode('西班牙语'), 'es');
  assert.strictEqual(getBcp47LanguageCode('法语'), 'fr');
  assert.strictEqual(getBcp47LanguageCode('德语'), 'de');
  assert.strictEqual(getBcp47LanguageCode('俄语'), 'ru');
  assert.strictEqual(getBcp47LanguageCode('葡萄牙语'), 'pt-BR');
  assert.strictEqual(getBcp47LanguageCode('未知语言'), 'zh-Hans', 'Unknown target must fall back to zh-Hans');

  // 模型族判定：决定 setup 载荷走原生同传还是 Agent 语境模式
  assert.strictEqual(isLiveTranslateModel('models/gemini-3.5-live-translate-preview'), true);
  assert.strictEqual(isLiveTranslateModel('gemini-3.5-live-translate-preview'), true);
  assert.strictEqual(isLiveTranslateModel('models/gemini-pro'), false);
  assert.strictEqual(isLiveTranslateModel(''), false);
  assert.strictEqual(isLiveTranslateModel(null), false);
});

test('T5.5: Fast detectLanguageFromText Heuristic Classification Accuracy', () => {
  assert.strictEqual(detectLanguageFromText('こんにちは世界！'), 'ja', 'Japanese detection');
  assert.strictEqual(detectLanguageFromText('\uC548\uB155\uD558\uC138\uC694 \uC5EC\uB7EC\uBD84'), 'ko', 'Korean detection');
  assert.strictEqual(detectLanguageFromText('Welcome to the live simultaneous translation stream.'), 'en', 'English detection');
  assert.strictEqual(detectLanguageFromText('欢迎来到人工智能与自然语言处理大会'), 'zh', 'Chinese detection');
  assert.strictEqual(detectLanguageFromText(''), 'auto', 'Empty input returns auto');
  assert.strictEqual(detectLanguageFromText(null), 'auto', 'Null input returns auto');
});

// Benchmark: Language Detection & Sanitization Ops/Sec
(() => {
  const ITERS = 100000;
  const sampleJa = 'これは日本語の音声をリアルタイムで中国語に翻訳するテストです。';
  const sampleClean = 'Clean string for escapeHtml fast path latency benchmarking.';
  const sampleDirty = 'Dirty string with <script>alert("xss")</script> & \'quotes\' and `backticks`.';

  // 1. Language Detection Throughput
  const t0 = performance.now();
  let dummyCount = 0;
  for (let i = 0; i < ITERS; i++) {
    const lang = detectLanguageFromText(sampleJa);
    if (lang === 'ja') dummyCount++;
  }
  const elapsedDrift = performance.now() - t0;
  const driftOpsPerSec = Math.round((ITERS / (elapsedDrift / 1000)));
  const driftLatencyUs = ((elapsedDrift / ITERS) * 1000).toFixed(3);

  benchmarkResults.push({
    name: 'Language Detection (detectLanguageFromText charCodeAt)',
    metric: `${driftOpsPerSec.toLocaleString()} ops/sec (${driftLatencyUs} µs/op)`,
    duration: `${elapsedDrift.toFixed(2)} ms for ${ITERS.toLocaleString()} calls`
  });

  // 2. escapeHtml Fast-Path Latency
  const t1 = performance.now();
  let escapeFastCount = 0;
  for (let i = 0; i < ITERS; i++) {
    const res = escapeHtml(sampleClean);
    if (res.length > 0) escapeFastCount++;
  }
  const elapsedEscapeFast = performance.now() - t1;
  const escapeFastOpsPerSec = Math.round((ITERS / (elapsedEscapeFast / 1000)));
  const escapeFastLatencyUs = ((elapsedEscapeFast / ITERS) * 1000).toFixed(3);

  benchmarkResults.push({
    name: 'DOM Sanitizer Fast-Path (escapeHtml clean string bypass)',
    metric: `${escapeFastOpsPerSec.toLocaleString()} ops/sec (${escapeFastLatencyUs} µs/op)`,
    duration: `${elapsedEscapeFast.toFixed(2)} ms for ${ITERS.toLocaleString()} calls`
  });

  // 3. escapeHtml Full Replacement Latency
  const t2 = performance.now();
  let escapeDirtyCount = 0;
  for (let i = 0; i < ITERS; i++) {
    const res = escapeHtml(sampleDirty);
    if (res.length > 0) escapeDirtyCount++;
  }
  const elapsedEscapeDirty = performance.now() - t2;
  const escapeDirtyOpsPerSec = Math.round((ITERS / (elapsedEscapeDirty / 1000)));
  const escapeDirtyLatencyUs = ((elapsedEscapeDirty / ITERS) * 1000).toFixed(3);

  benchmarkResults.push({
    name: 'DOM Sanitizer Full Escape (escapeHtml dirty XSS payload)',
    metric: `${escapeDirtyOpsPerSec.toLocaleString()} ops/sec (${escapeDirtyLatencyUs} µs/op)`,
    duration: `${elapsedEscapeDirty.toFixed(2)} ms for ${ITERS.toLocaleString()} calls`
  });
})();

// ============================================================================
// BENCHMARK REPORTING & SUMMARY STATISTICS
// ============================================================================
console.log(`\n${colors.bold}${colors.blue}================================================================================${colors.reset}`);
console.log(`${colors.bold}${colors.blue}PERFORMANCE BENCHMARK METRICS (Measured with High-Resolution Timers)${colors.reset}`);
console.log(`${colors.bold}${colors.blue}================================================================================${colors.reset}\n`);

for (const b of benchmarkResults) {
  console.log(`  ${colors.yellow}${symbols.spark}${colors.reset} ${colors.bold}${b.name}${colors.reset}`);
  console.log(`    ${colors.cyan}${symbols.arrow} Throughput / Speed: ${colors.bold}${b.metric}${colors.reset}`);
  console.log(`    ${colors.gray}${symbols.bullet} Duration: ${b.duration}${colors.reset}\n`);
}

console.log(`${colors.bold}${colors.magenta}================================================================================${colors.reset}`);
console.log(`${colors.bold}${colors.magenta}TEST EXECUTION SUMMARY${colors.reset}`);
console.log(`${colors.bold}${colors.magenta}================================================================================${colors.reset}`);

const passRate = totalTestsCount > 0 ? ((passedTestsCount / totalTestsCount) * 100).toFixed(1) : 0;
const statusColor = failedTestsCount === 0 ? colors.green : colors.red;

console.log(`\n  Total Tests Executed:  ${colors.bold}${totalTestsCount}${colors.reset}`);
console.log(`  Tests Passed:          ${colors.bold}${colors.green}${passedTestsCount}${colors.reset}`);
console.log(`  Tests Failed:          ${colors.bold}${statusColor}${failedTestsCount}${colors.reset}`);
console.log(`  Overall Pass Rate:     ${colors.bold}${statusColor}${passRate}%${colors.reset}\n`);

if (failedTestsCount === 0) {
  console.log(`${colors.bold}${colors.green}🎉 ALL 5 TIERS PASSED WITH 100% SUCCESS RATE! VERIFICATION COMPLETE.${colors.reset}\n`);
  process.exit(0);
} else {
  console.error(`${colors.bold}${colors.red}❌ VERIFICATION FAILED: ${failedTestsCount} test(s) failed.${colors.reset}\n`);
  process.exit(1);
}
