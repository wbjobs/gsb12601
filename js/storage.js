(function (global) {
  'use strict';

  var App = global.App || {};
  var DB_NAME = 'media-picker-demo';
  var DB_VERSION = 1;
  var STORE = 'files';

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function MemoryStore() {
    this.items = [];
    this.mode = 'memory';
  }
  MemoryStore.prototype.put = function (item) {
    this.items.unshift(item);
    return Promise.resolve(item.id);
  };
  MemoryStore.prototype.getAll = function () {
    return Promise.resolve(this.items.slice());
  };
  MemoryStore.prototype.delete = function (id) {
    this.items = this.items.filter(function (i) { return i.id !== id; });
    return Promise.resolve();
  };

  function FileStore() {
    this.db = null;
    this.mode = 'indexeddb';
  }

  FileStore.prototype.open = function () {
    var self = this;
    if (!App.env.indexeddbSupported) {
      return Promise.reject(new Error('IndexedDB 不可用'));
    }
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = function () {
        self.db = req.result;
        // 隐私模式下可能拿到 db 但操作时整体失败
        self.db.onversionchange = function () { self.db.close(); };
        resolve();
      };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('数据库被其他标签页阻塞')); };
    });
  };

  FileStore.prototype._tx = function (mode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  };

  FileStore.prototype.put = function (item) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var req = self._tx('readwrite').put(item);
      req.onsuccess = function () { resolve(item.id); };
      req.onerror = function () { reject(req.error); };
    });
  };

  FileStore.prototype.getAll = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var req = self._tx('readonly').getAll();
      req.onsuccess = function () {
        var items = (req.result || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
        resolve(items);
      };
      req.onerror = function () { reject(req.error); };
    });
  };

  FileStore.prototype.delete = function (id) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var req = self._tx('readwrite').delete(id);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  };

  function createStore() {
    if (!App.env.indexeddbSupported) {
      return Promise.resolve(new MemoryStore());
    }
    var store = new FileStore();
    return store.open().then(
      function () { return store; },
      function () {
        // IndexedDB 存在但打开失败（隐私模式 / 配额 / 文件协议限制）时降级内存
        var mem = new MemoryStore();
        mem.fallbackReason = 'IndexedDB 打开失败，已降级为内存存储（刷新后丢失）';
        return mem;
      }
    );
  }

  App.FileStore = {
    create: createStore,
    uuid: uuid
  };
  global.App = App;
})(window);
