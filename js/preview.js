(function (global) {
  'use strict';

  var App = global.App || {};

  function PreviewController(video, overlay, meterCanvas, options) {
    this.video = video;
    this.overlay = overlay;
    this.canvas = meterCanvas;
    this.ctx = meterCanvas.getContext('2d');
    this.env = options.env;
    this.audioCtx = null;
    this.analyser = null;
    this.meterSource = null;
    this.meterStream = null;
    this.rafId = null;
    this.lastSnapshotUrl = null;
    this.lastSnapshotBlob = null;
    this._drawMeter([]);
  }

  PreviewController.prototype.setStream = function (stream) {
    var self = this;
    if ('srcObject' in this.video) {
      this.video.srcObject = stream;
    } else {
      this.video.src = global.URL.createObjectURL(stream);
    }

    var hasVideo = stream.getVideoTracks().some(function (t) { return t.readyState !== 'ended'; });
    var hasAudio = stream.getAudioTracks().some(function (t) { return t.readyState !== 'ended'; });

    if (hasVideo) {
      this.overlay.hidden = true;
      this.video.play().catch(function () {
        // 自动播放策略：静音视频一般可自动播放；失败时引导用户点击画面
        self.showOverlay('点击画面开始播放', '浏览器阻止了自动播放，请点击视频区域。');
      });
    } else if (hasAudio) {
      this.showOverlay('仅麦克风工作中', '没有视频轨道。视频元素已静音，不会回放麦克风声音；下方音量表显示输入电平。');
    } else {
      this.showOverlay('未启动任何设备', '点击“申请权限”后在此显示预览。页面加载时不会主动调用摄像头。');
    }

    this._setupMeter(stream);
  };

  // 点击画面可恢复被自动播放策略拦截的播放（同时作为创建 AudioContext 的用户手势）
  PreviewController.prototype.bindUserGesture = function () {
    var self = this;
    this.video.addEventListener('click', function () {
      self.video.play().catch(function () {});
      if (self.audioCtx && self.audioCtx.state === 'suspended') {
        self.audioCtx.resume().catch(function () {});
      }
    });
  };

  PreviewController.prototype.showOverlay = function (title, body) {
    this.overlay.hidden = false;
    this.overlay.innerHTML = '';
    var p1 = document.createElement('p');
    p1.textContent = title;
    var p2 = document.createElement('p');
    p2.className = 'hint';
    p2.textContent = body || '';
    this.overlay.appendChild(p1);
    this.overlay.appendChild(p2);
  };

  PreviewController.prototype._setupMeter = function (stream) {
    var self = this;
    var audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      this._teardownMeter();
      this._drawMeter([]);
      return;
    }
    // 音量表：仅连接到 AnalyserNode，不连接扬声器，避免自激/回声
    try {
      if (!this.audioCtx) {
        var Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return;
        this.audioCtx = new Ctx();
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(function () {});
      if (this.meterSource) {
        try { this.meterSource.disconnect(); } catch (e) { /* 忽略 */ }
      }
      this.meterStream = stream;
      this.meterSource = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.meterSource.connect(this.analyser);

      var data = new Uint8Array(this.analyser.frequencyBinCount);
      var loop = function () {
        if (!self.analyser) return;
        self.analyser.getByteFrequencyData(data);
        self._drawMeter(data);
        self.rafId = global.requestAnimationFrame(loop);
      };
      if (this.rafId) global.cancelAnimationFrame(this.rafId);
      loop();
    } catch (e) {
      // 音频分析失败不应影响视频预览
      this._drawMeter([]);
    }
  };

  PreviewController.prototype._teardownMeter = function () {
    if (this.rafId) {
      global.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.meterSource) {
      try { this.meterSource.disconnect(); } catch (e) { /* 忽略 */ }
      this.meterSource = null;
    }
    this.analyser = null;
  };

  PreviewController.prototype._drawMeter = function (data) {
    var canvas = this.canvas;
    var ctx = this.ctx;
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f1420';
    ctx.fillRect(0, 0, w, h);

    if (!data.length) {
      ctx.fillStyle = '#9aa7bd';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('无活动麦克风', 10, 18);
      return;
    }

    var bars = 48;
    var step = Math.floor(data.length / bars) || 1;
    var barWidth = w / bars - 2;
    for (var i = 0; i < bars; i++) {
      var v = data[i * step] / 255;
      var barHeight = Math.max(2, v * (h - 4));
      var x = i * (barWidth + 2) + 1;
      var y = h - barHeight - 2;
      ctx.fillStyle = v > 0.85 ? '#ff5d6c' : v > 0.6 ? '#f5a623' : '#3ecf8e';
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  };

  // 用 Canvas 抓帧；不依赖轨道的 PhotoCapabilities
  PreviewController.prototype.snapshot = function () {
    var video = this.video;
    if (!this.env.canvasSupported) {
      return Promise.reject(new Error('当前环境不支持 Canvas'));
    }
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (!vw || !vh) {
      return Promise.reject(new Error('视频尚未就绪，无法拍照'));
    }
    var canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = vh;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, vw, vh);

    if (this.lastSnapshotUrl) global.URL.revokeObjectURL(this.lastSnapshotUrl);

    var self = this;
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error('生成图片失败'));
          return;
        }
        self.lastSnapshotBlob = blob;
        self.lastSnapshotUrl = global.URL.createObjectURL(blob);
        resolve({ url: self.lastSnapshotUrl, blob: blob, width: vw, height: vh });
      }, 'image/png');
    });
  };

  PreviewController.prototype.consumeSnapshotBlob = function () {
    var blob = this.lastSnapshotBlob;
    this.lastSnapshotBlob = null;
    return blob;
  };

  PreviewController.prototype.clearSnapshot = function () {
    if (this.lastSnapshotUrl) {
      global.URL.revokeObjectURL(this.lastSnapshotUrl);
      this.lastSnapshotUrl = null;
    }
    this.lastSnapshotBlob = null;
  };

  App.PreviewController = PreviewController;
  global.App = App;
})(window);
