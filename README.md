# 数学答疑 APK（完整版，Capacitor + proot）

把 `/root/workspace/mathapp` 那个网页版，连同本机的七个验证引擎，一起装进一个能下载安装的 App。

## 它为什么长这样

本机（荣耀平板）**无法编译 APK**：没有 JDK / Gradle，`ANDROID_HOME` 为空，Android 构建工具链也没有 arm64 版本。
而且 `z3 / python-flint / ortools / cvc5` 在 PyPI **没有 Android ABI 轮子**，Chaquopy 也带不动，Android 10+ 又禁止从应用数据目录执行原生二进制。

所以完整版只有一条路：**APK 里塞一个 proot（用户态 rootfs 运行时）**，首启时把 Ubuntu arm64 rootfs 解压到 `filesDir/rootfs`，在里面跑 `python3 server.py 8117`，WebView 直接连 `127.0.0.1:8117`。

```
APK (~35 MB)                   引擎包 rootfs.tar.gz (~280 MB)
├─ www/          前端（同网页版）  ├─ /usr/bin/python3
├─ lib/arm64-v8a/libproot.so     ├─ sympy 1.14 / z3 5.4.1 / flint 0.9
│                  libprootloader.so  ├─ numpy 2.5.4 / CP-SAT 9.15 / cvc5 1.4.2
│                  libtalloc.so  ├─ pari-gp 2.15.4
│                  libandroid-shmem.so └─ /opt/mathapp/{engine.py,server.py,web/}
└─ LocalBackend 插件：解压包 + 起 proot + 健康检查
```

## 目录

| 路径 | 作用 |
|---|---|
| `www/` | 前端资源（由 `./sync_www.sh` 从 `../mathapp/web` 同步，勿手改） |
| `capacitor.config.json` | appId `com.azdezhishi.mathapp`、允许 mixed content |
| `sync_www.sh` | 把网页版拷进 `www/`（`index.html` 在根，其余在 `static/`） |
| `android/` | 原生工程（Capacitor 8 生成，已改过 manifest / gradle / Java） |
| `android/app/src/main/java/.../LocalBackendPlugin.java` | 解压引擎包、起 proot、健康检查、读日志 |
| `android/app/src/main/jniLibs/arm64-v8a/` | Termux 的 proot 运行时（libtalloc 的 DT_NEEDED 已从 `libtalloc.so.2` 补成 `libtalloc.so`） |
| `pack/build_engine_pack.sh` | 造引擎包（**必须在 arm64 Linux 上跑**） |
| `.github/workflows/build-apk.yml` | 云端出 APK + 引擎包两个产物 |

## 怎么出包（唯一可行路径）

```bash
git init && git add -A && git commit -m "mathapp apk"
git remote add origin <你的仓库>
git push -u origin main
```
推到 GitHub 后：Actions → build-apk → Run workflow。跑完下两个产物：

1. `mathapp-apk`：`app-debug.apk`（debug 签名，可直接侧载安装）
2. `engine-pack`：`rootfs.tar.gz` + `.sha256`

## 装到手机上

1. 装 `app-debug.apk`（需允许「未知来源」）；
2. 把 `rootfs.tar.gz` 放到手机 `Download/`；
3. 打开 App → 设置 → 引擎包导入（走 `LocalBackend.installPack({path})`），解压约 900 MB，等进度；
4. 首启自动 `LocalBackend.start()` → `POST /api/health` 通了以后，验证卡片、整页批改、几何证明全部本地可用；
5. 模型仍在设置里填自己的 baseUrl + key（BYOK），APK 模式下走原生 HTTP，不受 CORS 限制。

## 和网页版的行为差异

- **模型调用非流式**：Capacitor 的原生 HTTP 拿不到逐字流，界面会一次性出结果（`native.js` 里的 `nativeLLMCall`）。
- **验证引擎依赖引擎包**：没导入时前端会显示「验证引擎未就绪」，其余功能（公式渲染、OCR、错题本、复习、导出）照常。
- **本地 OCR 仍在 WebView 里跑**（tesseract.js + wasm），不需要 rootfs。

## 已知限制

- `targetSdkVersion` 故意压到 **28**：Android 10+ 只在 targetSdk<29 时允许从应用数据目录执行二进制，proot 依赖这一点。副作用是上不了 Google Play（侧载分发没问题）。
- `packagingOptions { jniLibs { useLegacyPackaging = true } }` 必须保留，否则原生库不解压到 `lib/`，proot 无法执行。
- debug 签名以后升级必须同签名；要正式分发得自己造 keystore，并在 workflow 里加 `signingConfigs`。
- 首启解压 900 MB 会很热、很慢，建议在充电时做。
- 平板上的 `z3/flint` 计算和网页版同速（同一颗 SoC），不是变慢也不是变快。

## 排障

- 起不来先看日志：`LocalBackend.log()` 读 `filesDir/backend.log` 尾部。
- `缺少 libproot.so` = APK 打包时 jniLibs 没进去（检查 `android/app/src/main/jniLibs/arm64-v8a/`）。
- `后端启动超时` = rootfs 解压不完整或 python 缺依赖，重新导入引擎包。
- `本地验证引擎未就绪` = 引擎包没导入，或 `start()` 还没跑完（`lbStarting` 期间前端会提示稍候）。
