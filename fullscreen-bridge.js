/**
 * Gemini Live Translator - Fullscreen Bridge
 * Executed in the webpage MAIN world context at document_start to monkey-patch
 * Element.prototype.requestFullscreen and exitFullscreen methods.
 * Intercepts fullscreen requests and coordinates with the content script overlay,
 * ensuring YouTube and arbitrary video players enter native display fullscreen
 * without falling back to browser window/theater mode.
 */
(() => {
  if (window.__geminiLiveFullscreenBridgeInstalled) return;
  window.__geminiLiveFullscreenBridgeInstalled = true;

  const REQUEST_TYPE = 'gemini-live:fullscreen-request';
  const READY_TYPE = 'gemini-live:fullscreen-ready';
  const WAIT_MS = 600;
  let seq = 0;

  function waitForReady(id, action) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onReady, true);
        resolve();
      };
      const onReady = (event) => {
        const data = event.data;
        if (!data || data.type !== READY_TYPE || data.id !== id) return;
        finish();
      };

      window.addEventListener('message', onReady, true);
      window.postMessage({ type: REQUEST_TYPE, id, action }, '*');
      setTimeout(finish, WAIT_MS);
    });
  }

  function patch(proto, name, returnsPromise, action) {
    const original = proto && proto[name];
    if (typeof original !== 'function' || original.__geminiLivePatched) return;

    const patched = function(...args) {
      const target = this;
      const id = String(++seq);
      const run = () => original.apply(target, args);
      if (returnsPromise) return waitForReady(id, action).then(run);
      waitForReady(id, action).then(run);
      return undefined;
    };

    patched.__geminiLivePatched = true;
    patched.__geminiLiveOriginal = original;

    try {
      Object.defineProperty(proto, name, { value: patched, configurable: true, writable: true });
    } catch {
      proto[name] = patched;
    }
  }

  patch(Element.prototype, 'requestFullscreen', true, 'enter');
  patch(Element.prototype, 'webkitRequestFullscreen', false, 'enter');
  patch(Element.prototype, 'mozRequestFullScreen', false, 'enter');
  patch(Element.prototype, 'msRequestFullscreen', false, 'enter');
  patch(Document.prototype, 'exitFullscreen', true, 'exit');
  patch(Document.prototype, 'webkitExitFullscreen', false, 'exit');
  patch(Document.prototype, 'mozCancelFullScreen', false, 'exit');
  patch(Document.prototype, 'msExitFullscreen', false, 'exit');
})();
