(function (global) {
  'use strict';

  var App = global.App;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function createLogger(listEl) {
    function add(level, message) {
      var li = document.createElement('li');
      li.className = level;
      var time = document.createElement('span');
      time.className = 'time';
      time.textContent = new Date().toLocaleTimeString();
      li.appendChild(time);
      li.appendChild(document.createTextNode(message));
      listEl.appendChild(li);
      while (listEl.children.length > 100) listEl.removeChild(listEl.firstChild);
    }
    return {
      info: function (m) { add('info', m); },
      ok: function (m) { add('ok', m); },
      warn: function (m) { add('warn', m); },
      error: function (m) { add('error', m); }
    };
  }

  function createAlerts(host) {
    function show(level, title, body, ttl) {
      var box = document.createElement('div');
      box.className = 'alert ' + level;
      var t = document.createElement('div');
      t.className = 'alert-title';
      t.textContent = title;
      box.appendChild(t);
      if (body) {
        var b = document.createElement('div');
        b.className = 'alert-body';
        b.textContent = body;
        box.appendChild(b);
      }
      host.appendChild(box);
      global.setTimeout(function () {
        box.style.opacity = '0';
        box.style.transition = 'opacity .3s';
        global.setTimeout(function () { box.remove(); }, 320);
      }, ttl || 6000);
    }
    return {
      info: function (title, body) { show('info', title, body); },
      ok: function (title, body) { show('ok', title, body); },
      warn: function (title, body) { show('warn', title, body, 8000); },
      error: function (title, body) { show('error', title, body, 10000); },
      fromError: function (err) {
        show('error', err.title || '出错了', (err.body || err.message || '') + '（' + err.name + '）', 10000);
      }
    };
  }

  var KIND_LABEL = { video: '摄像头', audio: '麦克风' };
  var KIND_DEVICE_KIND = { video: 'videoinput', audio: 'audioinput' };

  function bootstrap() {
    var env = App.env;
    var logger = createLogger($('#eventLog'));
    var alerts = createAlerts($('#alertHost'));

    var banner = $('#envBanner');
    if (!env.secureContext) {
      banner.hidden = false;
      banner.textContent = '当前不是安全上下文（需要 https 或 localhost）。摄像头/麦克风将不可用，请直接使用文件上传降级。';
      logger.error('非安全上下文，getUserMedia 被禁用。');
    } else if (!env.mediaDevicesSupported) {
      banner.hidden = false;
      banner.textContent = '当前浏览器不支持 MediaDevices API，请使用文件上传降级。';
      logger.error('浏览器不支持 MediaDevices API。');
    }

    var media = new App.MediaManager();
    var permissions = new App.PermissionTracker(media);
    var preview = new App.PreviewController(
      $('#previewVideo'), $('#previewOverlay'), $('#meterCanvas'), { env: env }
    );
    preview.bindUserGesture();

    var state = {
      store: null,
      fallback: null,
      pendingSnapshot: null
    };

    initStorage(logger, state, alerts);
    bindPermissionsUI(permissions, logger, alerts);
    bindMedia(media, permissions, preview, logger, alerts, state);
    bindControls(media, permissions, preview, logger, alerts, state);

    // 加载时只做：Permissions API 查询 + enumerateDevices（授权前 label 为空），
    // 绝不调用 getUserMedia，因此无用户交互也不会报错/崩溃。
    safeInitialEnumeration(media, permissions, logger, alerts);

    if (!env.permissionsSupported) {
      logger.warn('Permissions API 不可用：权限状态将在实际申请后显示。');
    }
  }

  function initStorage(logger, state, alerts) {
    App.FileStore.create().then(function (store) {
      state.store = store;
      state.fallback = new App.FallbackController({
        store: store,
        listEl: $('#uploadList'),
        inputs: {
          image: $('#imageInput'),
          video: $('#videoInput'),
          audio: $('#audioInput')
        },
        logger: logger
      });
      state.fallback.init();
      if (store.fallbackReason) logger.warn(store.fallbackReason);
      else logger.info('IndexedDB 就绪，上传文件可持久化。');
    }).catch(function (err) {
      // create 理论上已内部降级，这里兜底
      alerts.error('存储初始化失败', err && err.message);
    });
  }

  function cardFor(kind) {
    return $('.perm-card[data-kind="' + kind + '"]');
  }

  function bindPermissionsUI(permissions, logger, alerts) {
    permissions.onChange(function (kind, stateName) {
      var card = cardFor(kind);
      card.dataset.state = stateName;
      $('[data-role="state"]', card).textContent = App.PermissionTracker.LABELS[stateName] || stateName;
      $('[data-role="detail"]', card).textContent = App.PermissionTracker.DETAILS[stateName] || '';
    });
  }

  function renderDevices(media, permissions) {
    ['video', 'audio'].forEach(function (kind) {
      var card = cardFor(kind);
      var select = $('[data-role="select"]', card);
      var wantedKind = KIND_DEVICE_KIND[kind];
      var matched = media.devices.filter(function (d) { return d.kind === wantedKind; });
      var current = media.getCurrentDevice(kind);

      select.innerHTML = '';
      var placeholder = document.createElement('option');
      if (!matched.length) {
        placeholder.value = '';
        placeholder.textContent = '未检测到设备';
        select.appendChild(placeholder);
        select.disabled = true;
      } else {
        // 授权前 enumerateDevices 拿不到 label，必须如实提示
        var authorized = matched.some(function (d) { return d.label; });
        placeholder.value = '';
        placeholder.textContent = authorized ? '请选择设备…' : '设备名称在授权后才可见（共 ' + matched.length + ' 个）';
        select.appendChild(placeholder);
        matched.forEach(function (d, index) {
          var opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || ('设备 ' + (index + 1));
          if (current.deviceId && d.deviceId === current.deviceId) opt.selected = true;
          select.appendChild(opt);
        });
        select.disabled = false;
      }
    });
    renderCounts(media);
  }

  function renderCounts(media) {
    var video = media.devices.filter(function (d) { return d.kind === 'videoinput'; }).length;
    var audio = media.devices.filter(function (d) { return d.kind === 'audioinput'; }).length;
    var audioOut = media.devices.filter(function (d) { return d.kind === 'audiooutput'; }).length;
    $('#deviceCounts').textContent =
      '检测到：摄像头 ' + video + ' 个 · 麦克风 ' + audio + ' 个 · 扬声器 ' + audioOut + ' 个' +
      '（授权前名称不可见）';
  }

  function renderCapabilities(media) {
    var box = $('#capabilitiesBox');
    var sections = [];
    ['video', 'audio'].forEach(function (kind) {
      var track = media.getActiveTracks()[kind];
      if (!track) return;
      var settings = track.getSettings ? track.getSettings() : {};
      var caps = track.getCapabilities ? track.getCapabilities() : null;
      var lines = ['[' + KIND_LABEL[kind] + '] ' + (track.label || '')];
      lines.push('状态: ' + media.getState(kind) + ' · muted=' + track.muted + ' · enabled=' + track.enabled);
      if (caps) {
        lines.push('能力(getCapabilities):');
        Object.keys(caps).forEach(function (key) {
          lines.push('  ' + key + ': ' + formatCapValue(caps[key]));
        });
      } else {
        lines.push('能力: 该浏览器不支持 MediaStreamTrack.getCapabilities()');
      }
      lines.push('当前设置(getSettings): ' + JSON.stringify(settings, null, 2));
      sections.push(lines.join('\n'));
    });
    box.textContent = sections.length ? sections.join('\n\n') : '暂无活动设备。';
  }

  function formatCapValue(value) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return String(value);
  }

  function safeInitialEnumeration(media, permissions, logger, alerts) {
    permissions.refreshAll().catch(function (err) {
      logger.warn('权限状态查询失败：' + (err && err.message));
    });
    if (!App.env.enumerateSupported) {
      logger.warn('不支持 enumerateDevices，设备列表不可用。');
      renderCounts(media);
      return;
    }
    media.enumerate().then(function () {
      renderDevices(media, permissions);
      var named = media.devices.some(function (d) { return d.label; });
      logger.info('初始枚举完成（授权前名称为空' + (named ? '，已有授权可显示名称' : '') + '）。');
    }).catch(function (err) {
      logger.error('初始枚举失败：' + err.message);
    });
  }

  function handleMediaError(kind, err, logger, alerts, action) {
    var actionText = action || '申请设备';
    var prefix = kind ? KIND_LABEL[kind] + actionText + '失败：' : actionText + '失败：';
    logger.error(prefix + err.title + ' — ' + err.message);
    alerts.fromError(err);

    if (!kind) return 'error';
    if (App.Errors.isPermissionDenied(err)) {
      alerts.warn('可使用降级方案', '权限被拒绝时，可在右侧直接上传图片 / 视频 / 音频文件。');
      return 'denied';
    }
    if (App.Errors.isNoDevice(err)) {
      alerts.warn('无可用' + KIND_LABEL[kind], '请连接设备后重试，或使用右侧文件上传。');
      return 'nodevice';
    }
    if (App.Errors.isOccupied(err)) {
      alerts.warn('设备可能被占用', '请关闭正在使用' + KIND_LABEL[kind] + '的其他应用或标签页。');
      return 'occupied';
    }
    if (App.Errors.isConstraint(err)) {
      return 'constraint';
    }
    return 'error';
  }

  function bindMedia(media, permissions, preview, logger, alerts, state) {
    media.addEventListener('streamchanged', function (e) {
      preview.setStream(e.detail.stream);
      renderCapabilities(media);
    });

    media.addEventListener('trackchanged', function (e) {
      permissions.syncFromTracks();
      renderCapabilities(media);
      renderDevices(media, permissions);
      var kind = e.detail.kind;
      if (!media.getActiveTracks()[kind]) {
        logger.info(KIND_LABEL[kind] + '轨道已停止。');
      }
    });

    media.addEventListener('deviceschanged', function () {
      renderDevices(media, permissions);
    });

    media.addEventListener('trackmuted', function (e) {
      logger.warn(KIND_LABEL[e.detail.kind] + '轨道被系统静默：' + e.detail.reason);
      alerts.warn('设备疑似被抢占', KIND_LABEL[e.detail.kind] + '轨道被系统静音，可能被其他应用占用。');
      renderCapabilities(media);
    });

    media.addEventListener('trackunmuted', function (e) {
      logger.ok(KIND_LABEL[e.detail.kind] + '轨道恢复。');
      renderCapabilities(media);
    });

    media.addEventListener('trackended', function (e) {
      var kind = e.detail.kind;
      logger.warn(KIND_LABEL[kind] + '轨道意外结束（可能被拔出或被其他程序关闭）。');
      alerts.warn(KIND_LABEL[kind] + '已结束', '设备可能被拔出或被其他程序关闭，请重新选择。');
      media.stop(kind);
      media.enumerate().then(function () { renderDevices(media, permissions); }).catch(function () {});
    });

    media.addEventListener('switchsuccess', function (e) {
      logger.ok(KIND_LABEL[e.detail.kind] + '已切换到新设备。');
      alerts.ok('切换成功', KIND_LABEL[e.detail.kind] + '已切换。');
      media.enumerate().catch(function () {});
    });

    media.addEventListener('switchfailed', function (e) {
      var detail = e.detail;
      // 分类提示由触发切换的调用方（switchOne）统一处理，这里只记录与回滚 UI
      logger.error(KIND_LABEL[detail.kind] + '切换失败，已回退到上一设备：' + detail.error.message);
      renderDevices(media, permissions);
    });

    media.addEventListener('constraintssuccess', function (e) {
      var s = e.detail.settings || {};
      logger.ok('约束已应用：' + s.width + '×' + s.height +
        (s.frameRate ? ' @' + Math.round(s.frameRate) + 'fps' : ''));
      renderCapabilities(media);
    });

    media.addEventListener('constraintsfailed', function (e) {
      logger.warn('约束不支持，保持原状态：' + e.detail.error.message);
      alerts.warn('能力不支持', '当前设备不支持所选约束，已保持原分辨率。');
    });
  }


  function bindControls(media, permissions, preview, logger, alerts, state) {
    // 每张权限卡片上的按钮
    $all('.perm-card').forEach(function (card) {
      var kind = card.dataset.kind;
      $('[data-action="grant"]', card).addEventListener('click', function () {
        requestOne(kind, media, permissions, logger, alerts, state);
      });
      $('[data-action="stop"]', card).addEventListener('click', function () {
        media.stop(kind);
      });
      $('[data-role="select"]', card).addEventListener('change', function (e) {
        var deviceId = e.target.value;
        if (!deviceId) return;
        switchOne(kind, deviceId, media, permissions, logger, alerts);
      });
    });

    $('#grantAllBtn').addEventListener('click', function () {
      // 两类权限各自独立：一个被拒不影响另一个申请（错误已在 requestOne 内部分类提示）
      ['video', 'audio'].forEach(function (kind) {
        requestOne(kind, media, permissions, logger, alerts, state).catch(function () {});
      });
    });

    $('#refreshBtn').addEventListener('click', function () {
      Promise.all([permissions.query('video'), permissions.query('audio')]).then(function () {
        return media.enumerate();
      }).then(function () {
        renderDevices(media, permissions);
        logger.ok('已重新枚举设备。');
      }).catch(function (err) {
        alerts.fromError(err);
      });
    });

    $('#stopAllBtn').addEventListener('click', function () {
      media.stopAll();
      permissions.syncFromTracks();
      logger.info('已停止所有轨道。');
    });

    $('#applyConstraintBtn').addEventListener('click', function () {
      var parts = $('#constraintPreset').value.split('x');
      var width = parseInt(parts[0], 10);
      var height = parseInt(parts[1], 10);
      if (!media.getActiveTracks().video) {
        alerts.warn('请先启动摄像头', '需要活动的视频轨道才能测试分辨率约束。');
        return;
      }
      media.applyConstraints('video', { width: width, height: height }).catch(function (err) {
        handleMediaError('video', err, logger, alerts, '应用约束');
      });
    });

    bindSnapshot(media, preview, logger, alerts, state);

    // 设备热插拔
    if (global.navigator.mediaDevices && global.navigator.mediaDevices.addEventListener) {
      var debounced = debounce(function () {
        media.enumerate().then(function () {
          logger.info('检测到设备连接变化，已重新枚举。');
        }).catch(function () {});
      }, 400);
      global.navigator.mediaDevices.addEventListener('devicechange', debounced);
    }

    // 离开页面时释放硬件
    global.addEventListener('beforeunload', function () {
      media.stopAll();
    });
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      global.clearTimeout(timer);
      timer = global.setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function requestOne(kind, media, permissions, logger, alerts, state) {
    if (!App.env.secureContext || !App.env.mediaDevicesSupported) {
      alerts.error('媒体 API 不可用', '非安全上下文或浏览器不支持。请使用右侧文件上传。');
      return Promise.reject(new Error('unsupported'));
    }

    var existing = media.getActiveTracks()[kind];
    if (existing) {
      // 已有活动轨道时“申请权限”等同于确认当前选择，不重复弹框
      logger.info(KIND_LABEL[kind] + '已在使用中，无需重复授权。');
      return Promise.resolve(existing);
    }

    logger.info('正在申请' + KIND_LABEL[kind] + '权限…');
    return media.request(kind).then(
      function () {
        permissions.noteGranted(kind);
        logger.ok(KIND_LABEL[kind] + '权限已授予，预览已启动。');
        // 授权成功后重新枚举：此时才能拿到真实 label
        media.enumerate().then(function () {
          renderDevices(media, permissions);
        }).catch(function () {});
      },
      function (err) {
        var category = handleMediaError(kind, err, logger, alerts, '授权');
        if (category === 'denied') permissions.noteDenied(kind);
        throw err;
      }
    );
  }

  function switchOne(kind, deviceId, media, permissions, logger, alerts) {
    var current = media.getCurrentDevice(kind);
    if (current.deviceId === deviceId) return Promise.resolve();

    if (!media.getActiveTracks()[kind]) {
      // 尚无轨道：不直接弹设备切换，而是先发起申请（携带 deviceId）
      logger.info('尚未启动' + KIND_LABEL[kind] + '，先申请权限并使用所选设备。');
      return media.request(kind, { deviceId: { exact: deviceId } }).then(
        function () {
          permissions.noteGranted(kind);
          media.enumerate().then(function () { renderDevices(media, permissions); }).catch(function () {});
        },
        function (err) {
          handleMediaError(kind, err, logger, alerts, '选择设备');
          renderDevices(media, permissions);
          throw err;
        }
      );
    }

    logger.info('正在切换' + KIND_LABEL[kind] + '…');
    return media.switchDevice(kind, deviceId).catch(function (err) {
      handleMediaError(kind, err, logger, alerts, '切换');
      throw err;
    });
  }

  function bindSnapshot(media, preview, logger, alerts, state) {
    var snapshotBox = $('#snapshotPreview');
    var snapshotImg = $('#snapshotImg');

    $('#snapshotBtn').addEventListener('click', function () {
      if (!media.getActiveTracks().video) {
        alerts.warn('没有活动的摄像头', '请先申请摄像头权限并选择设备。');
        return;
      }
      preview.snapshot().then(function (result) {
        state.pendingSnapshot = result;
        snapshotImg.src = result.url;
        snapshotBox.hidden = false;
        logger.ok('已拍照：' + result.width + '×' + result.height + '，可保存或丢弃。');
      }).catch(function (err) {
        alerts.error('拍照失败', err.message);
      });
    });

    $('#saveSnapshotBtn').addEventListener('click', function () {
      var result = state.pendingSnapshot;
      if (!result || !state.fallback) {
        alerts.warn('没有可保存的照片', state.fallback ? '' : '存储尚未就绪，请稍后重试。');
        return;
      }
      var name = 'snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      state.fallback.addBlob(result.blob, name, 'snapshot').then(function () {
        alerts.ok('已保存', '照片已存入' + (state.store.mode === 'memory' ? '内存（降级模式）' : 'IndexedDB') + '。');
        preview.consumeSnapshotBlob();
        snapshotBox.hidden = true;
        state.pendingSnapshot = null;
      });
    });

    $('#discardSnapshotBtn').addEventListener('click', function () {
      preview.clearSnapshot();
      snapshotBox.hidden = true;
      state.pendingSnapshot = null;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})(window);
