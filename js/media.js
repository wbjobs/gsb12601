/* 设备管理：权限、枚举、切换、错误分类 */
(function (global) {
  'use strict';

  // 统一错误码，UI 据此给出提示与降级
  var ERR = {
    DENIED: 'denied',               // 权限被拒
    NO_DEVICE: 'no-device',         // 无设备
    BUSY: 'busy',                   // 设备被占用
    OVERCONSTRAINED: 'overconstrained', // 能力不支持
    INSECURE: 'insecure-context',   // 非安全上下文
    UNSUPPORTED: 'unsupported',     // 浏览器不支持
    UNKNOWN: 'unknown'
  };

  function classifyError(err) {
    if (!err) return ERR.UNKNOWN;
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'SecurityError':
        return ERR.DENIED;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return ERR.NO_DEVICE;
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return ERR.BUSY;
      case 'OverconstrainedError':
        return ERR.OVERCONSTRAINED;
      default:
        return ERR.UNKNOWN;
    }
  }

  function checkEnvironment() {
    var hasMediaDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices;
    return {
      secureContext: typeof window !== 'undefined' && window.isSecureContext === true,
      hasMediaDevices: hasMediaDevices,
      hasGetUserMedia: hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function',
      hasEnumerateDevices: hasMediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function',
      hasPermissionsAPI: typeof navigator !== 'undefined' && !!navigator.permissions &&
        typeof navigator.permissions.query === 'function'
    };
  }

  function queryPermission(name) {
    if (!checkEnvironment().hasPermissionsAPI) return Promise.resolve('unknown');
    return navigator.permissions.query({ name: name }).then(function (status) {
      return status.state; // 'granted' | 'denied' | 'prompt'
    }).catch(function () {
      return 'unknown'; // 部分浏览器不支持 camera/microphone 权限查询
    });
  }

  function queryPermissions() {
    return Promise.all([
      queryPermission('camera'),
      queryPermission('microphone')
    ]).then(function (states) {
      return { camera: states[0], microphone: states[1] };
    });
  }

  function enumerate() {
    if (!checkEnvironment().hasEnumerateDevices) {
      return Promise.reject(new Error('enumerateDevices 不可用'));
    }
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      return {
        videoinput: devices.filter(function (d) { return d.kind === 'videoinput'; }),
        audioinput: devices.filter(function (d) { return d.kind === 'audioinput'; }),
        // 授权前 label 为空字符串，UI 需提示"授权后显示名称"
        hasLabels: devices.some(function (d) { return !!d.label; })
      };
    });
  }

  function stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (track) { track.stop(); });
  }

  function describeTrack(track) {
    if (!track) return null;
    var info = { label: track.label, kind: track.kind };
    if (typeof track.getSettings === 'function') info.settings = track.getSettings();
    if (typeof track.getCapabilities === 'function') {
      try { info.capabilities = track.getCapabilities(); } catch (e) { /* 部分平台不支持 */ }
    }
    return info;
  }

  function MediaManager() {
    this.stream = null;
    this.videoDeviceId = null;
    this.audioDeviceId = null;
  }

  // 打开/切换设备。成功返回 { stream, video, audio }；失败抛出 { code, error, rolledBack }
  MediaManager.prototype.start = function (videoDeviceId, audioDeviceId) {
    var self = this;
    var env = checkEnvironment();
    if (!env.secureContext) {
      return Promise.reject({ code: ERR.INSECURE, error: null, rolledBack: false });
    }
    if (!env.hasGetUserMedia) {
      return Promise.reject({ code: ERR.UNSUPPORTED, error: null, rolledBack: false });
    }

    var constraints = {
      video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
      audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true
    };

    var hadStream = !!this.stream;

    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      // 成功后再停掉旧流，保证切换失败时旧预览不受影响
      stopStream(self.stream);
      self.stream = stream;
      self.videoDeviceId = videoDeviceId || null;
      self.audioDeviceId = audioDeviceId || null;
      return {
        stream: stream,
        video: describeTrack(stream.getVideoTracks()[0] || null),
        audio: describeTrack(stream.getAudioTracks()[0] || null)
      };
    }).catch(function (err) {
      // 失败：旧流仍在，回退状态不变
      throw { code: classifyError(err), error: err, rolledBack: hadStream };
    });
  };

  MediaManager.prototype.stop = function () {
    stopStream(this.stream);
    this.stream = null;
  };

  global.MediaKit = {
    ERR: ERR,
    classifyError: classifyError,
    checkEnvironment: checkEnvironment,
    queryPermissions: queryPermissions,
    enumerate: enumerate,
    MediaManager: MediaManager
  };
})(window);
