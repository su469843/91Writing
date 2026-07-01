import backendApi from './backendApi.js'
import billingService from './billing.js'
import { ElMessage } from 'element-plus'

class APIService {
  constructor() {
    this.config = {
      apiKey: '',
      baseURL: '/api/ai',
      models: [],
      defaultModel: '',
      selectedModel: '',
      maxTokens: 4096,
      temperature: 0.7
    }
  }

  async loadUserConfig() {
    try {
      const config = await backendApi.getAIConfig()
      if (config) {
        this.config.selectedModel = config.model || ''
        this.config.maxTokens = config.max_tokens || 4096
        this.config.temperature = config.temperature || 0.7
      }
    } catch {
      console.log('后端配置未就绪，使用默认配置')
    }
  }

  getConfig() {
    return { ...this.config, apiKey: '' }
  }

  async updateConfig(newConfig) {
    Object.assign(this.config, newConfig)
    if (newConfig.apiKey || newConfig.selectedModel || newConfig.baseURL) {
      try {
        await backendApi.saveAIConfig({
          provider: 'deepseek',
          api_key: newConfig.apiKey || '',
          base_url: newConfig.baseURL || 'https://api.deepseek.com',
          model: newConfig.selectedModel || this.config.selectedModel,
          max_tokens: newConfig.maxTokens || this.config.maxTokens,
          temperature: newConfig.temperature || this.config.temperature
        })
      } catch (error) {
        console.error('保存 API 配置到后端失败:', error)
      }
    }
  }

  buildURL(endpoint) {
    return `/api/ai${endpoint}`
  }

  buildHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    }
    const token = backendApi.token
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return headers
  }

  async makeRequest(endpoint, options = {}) {
    const url = this.buildURL(endpoint)
    const headers = this.buildHeaders()

    const requestOptions = {
      method: 'POST',
      headers,
      ...options
    }

    try {
      const response = await fetch(url, requestOptions)

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(`API请求失败: ${response.status} - ${errorData.error?.message || errorData.error || '未知错误'}`)
      }

      return await response.json()
    } catch (error) {
      console.error('API请求错误:', error)
      throw error
    }
  }

  async generateText(prompt, options = {}) {
    const model = options.model || this.config.selectedModel || this.config.defaultModel || 'deepseek-chat'

    const estimatedInputTokens = billingService.estimateTokens(prompt)

    const requestBody = {
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: options.maxTokens || this.config.maxTokens,
      temperature: options.temperature || this.config.temperature,
      stream: false
    }

    try {
      const response = await this.makeRequest('/chat/completions', {
        body: JSON.stringify(requestBody)
      })

      const content = response.choices?.[0]?.message?.content || ''
      const usage = response.usage

      if (usage) {
        billingService.recordAPICall({
          type: options.type || 'generation',
          model: model,
          content: prompt,
          response: content,
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          status: 'success'
        })
      } else {
        const outputTokens = billingService.estimateTokens(content)
        billingService.recordAPICall({
          type: options.type || 'generation',
          model: model,
          content: prompt,
          response: content,
          inputTokens: estimatedInputTokens,
          outputTokens: outputTokens,
          status: 'success'
        })
      }

      return content
    } catch (error) {
      billingService.recordAPICall({
        type: options.type || 'generation',
        model: model,
        content: prompt,
        response: '',
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        status: 'failed'
      })
      throw error
    }
  }

  async generateTextStream(prompt, options = {}, onChunk = null) {
    if (!this.config.selectedModel && !options.model) {
      throw new Error('未配置 AI 模型，请先在设置中配置 API')
    }

    const model = options.model || this.config.selectedModel || 'deepseek-chat'

    if (!prompt || typeof prompt !== 'string') {
      throw new Error('无效的prompt参数')
    }

    let cleanPrompt = prompt
    try {
      cleanPrompt = prompt.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      JSON.stringify({ content: cleanPrompt })
    } catch (cleanError) {
      console.error('Prompt清理失败:', cleanError)
      throw new Error('提示词包含无法处理的字符，请检查输入内容')
    }

    const estimatedInputTokens = billingService.estimateTokens(cleanPrompt)

    const maxTokens = options.maxTokens || this.config.maxTokens || null

    const requestBody = {
      model: model,
      messages: [
        {
          role: 'user',
          content: cleanPrompt
        }
      ],
      max_tokens: maxTokens || undefined,
      temperature: options.temperature || this.config.temperature,
      stream: true
    }

    const url = this.buildURL('/chat/completions')
    const headers = this.buildHeaders()

    let fullContent = ''
    let hasError = false

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(300000)
      })

      if (!response.ok) {
        const errorText = await response.text()
        hasError = true
        try {
          const errorData = JSON.parse(errorText)
          throw new Error(`API请求失败: ${response.status} - ${errorData.error?.details || errorData.error || '未知错误'}`)
        } catch (parseError) {
          throw new Error(`API请求失败: ${response.status} - ${errorText}`)
        }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      let streamFinished = false
      let buffer = ''
      let processedChunks = 0
      let lastProgressTime = Date.now()
      let noDataTimeout = null

      const resetNoDataTimeout = () => {
        if (noDataTimeout) {
          clearTimeout(noDataTimeout)
        }
        noDataTimeout = setTimeout(() => {
          console.log('警告：30秒内没有接收到新数据，但流未结束')
        }, 30000)
      }

      resetNoDataTimeout()

      try {
        while (!streamFinished) {
          const { done, value } = await reader.read()

          if (done) {
            if (noDataTimeout) {
              clearTimeout(noDataTimeout)
            }
            break
          }

          const chunk = decoder.decode(value, { stream: true })

          lastProgressTime = Date.now()
          resetNoDataTimeout()

          buffer += chunk

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmedLine = line.trim()

            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6).trim()

              if (data === '[DONE]') {
                streamFinished = true
                break
              }

              if (!data || data === '') {
                continue
              }

              try {
                const parsed = JSON.parse(data)
                const content = parsed.choices?.[0]?.delta?.content || ''

                if (content) {
                  fullContent += content
                  processedChunks++

                  if (onChunk) {
                    try {
                      onChunk(content, fullContent)
                    } catch (chunkError) {
                      console.error('onChunk回调错误:', chunkError)
                    }
                  }
                }

                if (parsed.choices?.[0]?.finish_reason) {
                  streamFinished = true
                  break
                }

                if (parsed.error) {
                  console.error('API返回错误:', parsed.error)
                  throw new Error(`API错误: ${parsed.error.message || '未知错误'}`)
                }
              } catch (e) {
                if (e.message.startsWith('API错误:')) {
                  throw e
                }
              }
            }
          }
        }

        if (buffer.trim() && !streamFinished) {
          const trimmedLine = buffer.trim()
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6).trim()
            if (data !== '[DONE]' && data !== '') {
              try {
                const parsed = JSON.parse(data)
                const content = parsed.choices?.[0]?.delta?.content || ''
                if (content) {
                  fullContent += content
                  if (onChunk) {
                    onChunk(content, fullContent)
                  }
                }
              } catch (e) {
                console.log('缓冲区数据解析失败:', e.message)
              }
            }
          }
        }

        if (noDataTimeout) {
          clearTimeout(noDataTimeout)
        }

        if (fullContent.length === 0) {
          console.warn('警告：流式生成完成但没有获得任何内容')
        }

      } catch (streamError) {
        if (noDataTimeout) {
          clearTimeout(noDataTimeout)
        }

        if (fullContent.length > 0 && (
          streamError.name === 'AbortError' ||
          streamError.message.includes('timeout') ||
          streamError.message.includes('network')
        )) {
          ElMessage.warning('网络不稳定，已获得部分生成内容')
        } else {
          hasError = true
          throw streamError
        }
      } finally {
        try {
          reader.releaseLock()
        } catch (e) {
          console.log('释放reader锁失败:', e.message)
        }
      }

      const outputTokens = billingService.estimateTokens(fullContent)
      billingService.recordAPICall({
        type: options.type || 'generation',
        model: model,
        content: cleanPrompt,
        response: fullContent,
        inputTokens: estimatedInputTokens,
        outputTokens: outputTokens,
        status: 'success'
      })

      return fullContent
    } catch (error) {
      console.error('流式生成错误:', error)
      if (hasError) {
        billingService.recordAPICall({
          type: options.type || 'generation',
          model: model,
          content: cleanPrompt,
          response: fullContent,
          inputTokens: estimatedInputTokens,
          outputTokens: billingService.estimateTokens(fullContent),
          status: 'failed'
        })
      }
      throw error
    }
  }

  async generateOutline(theme, keywords, template) {
    const templateInfo = template ? `\n参考模板：${template.name} - ${template.description}` : ''
    const keywordList = keywords ? `\n关键词：${keywords}` : ''

    const prompt = `请为以下主题生成一个详细的小说大纲：
主题：${theme}${templateInfo}${keywordList}

要求：
1. 生成5-8个章节
2. 每个章节用 ### 开头，后跟章节标题
3. 每个章节下面写2-3句话描述该章节的主要内容
4. 整体结构要完整，有开头、发展、高潮、结局
5. 符合所选模板的风格特点

请直接输出大纲内容：`

    return await this.generateTextStream(prompt, {}, null)
  }

  async generateOutlineStream(theme, keywords, template, onChunk = null) {
    const templateInfo = template ? `\n参考模板：${template.name} - ${template.description}` : ''
    const keywordList = keywords ? `\n关键词：${keywords}` : ''

    const prompt = `请为以下主题生成一个详细的小说大纲：
主题：${theme}${templateInfo}${keywordList}

要求：
1. 生成5-8个章节
2. 每个章节用 ### 开头，后跟章节标题
3. 每个章节下面写2-3句话描述该章节的主要内容
4. 整体结构要完整，有开头、发展、高潮、结局
5. 符合所选模板的风格特点

请直接输出大纲内容：`

    return await this.generateTextStream(prompt, {}, onChunk)
  }

  async generateChapterContent(chapterTitle, chapterOutline, previousContent = '', template = null, characters = [], worldSettings = [], novelInfo = {}) {
    const templateInfo = template ? `\n写作风格：${template.style}\n写作提示：${template.writingTips}` : ''
    const contextInfo = previousContent ? `\n前文内容参考：${previousContent.slice(-500)}` : ''

    let novelBasicInfo = ''
    if (novelInfo.title || novelInfo.genre || novelInfo.intro || novelInfo.theme) {
      novelBasicInfo += '\n\n小说基本信息：'
      if (novelInfo.title) novelBasicInfo += `\n- 小说名称：${novelInfo.title}`
      if (novelInfo.genre) novelBasicInfo += `\n- 小说类型：${novelInfo.genre}`
      if (novelInfo.theme) novelBasicInfo += `\n- 小说主题：${novelInfo.theme}`
      if (novelInfo.intro) novelBasicInfo += `\n- 小说简介：${novelInfo.intro}`
    }

    let charactersInfo = ''
    if (characters.length > 0) {
      charactersInfo = '\n\n人物设定：'
      characters.forEach(char => {
        charactersInfo += `\n- ${char.name}：${char.description}`
        if (char.traits && char.traits.length > 0) {
          charactersInfo += ` (特点：${char.traits.join('、')})`
        }
      })
    }

    let worldInfo = ''
    if (worldSettings.length > 0) {
      worldInfo = '\n\n世界观设定：'
      worldSettings.forEach(setting => {
        worldInfo += `\n- ${setting.title}：${setting.description}`
      })
    }

    const prompt = `请根据以下信息生成小说章节内容：
章节标题：${chapterTitle}
章节大纲：${chapterOutline}${novelBasicInfo}${templateInfo}${contextInfo}${charactersInfo}${worldInfo}

要求：
1. 字数控制在800-1200字
2. 内容要生动有趣，符合章节大纲
3. 语言流畅，描写细腻
4. 如果有前文内容，要保持连贯性
5. 符合所选模板的风格特点
6. 充分利用提供的人物设定和世界观设定
7. 确保人物行为符合其性格特点
8. 场景描写要符合世界观设定
9. 内容要符合小说的整体类型、主题和设定
10. 保持与小说简介和整体风格的一致性

请直接输出章节内容：`

    return await this.generateTextStream(prompt, {}, null)
  }

  async generateChapterContentStream(chapterTitle, chapterOutline, previousContent = '', template = null, characters = [], worldSettings = [], novelInfo = {}, onChunk = null) {
    const templateInfo = template ? `\n写作风格：${template.style}\n写作提示：${template.writingTips}` : ''
    const contextInfo = previousContent ? `\n前文内容参考：${previousContent.slice(-500)}` : ''

    let novelBasicInfo = ''
    if (novelInfo.title || novelInfo.genre || novelInfo.intro || novelInfo.theme) {
      novelBasicInfo += '\n\n小说基本信息：'
      if (novelInfo.title) novelBasicInfo += `\n- 小说名称：${novelInfo.title}`
      if (novelInfo.genre) novelBasicInfo += `\n- 小说类型：${novelInfo.genre}`
      if (novelInfo.theme) novelBasicInfo += `\n- 小说主题：${novelInfo.theme}`
      if (novelInfo.intro) novelBasicInfo += `\n- 小说简介：${novelInfo.intro}`
    }

    let charactersInfo = ''
    if (characters.length > 0) {
      charactersInfo = '\n\n人物设定：'
      characters.forEach(char => {
        charactersInfo += `\n- ${char.name}：${char.description}`
        if (char.traits && char.traits.length > 0) {
          charactersInfo += ` (特点：${char.traits.join('、')})`
        }
      })
    }

    let worldInfo = ''
    if (worldSettings.length > 0) {
      worldInfo = '\n\n世界观设定：'
      worldSettings.forEach(setting => {
        worldInfo += `\n- ${setting.title}：${setting.description}`
      })
    }

    const prompt = `请根据以下信息生成小说章节内容：
章节标题：${chapterTitle}
章节大纲：${chapterOutline}${novelBasicInfo}${templateInfo}${contextInfo}${charactersInfo}${worldInfo}

要求：
1. 字数控制在800-1200字
2. 内容要生动有趣，符合章节大纲
3. 语言流畅，描写细腻
4. 如果有前文内容，要保持连贯性
5. 符合所选模板的风格特点
6. 充分利用提供的人物设定和世界观设定
7. 确保人物行为符合其性格特点
8. 场景描写要符合世界观设定
9. 内容要符合小说的整体类型、主题和设定
10. 保持与小说简介和整体风格的一致性

请直接输出章节内容：`

    return await this.generateTextStream(prompt, {}, onChunk)
  }

  async chatWithAI(message, chatHistory = []) {
    const messages = [
      {
        role: 'system',
        content: '你是一个专业的小说写作助手，擅长帮助用户进行创意写作、情节构思、人物塑造等。请用友好、专业的语气回答用户的问题。'
      },
      ...chatHistory.map(msg => ({
        role: msg.isUser ? 'user' : 'assistant',
        content: msg.content
      })),
      {
        role: 'user',
        content: message
      }
    ]

    const requestBody = {
      model: this.config.selectedModel || this.config.defaultModel || 'deepseek-chat',
      messages,
      max_tokens: this.config.maxTokens,
      temperature: 0.7
    }

    const response = await this.makeRequest('/chat/completions', {
      body: JSON.stringify(requestBody)
    })

    return response.choices?.[0]?.message?.content || ''
  }

  async generateSummary(content, options = {}) {
    const { length = 'medium', type = 'keypoints' } = options

    let lengthInstruction = ''
    switch (length) {
      case 'short':
        lengthInstruction = '请生成50-100字的简短摘要'
        break
      case 'medium':
        lengthInstruction = '请生成100-200字的中等长度摘要'
        break
      case 'long':
        lengthInstruction = '请生成200-300字的详细摘要'
        break
    }

    let typeInstruction = ''
    switch (type) {
      case 'keypoints':
        typeInstruction = '重点提取文章的关键要点和核心内容'
        break
      case 'plot':
        typeInstruction = '重点概括故事情节和主要事件'
        break
      case 'character':
        typeInstruction = '重点分析人物特点和关系'
        break
      case 'theme':
        typeInstruction = '重点阐述文章的主题思想和深层含义'
        break
    }

    const prompt = `${lengthInstruction}，${typeInstruction}。\n\n文章内容：\n${content}`

    return await this.generateTextStream(prompt, {
      maxTokens: null,
      temperature: 0.3
    }, null)
  }

  async getWritingAdvice(content) {
    const prompt = `请对以下文章内容提供写作建议：

${content}

请从以下几个方面给出具体建议：
1. 语言表达
2. 情节结构
3. 人物塑造
4. 描写技巧
5. 整体改进方向

建议：`

    return await this.generateTextStream(prompt, { maxTokens: null }, null)
  }

  async generatePersonalizedContent(prompt, corpus) {
    const corpusText = corpus.map(item => item.content).join('\n\n')
    const personalizedPrompt = `参考以下写作风格和内容：

${corpusText}

现在请根据上述风格，生成以下内容：
${prompt}

要求：
1. 保持与参考内容相似的写作风格
2. 语言表达要一致
3. 内容要原创且符合要求

生成内容：`

    return await this.generateTextStream(personalizedPrompt, {}, null)
  }

  async generateGeneralContent(keywords, template, outline, wordLimit = 500) {
    const templateInfo = template ? `\n写作风格：${template.style}\n写作提示：${template.writingTips}` : ''
    const outlineInfo = outline ? `\n参考大纲：${outline}` : ''
    const keywordList = keywords ? `\n关键词：${keywords}` : ''

    const prompt = `请根据以下信息生成小说内容：${keywordList}${templateInfo}${outlineInfo}

要求：
1. 字数控制在${wordLimit}字左右
2. 内容要生动有趣，情节引人入胜
3. 语言流畅，描写细腻
4. 符合所选模板的风格特点
5. 如果有大纲，要与大纲保持一致

请直接输出小说内容：`

    return await this.generateTextStream(prompt, {}, null)
  }

  async generateGeneralContentStream(keywords, template, outline, wordLimit = 500, onChunk = null) {
    const templateInfo = template ? `\n写作风格：${template.style}\n写作提示：${template.writingTips}` : ''
    const outlineInfo = outline ? `\n参考大纲：${outline}` : ''
    const keywordList = keywords ? `\n关键词：${keywords}` : ''

    const prompt = `请根据以下信息生成小说内容：${keywordList}${templateInfo}${outlineInfo}

要求：
1. 字数控制在${wordLimit}字左右
2. 内容要生动有趣，情节引人入胜
3. 语言流畅，描写细腻
4. 符合所选模板的风格特点
5. 如果有大纲，要与大纲保持一致

请直接输出小说内容：`

    return await this.generateTextStream(prompt, {}, onChunk)
  }

  getAvailableModels() {
    return this.config.models
  }

  async validateAPIKey() {
    try {
      const config = await backendApi.getAIConfig()
      return config && config.api_key && config.api_key.length > 0
    } catch {
      return false
    }
  }

  async generateCharacter(theme, characterType = '') {
    const typeInfo = characterType ? `角色类型：${characterType}` : ''
    const prompt = `请根据主题"${theme}"生成一个小说人物，${typeInfo}

要求：
1. 提供人物的基本信息（姓名、年龄、职业等）
2. 详细的外貌描述
3. 性格特点和行为习惯
4. 背景故事和经历
5. 人物的特殊技能或能力
6. 与主题相关的特征

请以JSON格式返回：
{
  "name": "人物姓名",
  "age": "年龄",
  "occupation": "职业",
  "appearance": "外貌描述",
  "personality": "性格特点",
  "background": "背景故事",
  "skills": ["技能1", "技能2"],
  "traits": ["特征1", "特征2", "特征3"]
}`

    try {
      const response = await this.generateTextStream(prompt, {}, null)
      return JSON.parse(response)
    } catch (error) {
      console.error('生成人物失败:', error)
      throw error
    }
  }

  async generateWorldSetting(theme, settingType = '') {
    const typeInfo = settingType ? `设定类型：${settingType}` : ''
    const prompt = `请根据主题"${theme}"生成一个小说世界观设定，${typeInfo}

要求：
1. 设定的名称和概述
2. 详细的背景描述
3. 重要的规则或法则
4. 地理环境或空间结构
5. 历史背景或重要事件
6. 与主题相关的特色元素

请以JSON格式返回：
{
  "title": "设定名称",
  "overview": "概述",
  "description": "详细描述",
  "rules": ["规则1", "规则2"],
  "geography": "地理环境",
  "history": "历史背景",
  "features": ["特色1", "特色2"]
}`

    try {
      const response = await this.generateTextStream(prompt, {}, null)
      return JSON.parse(response)
    } catch (error) {
      console.error('生成世界观设定失败:', error)
      throw error
    }
  }

  async analyzeArticle(content) {
    try {
      const prompt = `请对以下文章进行深度分析，并以JSON格式返回分析结果：

文章内容：
${content}

请分析以下方面：
1. 情感倾向（积极/消极/中性）
2. 文章标签（最多5个关键标签）
3. 文章分类（玄幻/都市/悬疑/科幻/历史/校园/武侠/其他）
4. 文章评分（0-100分，考虑文笔、情节、结构等）
5. 详细评价（包括优点、缺点、改进建议）

返回格式：
{
  "sentiment": "积极/消极/中性",
  "tags": ["标签1", "标签2", "标签3"],
  "category": "分类",
  "score": 85,
  "evaluation": {
    "strengths": ["优点1", "优点2"],
    "weaknesses": ["缺点1", "缺点2"],
    "suggestions": ["建议1", "建议2"]
  },
  "summary": "整体评价总结"
}`

      const requestBody = {
        model: this.config.selectedModel || this.config.defaultModel || 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是一位专业的文学评论家和编辑，擅长分析各种类型的文章。请客观、专业地分析文章，给出建设性的评价和建议。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 1000,
        temperature: 0.3
      }

      const url = this.buildURL('/chat/completions')
      const headers = this.buildHeaders()

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()

      if (data.choices && data.choices[0] && data.choices[0].message) {
        const analysisText = data.choices[0].message.content.trim()

        try {
          const analysis = JSON.parse(analysisText)
          return analysis
        } catch (parseError) {
          console.error('解析AI分析结果失败:', parseError)
          return {
            sentiment: '中性',
            tags: ['AI分析'],
            category: '其他',
            score: 70,
            evaluation: {
              strengths: ['内容完整'],
              weaknesses: ['AI分析解析失败'],
              suggestions: ['请检查内容格式']
            },
            summary: 'AI分析暂时不可用，使用基础分析结果'
          }
        }
      } else {
        throw new Error('AI响应格式错误')
      }
    } catch (error) {
      console.error('文章分析失败:', error)
      throw error
    }
  }
}

export default new APIService()
