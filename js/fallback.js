(function (global) {
  'use strict';

  var App = global.App || {};

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function FallbackController(opts) {
    this.store = opts.store;
    this.listEl = opts.listEl;
    this.inputs = opts.inputs; // { image, video, audio }
    this.logger = opts.logger;
    this.onItemAdded = opts.onItemAdded || function () {};
    this.objectUrls = new Map();
  }

  FallbackController.prototype.init = function () {
    var self = this;
    Object.keys(this.inputs).forEach(function (type) {
      self.inputs[type].addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (file) self.addFile(file, type === 'image' ? 'upload-image' : type === 'video' ? 'upload-video' : 'upload-audio');
        e.target.value = '';
      });
    });
    return this.refreshList();
  };

  FallbackController.prototype.addFile = function (file, source) {
    var self = this;
    var item = {
      id: App.FileStore.uuid(),
      name: file.name || (source + '-' + Date.now()),
      type: file.type || 'application/octet-stream',
      size: file.size,
      blob: file,
      source: source,
      createdAt: Date.now()
    };
    return this.store.put(item).then(function () {
      self.logger.ok('已保存到' + (self.store.mode === 'memory' ? '内存（降级）' : 'IndexedDB') + '：' + item.name);
      self.onItemAdded(item);
      return self.refreshList().then(function () { return item; });
    });
  };

  // 拍照结果走同一个降级存储，保证“基本操作”闭环
  FallbackController.prototype.addBlob = function (blob, name, source) {
    var file = new File([blob], name, { type: blob.type || 'image/png' });
    return this.addFile(file, source);
  };

  FallbackController.prototype._urlFor = function (item) {
    if (!this.objectUrls.has(item.id)) {
      this.objectUrls.set(item.id, global.URL.createObjectURL(item.blob));
    }
    return this.objectUrls.get(item.id);
  };

  FallbackController.prototype.refreshList = function () {
    var self = this;
    return this.store.getAll().then(function (items) {
      self.listEl.innerHTML = '';
      if (!items.length) {
        var empty = document.createElement('li');
        empty.className = 'hint';
        empty.textContent = '还没有文件。';
        self.listEl.appendChild(empty);
        return items;
      }
      items.forEach(function (item) { self.listEl.appendChild(self._renderItem(item)); });
      return items;
    });
  };

  FallbackController.prototype._renderItem = function (item) {
    var self = this;
    var li = document.createElement('li');
    var url = this._urlFor(item);

    var title = document.createElement('div');
    title.textContent = item.name;
    li.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = item.type + ' · ' + formatSize(item.size) + ' · ' +
      new Date(item.createdAt).toLocaleString() + ' · ' + item.source;
    li.appendChild(meta);

    if (item.type.indexOf('image/') === 0) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = item.name;
      li.appendChild(img);
    } else if (item.type.indexOf('video/') === 0) {
      var video = document.createElement('video');
      video.src = url;
      video.controls = true;
      li.appendChild(video);
    } else if (item.type.indexOf('audio/') === 0) {
      var audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      li.appendChild(audio);
    }

    var actions = document.createElement('div');
    actions.className = 'row-actions';

    var download = document.createElement('a');
    download.href = url;
    download.download = item.name;
    download.textContent = '下载';
    actions.appendChild(download);

    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      self.store.delete(item.id).then(function () {
        var u = self.objectUrls.get(item.id);
        if (u) { global.URL.revokeObjectURL(u); self.objectUrls.delete(item.id); }
        self.logger.info('已删除：' + item.name);
        self.refreshList();
      });
    });
    actions.appendChild(del);
    li.appendChild(actions);
    return li;
  };

  App.FallbackController = FallbackController;
  global.App = App;
})(window);
