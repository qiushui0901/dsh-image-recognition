/**
 * 图像识别插件测试：配置解析（空节时使用随产品交付的默认值）、
 * `ctx.imageRecognition` 服务表面（settings 与 recognizeAttachment 委托给
 * 共享核心）、以及消费方解析的有效配置（本地节 > 插件服务 > 默认值）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmService, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as ImageRecognition from '../src/index.ts'
import { resolveEffectiveImageRecognition } from '../src/image-recognition.ts'
import type { ImageRecognitionServiceShape } from '../src/image-recognition.ts'

const ATTACHMENT: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:00'),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
  name: 'red.png',
}

/** 可脚本化的识别路由适配器，记录每次流式调用。 */
class RecognitionAdapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  text = '一张红色图片。'

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context
let adapter: RecognitionAdapter

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(LlmService)
  adapter = new RecognitionAdapter()
  ctx.llm.registerAdapter(['opencode-go'], adapter)
  ctx.provide('attachments', {} as never)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('image-recognition plugin', () => {
  it('空配置节时以随产品交付的默认值注册服务', async () => {
    await ctx.plugin(ImageRecognition)
    const service = ctx.get('imageRecognition')
    if (service === undefined) throw new Error('expected the imageRecognition service')
    expect(service.enabled).toBe(true)
    expect(service.settings()).toMatchObject({
      enabled: true,
      provider: 'opencode-go',
      model: 'mimo-v2.5',
      timeoutMs: 120_000,
    })
    expect(service.settings().prompt).toContain('图像识别助手')
  })

  it('插件配置覆盖随产品交付的默认值', async () => {
    await ctx.plugin(ImageRecognition, { enabled: false, provider: 'opencode-go', model: 'mimo-v2.5-pro' })
    const service = ctx.get('imageRecognition')
    if (service === undefined) throw new Error('expected the imageRecognition service')
    expect(service.enabled).toBe(false)
    expect(service.settings().model).toBe('mimo-v2.5-pro')
  })

  it('通过服务识别一个附件', async () => {
    await ctx.plugin(ImageRecognition)
    const service = ctx.get('imageRecognition')
    if (service === undefined) throw new Error('expected the imageRecognition service')

    const text = await service.recognizeAttachment(ATTACHMENT, '请描述 red.png。')
    expect(text).toBe('一张红色图片。')
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]).toMatchObject({ provider: 'opencode-go', model: 'mimo-v2.5' })
  })

  it('暴露配置 schema 作为插件 Config', () => {
    expect(ImageRecognition.name).toBe('image-recognition')
    expect(ImageRecognition.inject).toEqual(['llm', 'attachments'])
    const resolved = ImageRecognition.Config({ enabled: false })
    expect(resolved.enabled).toBe(false)
    expect(resolved.model).toBeUndefined()
  })
})

describe('resolveEffectiveImageRecognition', () => {
  it('本地节逐字段优先，其次插件服务，最后默认值', () => {
    const service: ImageRecognitionServiceShape = {
      enabled: true,
      settings: () => ({ enabled: true, provider: 'opencode-go', model: 'mimo-v2.5', timeoutMs: 120_000, prompt: 'service prompt' }),
      recognizeAttachment: async () => '',
    }
    expect(resolveEffectiveImageRecognition(undefined, service)).toEqual({
      enabled: true, provider: 'opencode-go', model: 'mimo-v2.5', timeoutMs: 120_000, prompt: 'service prompt',
    })
    expect(resolveEffectiveImageRecognition({ enabled: false, model: 'mimo-v2.5-pro' }, service)).toEqual({
      enabled: false, provider: 'opencode-go', model: 'mimo-v2.5-pro', timeoutMs: 120_000, prompt: 'service prompt',
    })
  })

  it('没有服务时回退到随产品交付的默认值', () => {
    const fallback = resolveEffectiveImageRecognition(undefined, undefined)
    expect(fallback).toMatchObject({ enabled: true, provider: 'opencode-go', model: 'mimo-v2.5', timeoutMs: 120_000 })
    expect(fallback.prompt).toContain('图像识别助手')
  })
})
