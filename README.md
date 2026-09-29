# 摄像头 / 麦克风选择演示（无框架）

纯 HTML + CSS + 原生 JavaScript 实现的媒体设备选择示例，覆盖权限、枚举、切换、
占用、能力探测与文件上传降级，不依赖任何框架或构建工具。

## 运行

`getUserMedia` 要求**安全上下文**（`https://` 或 `localhost`），直接双击用
`file://` 打开在部分浏览器中会被禁用。请用本地静态服务器：

```bash
# 任选其一
python3 -m http.server 8080
npx serve .
```

然后访问 http://localhost:8080 。Chrome 还可通过
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` 临时放行局域网地址用于真机测试。

## 功能

- 申请摄像头 / 麦克风权限（整体申请或分别申请，全部由用户点击触发）
- `enumerateDevices()` 枚举设备：授权前名称为空、授权后显示真实名称，两种状态分别处理
- 设备切换并实时预览；切换失败自动回退到上一个设备
- 权限状态展示：Permissions API（`camera` / `microphone`）查询结果 + 实际轨道状态合并
- 设备占用检测：`NotReadableError` 分类提示；轨道 `mute` 事件提示“疑似被抢占”
- 能力展示：`getCapabilities()` / `getSettings()`，并可尝试应用分辨率约束验证“能力不支持”
- Canvas 拍照，照片可存入 IndexedDB
- 降级方案：任何情况下可上传图片 / 视频 / 音频，列表预览、下载、删除，IndexedDB 不可用时自动降级内存存储

## 文件结构

- `index.html` / `styles.css` — 页面与样式
- `js/env.js` — 安全上下文与各 API 支持情况检测
- `js/errors.js` — 跨浏览器错误名归一化（拒绝 / 无设备 / 占用 / 能力不支持等）
- `js/permissions.js` — Permissions API 查询与权限状态合并
- `js/media.js` — 核心：`getUserMedia`、枚举、切换+回退、约束、轨道生命周期
- `js/preview.js` — 预览绑定、Canvas 拍照、AnalyserNode 音量表
- `js/storage.js` — IndexedDB 封装（含内存降级）
- `js/fallback.js` — 文件上传降级
- `js/app.js` — 主控装配与 UI 事件

## 边界与异常处理对照

| 场景 | 处理方式 |
| --- | --- |
| 权限被拒 | `NotAllowedError`/`SecurityError` 归一化，状态置“已拒绝”，给出站点设置与降级提示 |
| 无设备 | `NotFoundError`/`TypeError` 分类，下拉框显示“未检测到设备”，提示上传降级 |
| 设备占用 | `NotReadableError`/`TrackStartError` 提示关闭占用方；运行中被抢占时 `mute` 事件提示 |
| 非安全上下文 | 顶部红条禁用媒体入口，文件上传可用 |
| 用户未交互 | 页面加载只做 `permissions.query` 和 `enumerateDevices`，不调用 `getUserMedia` |
| 枚举差异 | 授权前 label 为空时提示“授权后可见”，授权成功后自动重新枚举 |
| 切换失败 | 新轨道获取成功前不动旧轨道；失败恢复约束/选中项并保持上一个设备 |
| 能力不支持 | `OverconstrainedError` 提示并保持原状态，可继续使用 |
| 降级 | 图片/视频/音频上传 + 拍照存储，IndexedDB 异常时降级内存 |
| 设备热插拔 | 监听 `devicechange`（防抖）自动重新枚举 |
| 轨道意外结束 | `ended` 事件后清理状态并重新枚举 |

## 说明

- 视频预览元素保持 `muted`，麦克风只接入 `AnalyserNode` 做音量表，不接扬声器，避免回声。
- 枚举还包含 `audiooutput` 扬声器数量统计；本示例不涉及 `setSinkId` 输出切换。
