# Kiomet Browser — 调试壳

纯调试用途的 Kiomet.com 浏览器壳。打开即跳转到 kiomet.com，JS 注入
`hook.js` 在页面执行前完成，捕获所有关键数据并通过 WebSocket 推到本地服务。

## 文件结构

```
kiomet-browser/
├── app/
│   ├── build.gradle              # Android 模块构建配置
│   └── src/main/
│       ├── AndroidManifest.xml   # 应用清单 (INTERNET + WebView)
│       ├── assets/
│       │   ├── start.html        # 启动页：注入 hook.js → 跳转 kiomet.com
│       │   └── hook.js           # 核心拦截脚本 (WS/fetch/WASM/全局变量)
│       ├── java/io/hermes/kiomet/
│       │   └── MainActivity.java # 全屏 WebView + CDP 调试
│       └── res/layout/
│           └── activity_main.xml # 全屏 WebView 布局
├── build.gradle                  # 根项目 buildscript
├── settings.gradle               # 插件管理 + 子模块
├── gradle/wrapper/
│   └── gradle-wrapper.properties # Gradle 8.7 配置
├── gradlew                       # Gradle wrapper 脚本
└── .github/workflows/
    └── build.yml                 # GitHub Actions 自动构建 APK

kiomet-server/
└── bridge-server.py              # Termux WebSocket 桥接服务 (监听 :9999)
```

## 工作原理

```
┌──────────────────────────────────────────────┐
│  1. MainActivity 启动 → 加载 start.html      │
│  2. start.html 加载 hook.js                  │
│  3. hook.js 劫持 WebSocket/fetch/WebAssembly │
│  4. hook.js 通过 ws://localhost:9999 推数据   │
│  5. 浏览器导航到 https://kiomet.com/          │
│  6. Kiomet 运行，所有流量被 hook.js 镜像      │
└──────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│  bridge-server.py (Termux :9999)              │
│  接收事件 → 显示/日志 → 接受命令回注          │
└──────────────────────────────────────────────┘
```

## 数据捕获清单

| 事件 | 说明 |
|------|------|
| `ws.create / out / in / close / error` | WebSocket 全生命周期，**含原始 bitcode 字节 (hex)** |
| `wasm.load / mem_info / mem_dump / mem_grow` | WASM 导出函数 + 内存快照 |
| `net.fetch / net.fetch_resp / net.xhr` | HTTP 请求/响应 |
| `globals` | 新增全局变量 |
| `console / error / rejection` | JS 控制台 + 错误 |
| `eval_result / memory_search` | 从服务端下发命令的执行结果 |

## 服务端命令

```python
bridge.broadcast("memory_dump")        # 请求 WASM 内存快照
bridge.broadcast("wasm_snapshot")      # 请求导出函数列表
bridge.broadcast("eval", code="...")   # 远程执行任意 JS
bridge.broadcast("memory_search", pattern="0a0b0c")  # 内存搜索
```

## 构建方式

**GitHub Actions (推荐):**
1. Push 整个 `kiomet-browser` 目录到 GitHub 仓库
2. Actions 自动构建 APK，发布为 artifact
3. 下载 APK → 装到手机上

**本地构建 (需 JDK 17 + Android SDK):**
```bash
cd kiomet-browser
./gradlew assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
```

## 使用方法

1. Termux 中启动服务：
   ```bash
   pip3 install websockets
   cd kiomet-server
   python3 bridge-server.py
   ```
2. 手机上安装 `app-debug.apk` 并打开
3. 观察 Termux 终端输出即可看到 Kiomet 的实时流量

## 协议逆向方向

Kiomet 的协议基于 `kodiak_common::bitcode` 自定义二进制格式。
WS inbound/outbound 的 hex 数据即原始 bitcode 字节流。
`hook.js` 捕获的每帧都包含完整的 hex 编码，可离线解析。
