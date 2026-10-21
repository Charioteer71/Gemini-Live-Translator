# Gemini Live Translator v1.0.5 修复与验证报告

> 日期：2026-10-21 ｜ 范围：`D:\Chrome_Extensions_Dev\Gemini_Live_Translator_Dev`
> 目标：修复 v1.0.1~v1.0.4 期间"只翻译一两句就停 / 延迟十几秒 / 切语境后连不上"的核心问题，交付可持续稳定输出的实时双语字幕扩展。
> 过程复盘（从接手到交付的完整探索历程）：[docs/v1.0.5-探索修复报告.md](docs/v1.0.5-探索修复报告.md)

---

## 1. 结论速览

v1.0.5 已完成协议修复与稳定性重构，并通过多层验证：

| 验证层 | 结果 |
|---|---|
| 协议实测（直连用户轮询网关，`_takeover/proto/`） | 锁定真实 wire 层级与帧格式；native 配置 + `mediaChunks` 连续 120s 产出 30/30 条转写，p50 延迟 ≈ -49ms；4 分钟长测无断连 |
| 自动化测试（`test_suite.js`，5 Tier 29 项） | **29/29 通过（100%）** |
| Chrome 真机 E2E（330s，真实网关，`_takeover/e2e/`） | v1.0.5：79 条字幕提交、最长间隔 6.3s、0 断连/0 重连、状态栏稳定无闪烁；服务端确实返回 `inputTranscription`(en) + `outputTranscription`(zh-Hans) |
| 版本/发布一致性 | manifest / popup / README / Release / ZIP / tag 全部 = v1.0.5，发布物仅含 14 个白名单文件 |
| 安全扫描 | 仓库、git 历史、基线、Release、ZIP 均无用户私有网关地址/真实 Key/服务器 IP |

---

## 2. 根因分析（按证据链）

### 2.1 P0：setup 载荷协议错误（v1.0.3 回归）

真实服务端 schema（实测裁决）：

```json
{"setup":{
  "model":"models/gemini-3.5-live-translate-preview",
  "generationConfig":{
    "responseModalities":["AUDIO"],
    "translationConfig":{"targetLanguageCode":"zh-Hans","echoTargetLanguage":true}
  },
  "inputAudioTranscription":{},
  "outputAudioTranscription":{}
}}
```

- v1.0.3/v1.0.4 使用 `TEXT + temperature + systemInstruction` 且**丢失 `translationConfig`**，对翻译模型相当于"普通 Live 会话 + 系统提示词"，行为退化为 turn-based / 稀疏输出。
- Google 官方 live-translate 文档的 WebSocket JSON 示例把 `inputAudioTranscription` 放进 `generationConfig`，**真实服务端会返回 1007**（`Unknown name "inputAudioTranscription" at 'setup.generation_config'`）；`translationConfig` 放 setup 顶层同样 1007。两者均已用网关实测留证（`_takeover/proto/logs/v0_*`、`v1_top_*`、`v5_*`）。

### 2.2 P0：音频帧格式（本次新发现的决定性因素）

同一 native 正确 setup 下：

| 帧格式 | 120s 产出 | 结论 |
|---|---|---|
| `realtimeInput.audio {data,mimeType}` | ORIG/OUT 各 **2** 条，77s 空白 | 服务端几乎不连续处理 |
| `realtimeInput.mediaChunks [{mimeType,data}]` | ORIG/OUT 各 **30** 条，p50 lag≈-49ms | 实时连续同传 |

v1.0.5 默认 `mediaChunks`，并保留 `audioFrameStyle` 配置可切换。

### 2.3 P0：长会话产出塌缩（"翻两句就停"的直接机理与对策）

同一推荐形态多次连接，120s 内 ORIG/OUT 产出方差极大（实测 2~118 条）；4 分钟长测中约 70~90s 后产出从 6~11 条/10s 塌缩到 0~1 条/10s，而会话本身 alive（无 close/error）。加入 `contextWindowCompression: { slidingWindow: {} }` 后 120s 曾达 118/118 条、零 >4s 缺口，但补跑 240s 仅 50 条，说明 **压缩字段被接受且无害，却不是稳定解**。

综合判断：主变量更可能是**网关 5-Key 无状态轮换随机绑定的上游 Key/后端质量**——这也解释了用户"有时能用、有时翻两句就停、重连又好了"。因此 v1.0.5 的落地对策是**看门狗主动重连换 Key**：
- 有语音但 18s 无任何转写 → 重建会话；
- 原文在流动但译文停摆 20s → 重建会话；
- 服务端 45s 静默 / 音频 5s 未发送 → 重建会话；
- 视频暂停期间跳过上述判据，避免暂停期反复重连。

### 2.4 P0：连接与重连策略（用户"切语境连不上/一直重试"的直接原因）

- 网关/Cloudflare 路径握手实测 0.5s~23s 波动；v1.0.2 引入的 **12s 硬超时** 会误杀正常慢握手。
- `isTerminalError` 把 4xxx/限流/配额一律判死；`MAX_RECONNECT_ATTEMPTS=5` 用尽即永久停服 —— 与 5-Key 轮询网关"重连换 Key"的模式冲突。
- 本地 Chrome 网络诊断（`_takeover/e2e/`）：TUN/fake-ip 环境默认解析路径下 WS 建连 1.2~8s 抖动、偶发 21s/1006；用真实 Cloudflare IP 映射后 0.5~0.7s 稳定 —— 证明用户环境里的连接抖动会被旧版超时策略放大为"永远连不上"。

### 2.5 P1：假活与字幕体验

- 无活性看门狗：有语音但无转写时不会自愈，状态栏却仍显示正常。
- 状态栏被本地音量 500ms 循环覆盖 → "正在同传/监听音频中"闪烁（与用户截图一致）。
- 旧断句用"译文 ≥24 字"硬切 + 尾部词表反碎片，产生半句/逐词蹦。
- `lastAudioTime` 实际是"最后转写时间"，静音 flush 判据错误。

---

## 3. v1.0.5 修复清单

| # | 修复 | 说明 |
|---|---|---|
| 1 | 恢复原生 Live Translate 协议 | transcriptions 顶层 + `generationConfig.translationConfig`（zh-Hans/en/ja 等 BCP-47）+ `echoTargetLanguage:true`；translate 模型不发 systemInstruction/temperature |
| 2 | 音频帧改 `mediaChunks` | 实测唯一能连续同传的帧格式；100ms/1600 采样精确分块 |
| 3 | 启用 `contextWindowCompression.slidingWindow` + 强化看门狗 | 压缩字段实测无害但不稳定；新增"无转写 18s / 原文有但译文停 20s → 重连换 Key"看门狗，兜底网关上游质量波动 |
| 3 | 跨块连续相位重采样 | 修复旧版每 4096 采样独立插值的块间漂移（48k≈1.76s/小时时间轴偏移） |
| 4 | 握手超时 12s→30s、分层 | WS 连接与 setupComplete 各自超时；超时只重建会话不判死 |
| 5 | 无限指数退避重连（0.6s→8s 封顶 + 抖动） | 仅明确 API Key 无效才致命；网关 4xx/限流/1008 均可重试 |
| 6 | 活性看门狗 | 有语音 25s 无转写 / 服务端 45s 静默 / 音频 5s 未发送 → 自动重建；视频暂停时跳过 |
| 7 | 9 分钟无缝会话轮转 + `goAway` 处理 | 新会话先连接成功再切换音频，旧会话退场，长直播不断档 |
| 8 | 字幕断句重写 | 译文句末标点 + 原文句末 + 静音 + 最大长度四重边界；避免逐词/半句；turnComplete/interrupted 兼容 |
| 9 | 状态与音量分离 | 状态机只由真实事件驱动；音量独立条形指示，消除闪烁 |
| 10 | 显示模式 | 双语 / 仅译文 / 仅原文，浮窗内即时切换 |
| 11 | 视频未就绪等待 | 先开字幕后播视频时等待并自动开始，不再报错停服 |
| 12 | 健壮性 | bfcache 返回恢复、弱网背压丢帧、storage 多标签同步、扩展热重载残留清理、旧配置迁移（清理 2.x 模型） |
| 13 | 节点连接自检 | 设置页一键 WebSocket 握手自检并显示 setupComplete 往返耗时 |
| 14 | 兼容模式 | `protocolMode:"legacy"` 可切回旧 Agent 载荷做对照排查 |

---

## 4. 验证证据

### 4.1 协议实测（proto-verifier）

- 正确形态 setupComplete 耗时样本：2.1s / 2.4s / 3.0s / 3.1s / 4.7s / 7.9s / 13.4s / 23.1s → 30s 超时是必要下限。
- `mediaChunks` 120s：30/30 条，p50 lag 近 0，无 turnComplete/interrupted（分段必须客户端自算）。
- 长会话退化：无压缩 4 分钟 alive 但 70~90s 后产出塌缩到 0~1 条/10s；加 `slidingWindow` 压缩后单次 120s 曾达 118/118 条，但补跑 240s 仅 50 条 → 结论为"字段无害、非稳定解"，由看门狗重连换 Key 兜底。
- 4 分钟：全程有输出、无 close；偶发缺口由扩展看门狗兜底。
- 静音/暂停保活、握手分布等详见 `_takeover/proto/protocol_report.md`。

### 4.2 Chrome E2E（before/after）

| 指标 | before v1.0.4 | after v1.0.5 |
|---|---|---|
| 协议载荷 | TEXT+systemInstruction，无 translationConfig | 原生 translationConfig + 顶层 transcriptions + mediaChunks |
| 扩展 WS 握手 / setupComplete | 1.6s | 499ms / 814ms（最终冻结版） |
| 330s 字幕提交 | 100 | **86**（最终冻结版；此前两轮 79 / 89） |
| 最长提交间隔 | 6.2s | **8.1s**（阈值 <20s） |
| 断连/重连 | 0（本机可靠网络） | **0**（closeCodes 为空） |
| 状态栏 | 随音量 500ms 变化 | 仅 1 次状态迁移，全程"正在同传"无闪烁 |
| 输出稳定性 | 100 commits / 330s | 每 30s 6~9 条提交、25~30 次文本更新，11 个时间桶无衰减 |

> before 在可靠网络下同样能连续输出，说明用户真实环境的主因是"网络握手抖动 + 旧版 12s 超时/5 次上限 + 4xx 判死"；v1.0.5 的 30s 超时、无限退避、看门狗与无缝轮转正是针对该场景。故障注入（慢握手/断网恢复）对照见 `_takeover/e2e/e2e_report.md`。

### 4.3 自动化测试

`node test_suite.js`：5 Tier / 29 项全部通过。新增回归测试覆盖：
- setup schema 层级（禁止 transcriptions 进 generationConfig、禁止顶层 translationConfig）；
- native 与 legacy 两种载荷分支；
- 默认配置三处一致性（content.js / background.js）；
- `mediaChunks` vs `audio` 帧构造器；
- 重连退避（0.6s→8s 封顶）、错误分级（凭据致命/其余可重试）；
- 会话状态机竞态、字幕零重排渲染、XSS 清洗、Key 脱敏等。

---

## 5. 已知限制与后续建议

1. **原生翻译模型不支持自由系统提示词**：语境模式只对 Agent 兼容模型生效；原生模式下 UI 会明确提示。若后续官方开放 instruction 通道可再接入。
2. `responseModalities:["TEXT"]` 实测仍会产生 24kHz 语音输出与 AUDIO token，无法省额度；保持官方推荐 `AUDIO`。
3. 翻译模型长会话中偶发输出变稀疏（实测 4 分钟内出现 >20s 缺口），已用看门狗兜底；进一步可评估 `realtimeInputConfig`/`sessionResumption` 官方能力（当前翻译模型对 sessionResumption 支持未知）。
4. 部分受 DRM 保护（EME）的视频元素无法通过 `MediaElementAudioSourceNode` 捕获音频；如需支持，后续可评估 `chrome.tabCapture` + offscreen 方案。
5. `createScriptProcessor` 已废弃但兼容性最好；后续可迁移 AudioWorklet（参考 ViiTor 的 16k worklet + monitor context 方案）。
6. 发布纪律：`Release` 目录仅 14 个白名单文件；`.agents/`、`_takeover/`、历史 ZIP 不得进入发布物；出包后需复跑安全扫描。
