# Kiomet Browser — 调试壳

纯调试用途的 Kiomet.com 浏览器壳。打开即跳转到 kiomet.com，JS 注入
`hook.js` 在页面执行前完成，捕获所有关键数据并通过 HTTP POST 推到本地服务。

## 文件结构

```
kiomet-browser/
├── app/
│   ├── build.gradle                  # Android 模块构建配置 (AGP 8 插件制)
│   └── src/main/
│       ├── AndroidManifest.xml       # 应用清单 (INTERNET + WebView)
│       ├── assets/
│       │   ├── start.html            # 启动页：加载 hook.js → 跳转 kiomet.com
│       │   └── hook.js               # 核心拦截脚本 (WS/fetch/XHR/WASM/全局变量)
│       ├── java/io/hermes/kiomet/
│       │   └── MainActivity.java     # 全屏 WebView + CDP 调试 + Java 桥
│       └── res/layout/
│           └── activity_main.xml     # 全屏 WebView 布局
├── build.gradle                      # 根项目 plugins 声明 (AGP 8 插件制)
├── settings.gradle                   # pluginManagement + dependencyResolution
├── gradle/wrapper/
│   └── gradle-wrapper.properties     # Gradle 8.7 配置
├── gradlew                           # Gradle wrapper 脚本
├── server/
│   ├── bridge-server.py              # Termux HTTP 桥接服务 (监听 :9996)
│   ├── diag-bridge.js                # Node 诊断 HTTP 服务 (监听 :9996, 含 --port)
│   └── sandbox-test.js               # hook.js 纯本地单元测试 (无需服务端)
└── .github/workflows/
    └── build.yml                     # GitHub Actions 自动构建 APK
```

## 工作原理

```
┌──────────────────────────────────────────────┐
│  1. MainActivity 启动 → 加载 kiomet.com      │
│  2. shouldInterceptRequest 注入 hook.js      │
│  3. hook.js 劫持 WebSocket/fetch/XHR/WASM    │
│  4. hook.js 通过 4 条通道推数据:             │
│     ① KiometBridge.send() (Java 桥)         │
│     ② navigator.sendBeacon()                │
│     ③ Image beacon GET                      │
│     ④ XMLHttpRequest POST                   │
│  5. 全部发送 http://127.0.0.1:9996/log      │
└──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  bridge-server.py 或 diag-bridge.js           │
│  (Termux :9996)                              │
│  接收事件 → 显示/JSONL 日志                   │
└──────────────────────────────────────────────┘
```

## 数据捕获清单

| 事件 | 说明 |
|------|------|
| `ws.create / out / in / close / error` | WebSocket 全生命周期，含消息类型与长度 |
| `wasm.load / mem_info` | WASM 导出函数列表 + 内存快照 |
| `net.fetch / net.xhr` | HTTP 请求方法与 URL |
| `console` | log/info/warn/error/debug 全级别 |
| `error / rejection` | 未捕获异常 + Promise 拒绝 |
| `connected / heartbeat / diag` | 启动报告 + 5s/10s 周期诊断 |

## 用法

### 1. 运行接收服务（二选一）

**Python 版：**
```bash
cd server
python3 bridge-server.py          # 默认 :9996
python3 bridge-server.py --port 1234  # 自定义端口
```

**Node 版（更详细日志）：**
```bash
cd server
node diag-bridge.js               # 默认 :9996
node diag-bridge.js --port 1234   # 自定义端口
```

### 2. 单元测试 hook.js（无需服务端）

```bash
cd server
node sandbox-test.js
```

### 3. 手机上安装 `app-debug.apk` 并打开

## 构建方式

**GitHub Actions（推荐）：**
1. Push 到 `main` 分支
2. Actions 自动构建 APK，发布为 artifact
3. 下载 APK → 装到手机上

**本地构建（需 JDK 17 + Android SDK）：**
```bash
cd kiomet-browser
./gradlew assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
```

## 注意事项

- 端口统一为 **9996**，服务与客户端一致
- Android SDK 最低版本：24（Android 7.0）
- targetSdk：34（Android 14）
- Kiomet 使用 `kodiak_common::bitcode` 自定义二进制格式，WS inbound/outbound 的 hex 数据即原始 bitcode 字节流
