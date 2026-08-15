/**
 * 图像识别核心：向显式 provider/model 路由发起一次辅助识别调用。
 *
 * 本文件是自包含实现（DeepSeek Harness 仓库中该逻辑位于 @deepseek-ai/dsh-llm
 * 的 image-recognition.ts，此处按独立包维护一份兼容副本，仅依赖已发布的
 * @deepseek-ai/* npm 包）。
 * @module dsh-image-recognition/image-recognition
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import sharp from 'sharp'

/** 单次识别调用的超时错误码。 */
export const IMAGE_RECOGNITION_TIMEOUT_CODE = 'IMAGE_RECOGNITION_TIMEOUT'

/** 随产品交付的默认识别提示词：简洁描述 + 逐字提取文字。 */
export const DEFAULT_IMAGE_RECOGNITION_PROMPT = '你是图像识别助手。请用中文简洁描述图片内容（主体、布局、背景、风格）；逐字提取图中可见文字（界面文案、代码、表格），保持原有结构；界面截图或图表说明组成部分和含义；「密钥」(API key) 等筛选、统计或配置术语统一写作「供应商」(provider)。直接输出识别结果，不要客套。'

/** 随产品交付的识别输出上限；描述通常很短，设置上限可避免长尾生成拖慢调用。 */
export const DEFAULT_IMAGE_RECOGNITION_MAX_TOKENS = 1024

/** 随产品交付的灰度回退开关；默认关闭，避免改变既有严格拒绝行为。 */
export const DEFAULT_IMAGE_GRAYSCALE_ENABLED = false

/** 随产品交付的灰度回退网格宽/高。 */
export const DEFAULT_IMAGE_GRAYSCALE_SIZE = 32

/** 面向部署的识别设置，所有消费方共用。 */
export interface ImageRecognitionSettings {
  /** 承载识别模型的 provider 路由（注册到 `llm` 服务）。 */
  provider: string
  /** 该路由上的模型 id，按路由目录的命名。 */
  model: string
  /** 单次识别调用预算（毫秒）。 */
  timeoutMs: number
  /** 单次输出 token 上限，作为识别请求的 `maxTokens` 发送。 */
  maxTokens: number
  /** 随图像块一起发送的提示词；`{path}` 会被替换为图像路径。 */
  prompt: string
  /** 没有可用视觉识别器时，是否回退为有边界的灰度 ASCII 渲染。 */
  grayscaleEnabled: boolean
  /** 灰度回退网格宽/高（像素）。 */
  grayscaleSize: number
}

/** 随产品交付的默认识别路由；调用方可覆盖任意字段。 */
export const DEFAULT_IMAGE_RECOGNITION_SETTINGS: ImageRecognitionSettings = Object.freeze({
  provider: 'opencode-go',
  model: 'mimo-v2.5',
  timeoutMs: 120_000,
  maxTokens: DEFAULT_IMAGE_RECOGNITION_MAX_TOKENS,
  prompt: DEFAULT_IMAGE_RECOGNITION_PROMPT,
  grayscaleEnabled: DEFAULT_IMAGE_GRAYSCALE_ENABLED,
  grayscaleSize: DEFAULT_IMAGE_GRAYSCALE_SIZE,
})

/**
 * 用随产品交付的默认值补全一份部分识别配置。
 * @param partial - 部署覆盖项；缺省时全部使用默认值。
 * @returns 完整配置对象。
 */
export function resolveImageRecognitionSettings(partial: Partial<ImageRecognitionSettings> | undefined): ImageRecognitionSettings {
  return {
    provider: partial?.provider ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.provider,
    model: partial?.model ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.model,
    timeoutMs: partial?.timeoutMs ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.timeoutMs,
    maxTokens: partial?.maxTokens ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.maxTokens,
    prompt: partial?.prompt ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.prompt,
    grayscaleEnabled: partial?.grayscaleEnabled ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.grayscaleEnabled,
    grayscaleSize: partial?.grayscaleSize ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.grayscaleSize,
  }
}

/** 消费方读取有效配置时见到的运行时服务形态。 */
export interface ImageRecognitionServiceShape {
  /** 解析后的配置中识别是否启用。 */
  readonly enabled: boolean
  /** 已挂载识别插件的完整解析配置。 */
  settings(): ImageRecognitionSettings & { enabled: boolean }
  /**
   * 识别一个持久图像附件并返回其描述文本。
   * @param attachment - 待识别的持久图像附件。
   * @param prompt - 精确提示词文本（调用方已做 `{path}` 替换）。
   * @param signal - 与单次调用期限融合的调用方取消信号。
   * @returns 识别模型的助手文本，可能为 ''。
   */
  recognizeAttachment(attachment: ImageAttachmentRef, prompt: string, signal?: AbortSignal): Promise<string>
}

/**
 * 解析一个调用点的有效识别配置：显式配置的本地节逐字段优先，已挂载
 * `image-recognition` 插件的设置补足其余，随产品交付的默认值最后兜底。
 * @param local - 消费方自己的配置节；未设置时为 undefined。
 * @param service - 已挂载识别插件的服务；未挂载时为 undefined。
 * @returns 完整有效配置。
 */
export function resolveEffectiveImageRecognition(
  local: (Partial<ImageRecognitionSettings> & { enabled?: boolean }) | undefined,
  service: ImageRecognitionServiceShape | undefined,
): ImageRecognitionSettings & { enabled: boolean } {
  const base = service?.settings()
  return {
    enabled: local?.enabled ?? base?.enabled ?? true,
    provider: local?.provider ?? base?.provider ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.provider,
    model: local?.model ?? base?.model ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.model,
    timeoutMs: local?.timeoutMs ?? base?.timeoutMs ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.timeoutMs,
    maxTokens: local?.maxTokens ?? base?.maxTokens ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.maxTokens,
    prompt: local?.prompt ?? base?.prompt ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.prompt,
    grayscaleEnabled: local?.grayscaleEnabled ?? base?.grayscaleEnabled ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.grayscaleEnabled,
    grayscaleSize: local?.grayscaleSize ?? base?.grayscaleSize ?? DEFAULT_IMAGE_RECOGNITION_SETTINGS.grayscaleSize,
  }
}

/** 提取错误消息，不丢失 `undefined`/非 Error 抛出的情况。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 调用方的取消信号是否已中止。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** 编码图片是否为“没有视觉识别器可用”类错误。 */
function isNoVisionRecognizerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /does not declare image input|no adapter registered|has no configured model|does not own provider|is not configured/i
    .test(error.message)
}

/**
 * 将编码图片渲染为有边界的灰度 ASCII 网格，供纯文本主模型读取粗略布局。
 * @param data - PNG/JPEG/WebP/GIF 编码字节。
 * @param size - 最大网格宽/高。
 * @returns 以 `WxH` 开头、每行一个 ASCII 字符的文本。
 */
export async function renderGrayscaleAscii(data: Uint8Array, size: number): Promise<string> {
  const { data: raw, info } = await sharp(Buffer.from(data), { failOn: 'error' })
    .resize(size, size, { fit: 'inside', withoutEnlargement: false })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const chars = ' .:-=+*#%@'
  const lines: string[] = []
  for (let y = 0; y < info.height; y++) {
    let line = ''
    for (let x = 0; x < info.width; x++) {
      const value = raw[y * info.width + x]
      line += chars[Math.min(chars.length - 1, Math.floor(((value ?? 0) / 256) * chars.length))] ?? ' '
    }
    lines.push(line)
  }
  return `${info.width}x${info.height}\n${lines.join('\n')}`
}

/** 终止块中可能携带的失败信息（兼容新老协议的宽松视图）。 */
interface FinishFailureView {
  kind?: string
  failure?: { message?: string }
}

/**
 * 为一个持久图像附件发起一次图像识别调用并返回识别模型的助手文本。
 * 附件引用随用户消息与提示词一起发送，路由适配器经附件服务解析字节——
 * 与任何视觉会话的路径一致。调用受与调用方取消信号融合的单次调用期限
 * 约束，且刻意独立于任何会话路由。
 * @param ctx - 提供 `llm` 与 `attachments` 服务的插件上下文。
 * @param settings - 识别路由与预算。
 * @param prompt - 精确提示词文本（调用方已做 `{path}` 替换）。
 * @param attachment - 待识别的持久图像附件。
 * @param signal - 与单次调用期限融合的调用方取消信号。
 * @returns 识别模型的助手文本，可能为 ''。
 * @throws 分类消息：`image recognition timed out after <ms>ms`、
 *   `image recognition was aborted before completion (tool timeout or caller
 *   cancellation)`、识别模型未声明图像输入、或适配器自身的流失败消息
 *   （调用方以自己的身份包装）。
 */
export async function recognizeAttachmentImage(
  ctx: Context,
  settings: ImageRecognitionSettings,
  prompt: string,
  attachment: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<string> {
  const llm = ctx.get('llm')
  const attachments = ctx.get('attachments')
  if (llm === undefined || attachments === undefined) {
    throw new Error('image recognition is unavailable: no llm or attachment service is mounted')
  }
  if (isAborted(signal)) {
    throw new Error('image recognition was aborted before completion (tool timeout or caller cancellation)')
  }
  // 流式调用前先解析识别器路由：配置错误的 provider 或未声明图像输入的
  // 模型应快速失败；启用灰度回退时，这种“没有视觉识别器”的失败会转为
  // 有边界的 ASCII 渲染。
  try {
    const info = await llm.resolveModelInfo(settings.provider, settings.model, signal)
    if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
      throw new Error(`recognizer model "${settings.provider}/${settings.model}" does not declare image input; configure a vision model for image recognition`)
    }
  } catch (error: unknown) {
    if (settings.grayscaleEnabled && isNoVisionRecognizerError(error)) {
      const stored = await attachments.readImage(attachment)
      return renderGrayscaleAscii(stored.data, settings.grayscaleSize)
    }
    throw error
  }
  const message = createUserMessage({
    content: [
      { type: 'text', text: prompt },
      { type: 'image', attachment },
    ],
    source: { kind: 'plugin', plugin: 'dsh-image-recognition' },
  })
  const parts: string[] = []
  using timeout = deadline(signal, settings.timeoutMs, IMAGE_RECOGNITION_TIMEOUT_CODE)
  const stream = llm.stream({
    provider: settings.provider,
    model: settings.model,
    messages: [message],
    maxTokens: settings.maxTokens,
    signal: timeout.signal,
  })
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        parts.push(chunk.text)
        continue
      }
      if (chunk.type === 'finish') {
        // 新协议下适配器失败会以带 failure 的终止块封口；旧协议直接抛出。
        const reason = chunk.reason as unknown as FinishFailureView
        if (reason.kind === 'error' && reason.failure !== undefined) {
          throw new Error(reason.failure.message ?? 'recognizer stream failed')
        }
      }
      // 其他块（block-start/block-end/usage/正常 finish）无需处理。
    }
  } catch (error: unknown) {
    if (timeoutOf(timeout.signal, IMAGE_RECOGNITION_TIMEOUT_CODE) !== undefined) {
      throw new Error(`image recognition timed out after ${settings.timeoutMs}ms`)
    }
    if (isAborted(signal)) {
      throw new Error('image recognition was aborted before completion (tool timeout or caller cancellation)')
    }
    // 调用方在自身的包装消息中命名识别器路由。
    throw error instanceof Error ? error : new Error(errorMessage(error))
  }
  if (timeoutOf(timeout.signal, IMAGE_RECOGNITION_TIMEOUT_CODE) !== undefined) {
    throw new Error(`image recognition timed out after ${settings.timeoutMs}ms`)
  }
  // 干净排空后的再次检查：期限可能在上一个块与本次读取之间触发。
  if (isAborted(signal)) {
    throw new Error('image recognition was aborted before completion (tool timeout or caller cancellation)')
  }
  return parts.join('')
}
