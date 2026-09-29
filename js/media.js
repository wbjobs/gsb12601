(function (global) {
  'use strict';

  var App = global.App || {};
  var mediaDevices = (global.navigator && global.navigator.mediaDevices) || null;

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // 轻量事件发射器：不依赖 EventTarget 构造（原型继承方式在部分环境会抛
  // Illegal invocation），同时保持 addEventListener / removeEventListener 接口
  function Emitter() { this._listeners = {}; }
  Emitter.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  Emitter.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type];
    if (!list) return;
    this._listeners[type] = list.filter(function (f) { return f !== fn; });
  };
  Emitter.prototype.dispatchEvent = function (event) {
    var list = this._listeners[event.type] || [];
    list.slice().forEach(function (fn) {
      try { fn.call(this, event); } catch (e) { /* 单个监听器异常不影响其他监听器 */ }
    }, this);
    return !(event.defaultPrevented === true);
  };

  function MediaManager() {
    Emitter.call(this);
    // 每类各自维护：当前活动轨道、当前设备、约束、切换前快照
    this.kinds = {
      video: { track: null, deviceId: null, label: '', constraints: { width: 1280, height: 720 }, pending: false },
      audio: { track: null, deviceId: null, label: '', constraints: { echoCancellation: true, noiseSuppression: true }, pending: false }
    };
    this.stream = new MediaStream();
    this.devices = [];
  }

  MediaManager.prototype = Object.create(Emitter.prototype);
  MediaManager.prototype.constructor = MediaManager;

  MediaManager.prototype._fire = function (type, detail) {
    this.dispatchEvent({ type: type, detail: detail || {} });
  };

  MediaManager.prototype.getActiveTracks = function () {
    return {
      video: this.kinds.video.track,
      audio: this.kinds.audio.track
    };
  };

  MediaManager.prototype.getState = function (kind) {
    var k = this.kinds[kind];
    var track = k.track;
    if (!track) return 'idle';
    if (track.readyState === 'ended') return 'ended';
    return track.muted ? 'muted' : 'live';
  };

  MediaManager.prototype.getCurrentDevice = function (kind) {
    var k = this.kinds[kind];
    return { deviceId: k.deviceId, label: k.label };
  };

  MediaManager.prototype.getSettings = function (kind) {
    var track = this.kinds[kind].track;
    return track && track.getSettings ? track.getSettings() : null;
  };

  MediaManager.prototype.getCapabilities = function (kind) {
    var track = this.kinds[kind].track;
    return track && track.getCapabilities ? track.getCapabilities() : null;
  };

  // 授权前 label 为空、group 信息也有限，所以 UI 必须区分“授权前/后”两次枚举
  MediaManager.prototype.enumerate = function () {
    var self = this;
    if (!mediaDevices || !mediaDevices.enumerateDevices) {
      return Promise.reject(App.Errors.normalize({ name: 'NotSupportedError', message: '不支持 enumerateDevices' }));
    }
    return mediaDevices.enumerateDevices().then(function (devices) {
      self.devices = devices.map(function (d) {
        return {
          deviceId: d.deviceId,
          kind: d.kind,
          label: d.label,
          groupId: d.groupId
        };
      });
      self._fire('deviceschanged', { devices: self.devices });
      return self.devices;
    });
  };

  // 只调用底层 getUserMedia，不改动任何现有轨道
  MediaManager.prototype._acquire = function (kind, constraints) {
    if (!App.env.secureContext) {
      return Promise.reject(
        App.Errors.normalize({ name: 'NotSupportedError', message: '非安全上下文中无法调用 getUserMedia' })
      );
    }
    if (!mediaDevices || !mediaDevices.getUserMedia) {
      return Promise.reject(
        App.Errors.normalize({ name: 'NotSupportedError', message: '当前浏览器不支持 MediaDevices API' })
      );
    }
    var request = kind === 'video' ? { video: constraints, audio: false } : { audio: constraints, video: false };
    return mediaDevices.getUserMedia(request).then(
      function (stream) {
        var tracks = stream.getTracks();
        if (!tracks.length) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          throw App.Errors.normalize({ name: 'NotFoundError', message: '未返回任何轨道' });
        }
        return { stream: stream, track: tracks[0] };
      },
      function (err) {
        throw App.Errors.normalize(err);
      }
    );
  };

  MediaManager.prototype._attach = function (kind, track, stream) {
    var k = this.kinds[kind];
    var oldTrack = k.track;

    if (oldTrack) {
      try { this.stream.removeTrack(oldTrack); } catch (e) { /* 已移除时忽略 */ }
      oldTrack.stop();
      this._unwireTrack(kind, oldTrack);
    }

    k.track = track;
    this.stream.addTrack(track);

    var settings = track.getSettings ? track.getSettings() : {};
    k.deviceId = settings.deviceId || (stream && stream.id) || null;
    k.label = track.label || '';

    this._wireTrack(kind, track);
    this._fire('trackchanged', { kind: kind });
    this._fire('streamchanged', { stream: this.stream });
  };

  MediaManager.prototype._wireTrack = function (kind, track) {
    var self = this;
    track.addEventListener('ended', function () {
      self._fire('trackended', { kind: kind });
    });
    track.addEventListener('mute', function () {
      self._fire('trackmuted', { kind: kind, reason: '设备可能已被其他程序占用或系统暂停了轨道' });
    });
    track.addEventListener('unmute', function () {
      self._fire('trackunmuted', { kind: kind });
    });
  };

  MediaManager.prototype._unwireTrack = function (kind, track) {
    // 监听器是匿名函数，无法精确移除；track.stop() 后会被 GC，这里不保留引用即可
  };

  // 首次请求 / 重新授权。失败时保留现状（首次请求本来就没有现状）
  MediaManager.prototype.request = function (kind, constraints) {
    var self = this;
    var k = this.kinds[kind];
    if (k.pending) return Promise.reject(App.Errors.normalize({ name: 'AbortError', message: '上一次切换尚未完成' }));
    k.pending = true;

    var merged = Object.assign({}, clone(k.constraints), constraints || {});
    return this._acquire(kind, merged).then(
      function (result) {
        // 立刻停止 _acquire 临时流中的轨道？不能停——它就是要接入的轨道。
        self._attach(kind, result.track, result.stream);
        k.constraints = merged;
        k.pending = false;
        self._fire('requestsuccess', { kind: kind });
        return self.kinds[kind];
      },
      function (normalized) {
        k.pending = false;
        self._fire('requesterror', { kind: kind, error: normalized });
        throw normalized;
      }
    );
  };

  // 切换设备：失败必须回退到上一个设备
  MediaManager.prototype.switchDevice = function (kind, deviceId, constraints) {
    var self = this;
    var k = this.kinds[kind];
    if (k.pending) {
      return Promise.reject(App.Errors.normalize({ name: 'AbortError', message: '上一次切换尚未完成，请稍候' }));
    }
    if (!deviceId) {
      return Promise.reject(App.Errors.normalize({ name: 'NotFoundError', message: '未选择设备' }));
    }

    // 保存回退快照
    var snapshot = {
      track: k.track,
      deviceId: k.deviceId,
      label: k.label,
      constraints: clone(k.constraints)
    };

    k.pending = true;
    var nextConstraints = Object.assign({}, clone(k.constraints), constraints || {}, {
      deviceId: { exact: deviceId }
    });

    return this._acquire(kind, nextConstraints).then(
      function (result) {
        // 新轨道到手后再撤掉旧轨道，避免预览中断闪烁过久
        self._attach(kind, result.track, result.stream);
        k.constraints = Object.assign({}, k.constraints, constraints || {}, { deviceId: deviceId });
        k.pending = false;
        self._fire('switchsuccess', { kind: kind, deviceId: deviceId });
        return self.kinds[kind];
      },
      function (normalized) {
        k.pending = false;
        // 回退：_attach 只在成功后执行，因此旧轨道仍然挂着；这里恢复约束快照
        k.deviceId = snapshot.deviceId;
        k.label = snapshot.label;
        k.constraints = snapshot.constraints;
        self._fire('switchfailed', { kind: kind, error: normalized, fallbackTo: snapshot.deviceId });
        throw normalized;
      }
    );
  };

  // 在同一设备上尝试新约束（如分辨率）；失败保持原样
  MediaManager.prototype.applyConstraints = function (kind, constraints) {
    var self = this;
    var k = this.kinds[kind];
    if (!k.track) {
      return Promise.reject(App.Errors.normalize({ name: 'AbortError', message: '该类型当前没有活动轨道' }));
    }
    if (k.pending) {
      return Promise.reject(App.Errors.normalize({ name: 'AbortError', message: '上一次操作尚未完成' }));
    }
    var prev = clone(k.constraints);
    k.pending = true;
    var next = Object.assign({}, clone(k.constraints), constraints || {});
    var deviceConstraint = k.deviceId ? { deviceId: { exact: k.deviceId } } : {};
    var trackConstraints = Object.assign({}, next, deviceConstraint);

    return Promise.resolve().then(function () {
      if (k.track.applyConstraints) {
        return k.track.applyConstraints(trackConstraints);
      }
      // 回退路径：用新约束整体重新获取轨道
      return self._acquire(kind, trackConstraints).then(function (result) {
        self._attach(kind, result.track, result.stream);
      });
    }).then(
      function () {
        k.constraints = next;
        k.pending = false;
        var settings = k.track && k.track.getSettings ? k.track.getSettings() : {};
        self._fire('constraintssuccess', { kind: kind, settings: settings });
      },
      function (err) {
        k.pending = false;
        k.constraints = prev;
        var normalized = err && err.code ? err : App.Errors.normalize(err);
        self._fire('constraintsfailed', { kind: kind, error: normalized });
        throw normalized;
      }
    );
  };

  MediaManager.prototype.stop = function (kind) {
    var k = this.kinds[kind];
    if (!k.track) return;
    try { this.stream.removeTrack(k.track); } catch (e) { /* 忽略 */ }
    k.track.stop();
    k.track = null;
    k.deviceId = null;
    k.label = '';
    this._fire('trackchanged', { kind: kind });
    this._fire('streamchanged', { stream: this.stream });
  };

  MediaManager.prototype.stopAll = function () {
    this.stop('video');
    this.stop('audio');
  };

  App.MediaManager = MediaManager;
  global.App = App;
})(window);
