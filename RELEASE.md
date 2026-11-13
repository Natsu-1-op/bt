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

## 批量视频复核

安装 Node.js 和 uv。在仓库目录运行以下命令，传入含 `记录索引.json` 的逐人研究目录、视频目录、输出目录。

```sh
node tools/review-video-batch.js "研究用目录" "视频目录" "复核输出目录"
```

首次运行下载 Python 依赖和 Google MediaPipe Face Landmarker 模型。之后在本机顺序解码视频各帧并保留实际帧时间，处理同一视频时复用输出目录的 `.cache`。打开 `复核汇总.html` 可查看各人可比时长、原采集和自适应计数的对照，点击差异时间打开对应视频位置。详细配对记录在 `复核结果.json`。

工具以 `VID年月日时分秒.mp4` 的北京时间选择候选视频，再用交替 30 秒窗口分别拟合和验证时间偏移。仅在双方有效覆盖的时段配对。待对时的行可传入第四个参数，即按受试者编号给出 `video` 或 `offset_ms` 的修正 JSON。`offset_ms` 表示采集首样本对应的视频毫秒位置，允许负值。

```json
{"17":{"video":"VID20260101123000.mp4","offset_ms":2100}}
```

报告使用 MediaPipe 自动眨眼参考。视频、研究记录和生成的复核目录留在本机。

如需用视频与传感器共同标定已有记录，在批量扫描完成后依次运行：

```sh
node tools/calibrate-video-delivery.js "原研究目录" "视频目录" "复核输出目录"
node tools/sync-calibrated-delivery.js "原交付目录" "复核输出目录/双端标定结果.json" "新交付目录"
node tools/build-video-review.js "新研究目录" "视频目录" "复核输出目录/双端标定结果.json" "视频与波形复核.html"
```

新交付目录需要使用尚未创建的路径。并排复核页可跳到差异位置、调整对时和保存人工标记。研究文件可在控制台导入并重放标定结果，医院播放器使用新交付目录中的 `播放数据.json`。

疑难差异可用 `tools/review-eye-evidence.py` 重扫。任务 JSON 是数组，每项给出 `subject`、`file` 和以毫秒为单位的 `ranges`。把结果写到复核目录的 `.眼部证据`，任务 JSON 保存为 `深度复核任务.json`。运行 `node tools/deep-video-review.js 原研究目录 视频目录 复核目录` 得到 `深度标定结果.json`，可供上面两个导出步骤使用。深度判定逐条保存，左右眼分数可在独立复核页查看。

独立复核页可载入或保存人工标记。应用一个或多个标记文件后，用同一份新标定结果生成研究和医院播放数据。对时不同、记录不匹配或判定冲突的标记会写入研究目录的应用报告。

```sh
node tools/apply-video-review.js "原研究目录" "深度标定结果.json" "新标定结果.json" "视频复核标记.json"
node tools/sync-calibrated-delivery.js "原交付目录" "新标定结果.json" "新交付目录" [另外保留的单条源文件]
```

也可以一步生成新交付和下一轮独立复核页。没有额外源文件时，第五个参数填写 `-`。

```sh
node tools/publish-video-review.js "原交付目录" "视频目录" "深度标定结果.json" "新交付目录" "额外源文件或-" "视频复核标记.json"
```

交付前会检查医院目录的文件和字段，并逐条核对研究标记与医院标记。也可单独运行 `node tools/check-review-delivery.js 交付目录 [对照交付目录]`。传入对照目录时会比较原始记录。

需要修正对时的记录，可将独立复核页导出的 `对时修正.json` 和新结果路径传给 `calibrate-video-delivery.js`。若换了录像，先用批量复核工具生成该录像的逐帧缓存。请根据新差异清单重新检查对应事件。

采集页「与录像对时」可以在连续计数段的开头和末尾各记录一次可见闪光。将录像拍到闪光区，并在视频对照页定位两次亮起时刻。两次至少间隔 10 秒，正式采集时尽量跨越整条记录。
