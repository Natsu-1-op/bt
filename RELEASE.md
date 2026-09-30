# 2026-09-30 修复说明

网页采集中频率计算、蓝牙断线发送隔离、通知监听清理、原始记录导入参数/时间校验、分析任务竞争、云端 SDK 重试，以及本地预览服务器的公开范围已修复。
HEX 解析新增实际启动向量/入口检查及重复 FF 冲突检测。

网页三件套必须同时发布：index.html、test.html、blink-app.js。
控制台仍只依赖密码，不依赖 PB0/DBG；原始记录参数不被试调覆盖。Firebase 权限规则未更改。

本机验证：27 个独立测试入口通过，1 个兼容别名，共 28 个文件。
纯网页 clone 缺本地固件源码时，两个固件测试明确 SKIP 并单独计数。
这不代表手机蓝牙、烧录、断电或临床真值已验收。

## 固件

本地交付包中的 App 与 Bootloader 已重新编译，增加设备端镜像验收、Bootloader 擦除前检查及 OTA 放弃后 30 秒复位恢复采样。
公开仓库已有的 Project-OTA-BEGIN-FIX.hex 更新为本次 App（旧文件名保留兼容下载）。
固件源码、Bootloader 与完整交付 ZIP 仍遵循原有约定：本地交付，不上传公开 Git。

- App HEX SHA256：bbc67b823b0df0ad09e977ea6fd738738eb4c19453ed0b753f3073454a2d34fd
- Bootloader HEX SHA256：b4945f12340ffda66c85bb4cfbf7e086b2eead7dee1006c184421a853b026056

需要 SWD 重刷本次 Bootloader 才能获得其擦除前检查修复；只通过 OTA 更新 App 不会更新 Bootloader。
网页 OTA 只能选 App HEX，不能选 Bootloader 或合并整片 HEX。
本次通过 GCC 构建；Keil 工程源已同步，但未在 Windows Keil 中实际重编。
