# Gemini Live Translator（实时双语同传字幕）

基于 Google Gemini 官方 **Live API / Gemini 3.5 Live Translate** 的浏览器实时双语同传字幕扩展。  
在观看外语直播、视频、公开课及会议时，实时捕获网页音频并流式输出「原文 + 译文」双语字幕。

> 当前版本：**v1.0.6**（协议与稳定性重构版）

---

## 一、v1.0.6 更新要点（重要）

本版修复了 v1.0.1~v1.0.4 期间导致"只翻译一两句就停、延迟十几秒、切语境后连不上"的核心问题：

1. **恢复官方原生 Live Translate 协议**
   - `setup.generationConfig.responseModalities: ["AUDIO"]`
   - `setup.generationConfig.translationConfig: { targetLanguageCode, echoTargetLanguage: true }`
   - `setup.inputAudioTranscription: {}`、`setup.outputAudioTranscription: {}`（**顶层**）
   - `setup.contextWindowCompression: { slidingWindow: {} }`（实测被服务端接受且无害，保留为优化；但长会话退化的主因更可能是网关 5-Key 轮换绑定的上游 Key 质量 —— 同一配置多次连接 120s 产出方差可达 2~118 条，因此扩展用看门狗主动重连换 Key 兜底）
   - 目标语言使用官方 BCP-47 码（中文 `zh-Hans` / 繁体 `zh-Hant`）。
   - 注意：把转写配置放进 `generationConfig` 会被服务端以 `1007 Invalid JSON payload` 拒绝（Google 官方文档的 WebSocket 示例在此处有误）。
2. **音频帧格式改为 `realtimeInput.mediaChunks`**
   - 实测：`realtimeInput.mediaChunks` 可连续实时同传（p50 延迟接近 0ms）；
     新版字段 `realtimeInput.audio` 在本服务上会被稀疏处理（120s 仅 2 条转写）。
3. **握手超时 12s → 30s**：网关/代理握手实测 0.5s~13.5s 波动，旧版 12s 会把正常慢握手误杀成"连接超时"。
4. **重连策略重写**：指数退避（0.6s→8s 封顶）+ 抖动，不再因 5 次失败永久放弃；网关轮询 Key 换绑后的临时 4xx/限流不再误判为"API Key 无效"。
5. **活性看门狗（自我修复）**：有语音但 18s 无任何转写、或原文在流动但译文停摆 20s、或服务端 45s 静默、音频管线 5s 未发送 → 自动重建会话（重连会换到网关另一个上游 Key，可绕开劣质上游）；视频暂停时自动跳过，避免暂停期反复重连。
6. **9 分钟无缝会话轮转**：新会话先握手成功再切换音频，旧会话随后退场，长直播不再周期性断档；同时处理服务端 `goAway` 通知。
7. **字幕断句重写**：按「译文句末标点 + 原文句末 + 静音 + 最大长度」四重边界落行，不再把单词拆成一行一行；支持双语 / 仅译文 / 仅原文三种显示模式（浮窗 ⚙️ 内切换）。
8. **状态栏与音量分离**：连接状态只由真实事件驱动，音量改为独立音量条，彻底消除"正在同传 / 监听音频中"500ms 闪烁。
9. **音频重采样改为跨块连续相位插值**：修复旧版每 4096 采样块独立插值导致的块间相位漂移与时间轴累积偏差，精确输出 100ms/块。
10. **体验与健壮性**：视频未就绪时自动等待播放（不再直接报错停服）、页面 bfcache 返回自动恢复、弱网发送背压保护、多标签配置同步、扩展热重载残留清理。
11. **设置页新增「测试节点连接」**：直接对当前节点做一次 WebSocket 握手自检并显示 `setupComplete` 往返耗时，方便排查代理/网络问题。
12. **兼容模式**：设置项 `protocolMode: "legacy"` 可切回旧版 Agent 载荷（用于对照排查）；默认 `native`。

---

## 二、安装

支持 Chrome / Edge 等 Chromium 内核浏览器（建议 Chrome 120+）。

1. 下载并解压发布包 `Gemini_Live_Translator_v1.0.6.zip` 到固定目录；
2. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`），开启右上角「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的文件夹；
4. 安装后请勿删除/移动该文件夹。

## 三、配置与使用

1. 点击工具栏插件图标打开设置页：
   - **API 节点**：默认 Google 官方；使用自建反代/轮询网关时切到「自定义代理」填入地址（网关若免密，Key 可留空或填占位符）。
   - **API Key**：直连官方必填；自定义网关按网关规则填写。
   - **模型**：默认 `models/gemini-3.5-live-translate-preview`（专为低延迟、连续流式双语同传设计的原生模型）。
   - **目标语言**：中文普通话 / 英语 / 日语。
   - 保存前可点「🔌 测试节点连接」确认链路与握手耗时。
2. 打开有声音的网页并播放视频，点击插件图标（首次会弹出网页内浮窗）或浮窗播放按钮开始同传。
3. 浮窗内可：拖拽移动、右下角拉伸、调节透明度/毛玻璃/字号、切换音源（网页视频 / 麦克风）、清屏、重新连接。
4. 网页内浮窗的 ⚙️ 面板可切换「双语 / 仅译文 / 仅原文」。

## 四、工作原理（简述）

```
<video>/麦克风 → AudioContext → 16kHz/16bit/单声道 PCM（连续相位重采样，100ms/块）
    → WebSocket(wss://…/GenerativeService.BidiGenerateContent)
        setup: 原生 Live Translate 配置（translationConfig + 顶层转写配置 + contextWindowCompression）
        realtimeInput.mediaChunks: base64 PCM 帧
    ← serverContent.inputTranscription（原文）
    ← serverContent.outputTranscription（译文）
→ 字幕断句引擎 → Shadow DOM 浮窗渲染
```

- 会话层：连接中 → 握手 → 同传中 → 断开重连（无限退避）/ 无缝轮转；看门狗检测"假活"会话。
- 隐私：API Key 只保存在浏览器本地 `chrome.storage.local`；所有日志/错误信息中的 key 均脱敏；纯客户端扩展，不经过第三方服务器（自定义网关除外）。

## 五、常见问题

| 现象 | 排查 |
|---|---|
| 一直"连接中" | 点设置页「测试节点连接」看握手耗时与 close code；代理/网络不稳时 30s 内会自动重试，无需手动点 |
| 连上但没字幕 | 确认视频正在播放且未静音；确认目标语言；查看浮窗状态（等待语音 / 同传中）；若长时间无输出会自动重建会话 |
| 字幕断续 / 延迟大 | 多为代理网络抖动或网关配额；可换节点、确认网关 WebSocket 长连接未被 CDN 中断 |
| 官方 API 报 1007 | 请确认使用的是 v1.0.6+（正确协议层级），不要照抄官方文档中错误的 WebSocket 示例 |

## 六、版本历史

- **v1.0.6**：彻底移除 3.1 兼容分支及语境提示词摆设，全面聚焦原生 Live Translate 协议，精简状态栏，修复 CJK 词间空格 (当前版本)
- v1.0.4：删除流中 clientContent（语境切换改重连）、turnComplete 强制提交（仍有 12s 超时与协议回归问题）
- v1.0.3：回退 TEXT+systemInstruction 载荷、反碎片闸门（引入协议回归）
- v1.0.2：新增 12s 握手超时（慢握手误杀）
- v1.0.1：引入原生 live-translate 协议分支（缺 echoTargetLanguage）
- v1.0.0：首个正式版

## 七、开源许可

本项目基于 [MIT License](LICENSE) 开源。
