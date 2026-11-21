/**
 * Gemini Live Translator - Page-World SPA Navigation Hook (MAIN world)
 * Dispatches 'glt-spa-navigate' when page scripts call history.pushState/replaceState.
 */
(function () {
  'use strict';
  if (window.__gltMainSpaHooked) return;
  window.__gltMainSpaHooked = true;

  function notifyRouteChange(source) {
    try {
      window.dispatchEvent(new CustomEvent('glt-spa-navigate', {
        detail: {
          source: source,
          href: (window.location && window.location.href) ? String(window.location.href) : ''
        }
      }));
    } catch (e) {}
  }

  try {
    const proto = (typeof History !== 'undefined' && History.prototype) ? History.prototype : window.history;
    if (proto && typeof proto.pushState === 'function') {
      const origPush = proto.pushState;
      proto.pushState = function () {
        const ret = origPush.apply(this, arguments);
        notifyRouteChange('pushState');
        return ret;
      };
    }
    if (proto && typeof proto.replaceState === 'function') {
      const origReplace = proto.replaceState;
      proto.replaceState = function () {
        const ret = origReplace.apply(this, arguments);
        notifyRouteChange('replaceState');
        return ret;
      };
    }
  } catch (e) {}
})();
