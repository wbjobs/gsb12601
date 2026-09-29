(function (global) {
  'use strict';

  var App = global.App || {};
  var nav = global.navigator || {};

  var LABELS = {
    granted: '已授权',
    prompt: '待询问',
    denied: '已拒绝',
    active: '使用中',
    unsupported: '无法检测'
  };

  var DETAILS = {
    granted: '权限已授予，尚未开始推流。',
    prompt: '尚未询问；需要在你点击按钮后才会弹出系统授权框。',
    denied: '权限被拒绝。可在浏览器站点设置中重置，或使用文件上传降级。',
    active: '轨道正在推流。',
    unsupported: '当前浏览器不支持 Permissions API 查询，状态以实际调用结果为准。'
  };

  function PermissionTracker(mediaManager) {
    this.media = mediaManager;
    this.states = { video: 'prompt', audio: 'prompt' };
    // query 返回的基础状态
    this.baseStates = { video: null, audio: null };
    // getUserMedia 实际结果的覆盖状态（更可靠）
    this.overrides = { video: null, audio: null };
    this.supported = !!(nav.permissions && nav.permissions.query);
    this.listeners = [];
    this._boundEmit = this._emit.bind(this);
  }

  PermissionTracker.prototype.onChange = function (fn) {
    this.listeners.push(fn);
  };

  PermissionTracker.prototype._emit = function (kind) {
    var state = this.states[kind];
    this.listeners.forEach(function (fn) {
      try { fn(kind, state); } catch (e) { /* 监听器异常不影响主流程 */ }
    });
  };

  PermissionTracker.prototype._recompute = function (kind) {
    var track = this.media && this.media.getActiveTracks ? this.media.getActiveTracks()[kind] : null;
    // 轨道处于 live 即视为使用中；muted（被系统静默/抢占）仍有活动轨道，
    // 占用提示由 track 的 mute 事件单独发出
    if (track && track.readyState === 'live') {
      this.states[kind] = 'active';
    } else if (this.overrides[kind]) {
      this.states[kind] = this.overrides[kind];
    } else if (this.baseStates[kind]) {
      this.states[kind] = this.baseStates[kind];
    } else if (!this.supported) {
      this.states[kind] = 'unsupported';
    } else {
      this.states[kind] = 'prompt';
    }
  };

  PermissionTracker.prototype.refreshAll = function () {
    var self = this;
    return Promise.all([this.query('video'), this.query('audio')]).then(function () {
      self.syncFromTracks();
    });
  };

  PermissionTracker.prototype.query = function (kind) {
    var self = this;
    if (!this.supported) {
      this._recompute(kind);
      this._emit(kind);
      return Promise.resolve(this.states[kind]);
    }
    var descriptor = kind === 'video' ? { name: 'camera' } : { name: 'microphone' };
    return nav.permissions.query(descriptor).then(
      function (status) {
        self.baseStates[kind] = status.state;
        status.onchange = function () {
          self.baseStates[kind] = status.state;
          // 用户在系统层面改了授权，清掉旧的调用结果覆盖
          self.overrides[kind] = null;
          self._recompute(kind);
          self._emit(kind);
        };
        self._recompute(kind);
        self._emit(kind);
        return self.states[kind];
      },
      function () {
        // 某些浏览器（如部分 Firefox）查询 camera/microphone 会抛错
        self.baseStates[kind] = null;
        self._recompute(kind);
        self._emit(kind);
        return self.states[kind];
      }
    );
  };

  PermissionTracker.prototype.noteGranted = function (kind) {
    this.overrides[kind] = 'granted';
    this._recompute(kind);
    this._emit(kind);
  };

  PermissionTracker.prototype.noteDenied = function (kind) {
    this.overrides[kind] = 'denied';
    this._recompute(kind);
    this._emit(kind);
  };

  PermissionTracker.prototype.syncFromTracks = function () {
    var self = this;
    ['video', 'audio'].forEach(function (kind) {
      self._recompute(kind);
      self._emit(kind);
    });
  };

  PermissionTracker.LABELS = LABELS;
  PermissionTracker.DETAILS = DETAILS;

  App.PermissionTracker = PermissionTracker;
  global.App = App;
})(window);
