(function (global) {
  'use strict';

  function detect() {
    var isSecure =
      typeof window !== 'undefined' &&
      (window.isSecureContext === true ||
        location.protocol === 'https:' ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1' ||
        location.protocol === 'file:');

    var nav = global.navigator || {};
    var mediaDevices = nav.mediaDevices || null;

    var env = {
      secureContext: isSecure,
      mediaDevicesSupported: !!mediaDevices && typeof mediaDevices.getUserMedia === 'function',
      enumerateSupported: !!mediaDevices && typeof mediaDevices.enumerateDevices === 'function',
      permissionsSupported: !!nav.permissions && typeof nav.permissions.query === 'function',
      indexeddbSupported: typeof global.indexedDB !== 'undefined',
      canvasSupported: (function () {
        if (typeof document === 'undefined') return false;
        var c = document.createElement('canvas');
        return !!(c.getContext && c.getContext('2d'));
      })(),
      capabilitiesSupported:
        !!mediaDevices &&
        typeof mediaDevices.getSupportedConstraints === 'function' &&
        typeof (global.MediaStreamTrack || {}).getCapabilities === 'function'
    };

    env.fullySupported = env.secureContext && env.mediaDevicesSupported;
    return env;
  }

  global.App = global.App || {};
  global.App.env = detect();
})(window);
