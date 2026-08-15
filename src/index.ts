/**
 * 图像识别能力插件：拥有统一的 `imageRecognition` 配置，并作为
 * `ctx.imageRecognition` 服务暴露，供 `read_image` 降级（dsh-tool-fs）与
 * 宿主发图入口（dsh-host-apiproxy）解析同一份配置。流式核心见本包的
 * `image-recognition.ts`；本插件是围绕它的组合与运行时配置 seam。
 *
 * ```yaml
 * - id: image-recognition
 *   name: 'dsh-image-recognition'
 *   config:
 *     enabled: true
 *     provider: opencode-go
 *     model: mimo-v2.5
 *     maxTokens: 1024
 * ```
 *
 * @module dsh-image-recognition
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  recognizeAttachmentImage,
  resolveImageRecognitionSettings,
} from './image-recognition.js'
import type { ImageRecognitionServiceShape, ImageRecognitionSettings } from './image-recognition.js'

/** Cordis 插件名（供加载器诊断使用）。 */
export const name = 'image-recognition'

/** 识别能力所需的服务。 */
export const inject = ['llm', 'attachments']

/** 插件配置（全部可选——逐字段应用随产品交付的默认值）。 */
export interface Config {
  /** 纯文本路由是否识别图像而不是拒绝。 */
  enabled?: boolean
  /** 承载识别模型的 provider 路由（注册到 `llm` 服务）。 */
  provider?: string
  /** 该路由上的模型 id，按路由目录的命名。 */
  model?: string
  /** 单次识别调用预算（毫秒）。 */
  timeoutMs?: number
  /** 单次输出 token 上限，作为识别请求的 `maxTokens` 发送。 */
  maxTokens?: number
  /** 随图像块一起发送的提示词；`{path}` 会被替换为图像路径。 */
  prompt?: string
  /** 没有可用视觉识别器时，是否回退为有边界的灰度 ASCII 渲染。 */
  grayscaleEnabled?: boolean
  /** 灰度回退网格宽/高（像素）。 */
  grayscaleSize?: number
}

/**
 * Schemastery 配置 schema。字段不带逐字段默认值：`settings()` 在服务访问时
 * 解析完整配置（插件配置覆盖随产品交付的默认值）。
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number(),
  maxTokens: z.number().step(1).min(1),
  prompt: z.string(),
  grayscaleEnabled: z.boolean(),
  grayscaleSize: z.number().step(1).min(1).max(128),
})

/**
 * 运行时识别服务，所有消费方解析。消费方自身的显式配置覆盖
 * `settings()`；没有时，插件配置（或随产品交付的默认值）生效。
 * 契约是共享的 `dsh-llm` 形态（见 `image-recognition.ts` 的
 * `ImageRecognitionServiceShape`）。
 */
export class ImageRecognitionService extends Service implements ImageRecognitionServiceShape {
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'imageRecognition')
  }

  /** 解析后的配置中识别是否启用。 */
  get enabled(): boolean {
    return this.settings().enabled
  }

  /**
   * 完整解析后的设置（插件配置覆盖随产品交付的默认值）。
   * @returns 完整设置对象。
   */
  settings(): ImageRecognitionSettings & { enabled: boolean } {
    return {
      enabled: this.config.enabled ?? true,
      ...resolveImageRecognitionSettings(this.config),
    }
  }

  /**
   * 识别一个持久图像附件并返回其描述文本。
   * @param attachment - 待识别的持久图像附件。
   * @param prompt - 精确提示词文本（调用方已做 `{path}` 替换）。
   * @param signal - 与单次调用期限融合的调用方取消信号。
   * @returns 识别模型的助手文本，可能为 ''。
   */
  recognizeAttachment(attachment: ImageAttachmentRef, prompt: string, signal?: AbortSignal): Promise<string> {
    return recognizeAttachmentImage(this.ctx, this.settings(), prompt, attachment, signal)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    imageRecognition: ImageRecognitionService
  }
}

/**
 * 注册插件：Service 构造函数立即注册 `ctx.imageRecognition`，并随所属
 * fiber 卸载自动注销。
 */
export function apply(ctx: Context, config: Config): void {
  new ImageRecognitionService(ctx, config)
}
