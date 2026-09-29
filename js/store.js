/* IndexedDB 存储：记住用户选择的设备与权限快照 */
(function (global) {
  'use strict';

  var DB_NAME = 'device-picker';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var dbPromise = null;

  function isSupported() {
    return typeof indexedDB !== 'undefined';
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function get(key) {
    if (!isSupported()) return Promise.resolve(undefined);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function set(key, value) {
    if (!isSupported()) return Promise.resolve();
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  global.DeviceStore = { get: get, set: set, isSupported: isSupported };
})(window);
