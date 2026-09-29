(function (global) {
  'use strict';

  // getUserMedia 各浏览器错误名不一，这里统一归一化，便于 UI 分类提示。
  var CODE_MESSAGES = {
    NotAllowedError: {
      title: '权限被拒绝',
      body: '请在浏览器地址栏的站点设置中允许摄像头 / 麦克风后重试，也可以使用下方文件上传。'
    },
    SecurityError: {
      title: '安全限制',
      body: '浏览器安全策略阻止了设备访问（通常是权限被拒或非安全上下文）。'
    },
    NotFoundError: {
      title: '未找到设备',
      body: '系统没有检测到可用的对应设备，请检查设备是否已连接。'
    },
    DevicesNotFoundError: {
      title: '未找到设备',
      body: '没有可用的摄像头或麦克风。'
    },
    NotReadableError: {
      title: '设备被占用',
      body: '设备可能正被其他应用（会议软件、其他标签页）占用，或硬件层面不可读。请关闭占用方后重试。'
    },
    TrackStartError: {
      title: '设备被占用',
      body: '无法启动轨道，设备可能正被其他程序占用。'
    },
    OverconstrainedError: {
      title: '能力不支持',
      body: '当前设备不满足所选约束（如分辨率），请降低要求后重试。'
    },
    ConstraintNotSatisfiedError: {
      title: '能力不支持',
      body: '当前设备不支持请求的能力。'
    },
    AbortError: {
      title: '启动中断',
      body: '设备启动过程中被中断，请重试。'
    },
    NotSupportedError: {
      title: '不支持',
      body: '当前浏览器不支持该媒体能力，或处于非安全上下文。'
    },
    TypeError: {
      title: '缺少设备',
      body: '请求中包含的设备类型在当前系统上不存在。'
    }
  };

  var App = global.App || {};
  App.Errors = {
    normalize: function (err) {
      if (!err) {
        return { code: 'UnknownError', name: 'Error', message: '未知错误。', title: '未知错误', body: '' };
      }
      var name = err.name || 'UnknownError';
      if (name === 'DOMException' && err.message) {
        // 部分浏览器在 message 中携带真实错误名
        Object.keys(CODE_MESSAGES).forEach(function (key) {
          if (err.message.indexOf(key) !== -1) name = key;
        });
      }
      var preset = CODE_MESSAGES[name];
      var code = name;
      if (name === 'SecurityError') code = 'NotAllowedError';
      if (name === 'TrackStartError') code = 'NotReadableError';
      if (name === 'DevicesNotFoundError') code = 'NotFoundError';
      if (name === 'ConstraintNotSatisfiedError') code = 'OverconstrainedError';

      var message = err.message || (preset ? preset.body : '未知错误。');
      return {
        code: code,
        name: name,
        message: message,
        title: preset ? preset.title : '出错了',
        body: preset ? preset.body : message,
        original: err
      };
    },

    isPermissionDenied: function (err) {
      return err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err.code === 'NotAllowedError');
    },
    isNoDevice: function (err) {
      return err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError' || err.name === 'TypeError' || err.code === 'NotFoundError');
    },
    isOccupied: function (err) {
      return err && (err.name === 'NotReadableError' || err.name === 'TrackStartError' || err.code === 'NotReadableError');
    },
    isConstraint: function (err) {
      return err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError' || err.code === 'OverconstrainedError');
    }
  };

  global.App = App;
})(window);
