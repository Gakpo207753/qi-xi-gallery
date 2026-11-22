# MediaPipe Hand Landmarker · 自托管资产

本目录只用于 QI-XI 的本地手势识别。运行时**不访问 Google CDN、不上传视频帧、不录制**。

## 版本与来源

| 项目 | 值 |
|---|---|
| 软件包 | `@mediapipe/tasks-vision` |
| 版本 | `1.2.0` |
| 来源 | <https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.2.0.tgz> |
| 项目主页 | <https://mediapipe.dev> |
| 许可证 | Apache-2.0（见同目录 `LICENSE`） |
| 引入日期 | 2026-11-02 |
| 运行方式 | 用户点击启用摄像头后，从本站 `assets/mediapipe/` 懒加载 |

## 文件

```text
vision_bundle.mjs                         156,344 B
wasm/vision_wasm_internal.js              334,128 B
wasm/vision_wasm_internal.wasm         14,466,654 B
hand_landmarker.task                    7,819,105 B
LICENSE                                    11,358 B
总计                                    22,787,589 B
```

模型来源：

```text
https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```

## SHA-256

```text
hand_landmarker.task
fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1

LICENSE
cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30

vision_bundle.mjs
870da5cfc43bfcf2a8b0f14e8152dae8c7e701722e1191b0e592b94b81b4127a

wasm/vision_wasm_internal.js
85c1a342be70427987f900969a5f26e17557351111364e6585e97fb03e93e108

wasm/vision_wasm_internal.wasm
bcc13df22d3d69ec8cbe8e280989356d844ae00f4523eb82072d2484f44134dc
```

## 兼容性与体积

- 当前只保留 **SIMD WASM** 变体，目标浏览器为 Chrome / Edge / Safari 最新两个大版本。浏览器不支持 WASM SIMD 时，MediaPipe 初始化失败，摄像头会降级到手动模式。
- 不保留 no-SIMD 与 module WASM 变体，避免仓库增加约 27 MB。
- 实际体积约 22.8 MB，高于旧 `TECHNICAL_PLAN.md` 的 6–10 MB 参考预算；只在用户点击“启用摄像头”后加载，不进入首屏。
- 部署时应为 `assets/mediapipe/*` 配置长缓存，并为 `.wasm` 返回 `application/wasm`。

## 隐私

- 不请求麦克风；
- 不上传、不录制、不保存视频帧或关键点；
- 页面隐藏、暂停、停止或销毁时停止摄像头轨道；
- 识别失败时保留手动体验。

## 上游许可

Apache License 2.0。本目录的 `LICENSE` 为 Apache License 2.0 原文；再分发时保留该文件与上游版权声明。MediaPipe 为 Google LLC 的项目，本项目与 Google 无隶属关系。
