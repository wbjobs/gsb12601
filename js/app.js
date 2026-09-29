/* UI  wiring：权限提示、设备列表、预览、降级 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    envList: $('env-list'),
    permCamera: $('perm-camera'),
    permMic: $('perm-microphone'),
    permHint: $('perm-hint'),
    btnRequest: $('btn-request'),
    selectCamera: $('select-camera'),
    selectMic: $('select-microphone'),
    btnRefresh: $('btn-refresh'),
    btnStop: $('btn-stop'),
    deviceError: $('device-error'),
    capVideo: $('cap-video'),
    capAudio: $('cap-audio'),
    preview: $('preview'),
    audioLevel: $('audio-level'),
    btnSnapshot: $('btn-snapshot'),
    snapshot: $('snapshot'),
    fallbackPanel: $('fallback-panel'),
    fallbackReason: $('fallback-reason'),
    fileInput: $('file-input'),
    fallbackPreview: $('fallback-preview')
  };

  var manager = new MediaKit.MediaManager();
  var audioCtx = null;
  var meterRaf = 0;

  var ERROR_TEXT = {};
  ERROR_TEXT[MediaKit.ERR.DENIED] = '权限被拒绝：请在浏览器地址栏的站点设置中允许摄像头/麦克风后重试。';
  ERROR_TEXT[MediaKit.ERR.NO_DEVICE] = '未检测到设备：请确认摄像头/麦克风已连接。';
  ERROR_TEXT[MediaKit.ERR.BUSY] = '设备被占用：可能被其他应用（如会议软件）使用，请关闭后重试。';
  ERROR_TEXT[MediaKit.ERR.OVERCONSTRAINED] = '能力不支持：所选设备不满足请求的参数。';
  ERROR_TEXT[MediaKit.ERR.INSECURE] = '非安全上下文：getUserMedia 需要 HTTPS 或 localhost。';
  ERROR_TEXT[MediaKit.ERR.UNSUPPORTED] = '当前浏览器不支持 MediaDevices API。';
  ERROR_TEXT[MediaKit.ERR.UNKNOWN] = '发生未知错误。';

  function showError(failure) {
    var text = ERROR_TEXT[failure.code] || ERROR_TEXT[MediaKit.ERR.UNKNOWN];
    if (failure.rolledBack) text += '（已回退到之前的设备）';
    els.deviceError.textContent = text;
    return text;
  }

  function clearError() {
    els.deviceError.textContent = '';
  }

  /* ---------- 环境检测 ---------- */
  function renderEnvironment() {
    var env = MediaKit.checkEnvironment();
    var items = [
      ['安全上下文（HTTPS/localhost）', env.secureContext],
      ['MediaDevices API', env.hasMediaDevices],
      ['getUserMedia', env.hasGetUserMedia],
      ['设备枚举 enumerateDevices', env.hasEnumerateDevices],
      ['Permissions API', env.hasPermissionsAPI],
      ['IndexedDB', DeviceStore.isSupported()]
    ];
    els.envList.innerHTML = '';
    items.forEach(function (pair) {
      var li = document.createElement('li');
      var badge = document.createElement('span');
      badge.className = 'badge ' + (pair[1] ? 'ok' : 'err');
      badge.textContent = pair[1] ? '支持' : '不支持';
      li.textContent = pair[0] + '：';
      li.appendChild(badge);
      els.envList.appendChild(li);
    });
    if (!env.secureContext || !env.hasGetUserMedia) {
      enterFallback(!env.secureContext
        ? ERROR_TEXT[MediaKit.ERR.INSECURE]
        : ERROR_TEXT[MediaKit.ERR.UNSUPPORTED]);
    }
  }

  /* ---------- 权限状态 ---------- */
  var PERM_TEXT = { granted: '已授权', denied: '已拒绝', prompt: '待询问', unknown: '未知' };
  var PERM_CLASS = { granted: 'ok', denied: 'err', prompt: 'warn', unknown: '' };

  function refreshPermissions() {
    return MediaKit.queryPermissions().then(function (perms) {
      [['camera', els.permCamera], ['microphone', els.permMic]].forEach(function (pair) {
        var state = perms[pair[0]];
        pair[1].textContent = PERM_TEXT[state] || state;
        pair[1].className = 'badge ' + (PERM_CLASS[state] || '');
      });
      if (perms.camera === 'denied' || perms.microphone === 'denied') {
        els.permHint.textContent = '权限已被拒绝，实时采集不可用，可使用下方文件上传完成基本操作。';
        enterFallback(ERROR_TEXT[MediaKit.ERR.DENIED]);
      } else if (perms.camera === 'prompt' || perms.microphone === 'prompt') {
        els.permHint.textContent = '点击"申请权限"按钮后，浏览器会弹出授权请求。';
      } else {
        els.permHint.textContent = '';
      }
      return DeviceStore.set('permissions', { at: Date.now(), camera: perms.camera, microphone: perms.microphone });
    });
  }

  /* ---------- 设备枚举 ---------- */
  function fillSelect(select, devices, kindLabel) {
    var previous = select.value;
    select.innerHTML = '';
    if (devices.length === 0) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '未检测到' + kindLabel;
      select.appendChild(empty);
      return;
    }
    devices.forEach(function (device, index) {
      var option = document.createElement('option');
      option.value = device.deviceId;
      // 授权前 label 为空，用占位名称；授权后重新枚举即可拿到真实名称
      option.textContent = device.label || (kindLabel + ' ' + (index + 1) + '（授权后显示名称）');
      select.appendChild(option);
    });
    if (previous && devices.some(function (d) { return d.deviceId === previous; })) {
      select.value = previous;
    }
  }

  function refreshDevices() {
    return MediaKit.enumerate().then(function (groups) {
      fillSelect(els.selectCamera, groups.videoinput, '摄像头');
      fillSelect(els.selectMic, groups.audioinput, '麦克风');
      if (!groups.hasLabels) {
        els.permHint.textContent = '设备名称需授权后才能显示，请先申请权限。';
      }
      return groups;
    }).catch(function () {
      els.deviceError.textContent = '设备枚举失败：浏览器不支持或被限制。';
    });
  }

  /* ---------- 预览与能力 ---------- */
  function renderCapabilities(video, audio) {
    els.capVideo.textContent = video ? JSON.stringify(video, null, 2) : '无视频轨道';
    els.capAudio.textContent = audio ? JSON.stringify(audio, null, 2) : '无音频轨道';
  }

  function startMeter(stream) {
    stopMeter();
    if (!stream || stream.getAudioTracks().length === 0) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var source = audioCtx.createMediaStreamSource(stream);
      var analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      var data = new Uint8Array(analyser.frequencyBinCount);
      var tick = function () {
        analyser.getByteTimeDomainData(data);
        var peak = 0;
        for (var i = 0; i < data.length; i++) {
          peak = Math.max(peak, Math.abs(data[i] - 128));
        }
        els.audioLevel.style.width = Math.min(100, (peak / 128) * 100) + '%';
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { /* 音量条不可用时不影响主流程 */ }
  }

  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = 0;
    els.audioLevel.style.width = '0';
  }

  /* ---------- 打开 / 切换 ---------- */
  function openStream(videoDeviceId, audioDeviceId) {
    clearError();
    return manager.start(videoDeviceId || undefined, audioDeviceId || undefined)
      .then(function (result) {
        els.preview.srcObject = result.stream;
        renderCapabilities(result.video, result.audio);
        startMeter(result.stream);
        els.btnSnapshot.disabled = !result.video;
        exitFallback();
        // 授权后设备 label 才可见，重新枚举刷新名称
        return refreshDevices().then(function () {
          if (videoDeviceId) els.selectCamera.value = videoDeviceId;
          if (audioDeviceId) els.selectMic.value = audioDeviceId;
          return DeviceStore.set('selection', {
            camera: manager.videoDeviceId,
            microphone: manager.audioDeviceId
          });
        }).then(refreshPermissions);
      })
      .catch(function (failure) {
        showError(failure);
        if (failure.code === MediaKit.ERR.DENIED ||
            failure.code === MediaKit.ERR.INSECURE ||
            failure.code === MediaKit.ERR.UNSUPPORTED) {
          enterFallback(ERROR_TEXT[failure.code]);
        }
        refreshPermissions();
        throw failure;
      });
  }

  function onDeviceChange(kind) {
    var select = kind === 'video' ? els.selectCamera : els.selectMic;
    var previousId = kind === 'video' ? manager.videoDeviceId : manager.audioDeviceId;
    var nextId = select.value;
    var videoId = kind === 'video' ? nextId : manager.videoDeviceId;
    var audioId = kind === 'audio' ? nextId : manager.audioDeviceId;
    openStream(videoId, audioId).catch(function () {
      // 切换失败：下拉框回退到上一个设备
      if (previousId) select.value = previousId;
    });
  }

  /* ---------- 降级 ---------- */
  function enterFallback(reason) {
    els.fallbackPanel.classList.remove('hidden');
    els.fallbackReason.textContent = reason || '';
  }

  function exitFallback() {
    els.fallbackPanel.classList.add('hidden');
    els.fallbackReason.textContent = '';
  }

  function handleFile(file) {
    if (!file) return;
    var url = URL.createObjectURL(file);
    els.fallbackPreview.innerHTML = '';
    var node;
    if (file.type.indexOf('image/') === 0) {
      node = document.createElement('img');
      node.src = url;
      node.alt = file.name;
    } else if (file.type.indexOf('video/') === 0) {
      node = document.createElement('video');
      node.src = url;
      node.controls = true;
    } else if (file.type.indexOf('audio/') === 0) {
      node = document.createElement('audio');
      node.src = url;
      node.controls = true;
    } else {
      node = document.createElement('p');
      node.textContent = '已选择文件：' + file.name + '（' + file.type + '）';
    }
    els.fallbackPreview.appendChild(node);
  }

  /* ---------- 事件绑定（getUserMedia 必须由用户手势触发） ---------- */
  els.btnRequest.addEventListener('click', function () {
    openStream(els.selectCamera.value, els.selectMic.value).catch(function () {});
  });
  els.btnRefresh.addEventListener('click', function () {
    refreshDevices();
    refreshPermissions();
  });
  els.btnStop.addEventListener('click', function () {
    manager.stop();
    stopMeter();
    els.preview.srcObject = null;
    els.btnSnapshot.disabled = true;
    els.capVideo.textContent = '未开启';
    els.capAudio.textContent = '未开启';
  });
  els.selectCamera.addEventListener('change', function () { onDeviceChange('video'); });
  els.selectMic.addEventListener('change', function () { onDeviceChange('audio'); });
  els.btnSnapshot.addEventListener('click', function () {
    var video = els.preview;
    if (!video.videoWidth) return;
    els.snapshot.width = video.videoWidth;
    els.snapshot.height = video.videoHeight;
    els.snapshot.getContext('2d').drawImage(video, 0, 0);
  });
  els.fileInput.addEventListener('change', function (event) {
    handleFile(event.target.files[0]);
  });

  // 热插拔：设备列表变化时自动刷新
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }

  /* ---------- 初始化 ---------- */
  renderEnvironment();
  refreshPermissions();
  Promise.all([
    refreshDevices(),
    DeviceStore.get('selection')
  ]).then(function (results) {
    var saved = results[1];
    if (!saved) return;
    // 恢复上次选择（仅填充下拉框，不自动调用 getUserMedia，避免无用户手势时出错）
    if (saved.camera) els.selectCamera.value = saved.camera;
    if (saved.microphone) els.selectMic.value = saved.microphone;
  });
})();
