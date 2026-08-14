# dsh-image-recognition

图像识别能力插件，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供统一的图像识别配置与运行时服务。

当会话路由的模型**不支持图像输入**（例如纯文本模型 deepseek-v4-flash）时，本插件让两个入口自动改用配置的视觉模型识别图片，而不是直接拒绝：

| 入口 | 行为 |
|---|---|
| `read_image` 工具 | 纯文本路由读取图片 → 通过识别模型得到描述文本返回给模型 |
| 直接上传图片（Web 发图） | prompt 中的图片被自动识别 → 描述文本作为上下文注入给模型，用户消息保持原文不动 |

会话自身路由永不改变；图片字节经附件服务持久化，识别文本进入历史，纯文本路由的历史保持文本干净。

## 特性

- **统一配置**：一个插件节配置，`read_image` 与发图入口同时生效
- **供应商/模型可换**：`provider` / `model` 任意指定，默认 `opencode-go` / `mimo-v2.5`
- **能力预检**：目标模型必须声明 `image` 输入，否则快速失败并给出明确提示
- **超时与取消**：单次调用受 deadline 约束，区分超时与调用方取消
- **零侵入**：不加载插件时，消费方回退各自默认值，行为不变
- **自包含核心**：识别流式核心随本包维护，仅依赖已发布的 `@deepseek-ai/*` npm 包

## 架构

```
dsh-image-recognition（本插件）
   │ 统一配置 + ctx.imageRecognition 服务
   ▼
resolveEffectiveImageRecognition（本包，共享）
   │ 本地节 > 插件配置 > 内置默认
   ├──► dsh-tool-fs：read_image 降级（执行时解析）
   └──► dsh-host-apiproxy：发图自动识别注入（提交时解析）
```

## 安装与配置

在 DeepSeek Harness 的 `cordis.yml` 中加入插件（或按你使用的 bundle 组合方式加载）：

```yaml
- id: image-recognition
  name: 'dsh-image-recognition'
  config:
    enabled: true            # false = 到处恢复严格拒绝
    provider: opencode-go    # 供应商：任何注册到 llm 服务的路由
    model: mimo-v2.5         # 模型：该路由下的视觉模型
    timeoutMs: 120000        # 单次识别预算（毫秒）
    prompt: >-               # 可选，默认中文描述+文字提取提示词
      你是图像识别助手。请仔细查看这张图片，然后完成以下任务：
      1. 用中文完整描述图片的内容：主体、布局、背景、风格。
      2. 逐字提取图片中出现的所有文字（包括界面文案、代码、表格内容），保持原有结构和格式。
      3. 如果图片是界面截图或图表，说明其组成部分和含义。
      直接输出识别结果，不要任何客套话。
```

所有键均可选，节内每个字段各自有默认值。

### 供应商与模型

- `provider`：任何注册到 `llm` 服务的路由（例如 DeepSeek Harness 通过 `llm-pi-ai` 配置的 `opencode-go`、`zhuzhuxia` 等）
- `model`：该路由下的模型 id，**必须实际支持图像输入**，并在该路由的模型目录中声明 `input: [text, image]`

例如在 DeepSeek Harness 的 `~/.dsh/settings.yaml`（llm-pi-ai 配置）中：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      models:
        - id: mimo-v2.5
          name: MiMo V2.5
          input: [text, image]   # 声明图像能力后即可被识别选用
```

### 配置优先级

识别调用点（`read_image`、发图入口）解析有效配置的顺序：

1. **消费方自己的 `imageRecognition` 配置节**（逐字段优先）
2. **本插件的配置**（`settings()`）
3. **随产品交付的默认值**

```yaml
# 例：全局用插件配置，但 read_image 单独用 pro 模型
- id: image-recognition
  name: 'dsh-image-recognition'
  config: { provider: opencode-go, model: mimo-v2.5 }

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    imageRecognition: { model: mimo-v2.5-pro }
```

## 服务

`apply` 注册 `ctx.imageRecognition`（标准 Cordis Service，随插件卸载自动注销）：

- `settings()` —— 完整解析后的配置
- `recognizeAttachment(attachment, prompt, signal?)` —— 识别一个持久图像附件，返回描述文本
- `enabled` —— 解析后的配置中识别是否启用

## 开发

```sh
npm install
npm run build     # tsc 构建到 lib/
npm test          # vitest
```

## 许可证

[MIT](LICENSE)
