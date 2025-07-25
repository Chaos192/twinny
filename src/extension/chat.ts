import * as cheerio from "cheerio"
import { CompletionResponseChunk, TokenJS } from "fluency.js"
import {
  CompletionNonStreaming,
  CompletionStreaming,
  LLMProvider
} from "fluency.js/dist/chat"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import {
  commands,
  DiagnosticSeverity,
  ExtensionContext,
  languages,
  StatusBarItem,
  Webview,
  window,
  workspace
} from "vscode"

import {
  API_PROVIDERS,
  ASSISTANT,
  DEFAULT_RELEVANT_CODE_COUNT,
  DEFAULT_RELEVANT_FILE_COUNT,
  DEFAULT_RERANK_THRESHOLD,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_SESSION_NAME,
  SYMMETRY_EMITTER_KEY,
  SYSTEM,
  USER,
  WEBUI_TABS,
  WORKSPACE_STORAGE_KEY
} from "../common/constants/"
import { CodeLanguageDetails } from "../common/languages"
import { logger } from "../common/logger"
import { models } from "../common/models"
import {
  AnyContextItem,
  ChatCompletionMessage,
  CompletionNonStreamingWithId,
  CompletionStreamingWithId,
  ServerMessage,
  TemplateData
} from "../common/types"
import { kebabToSentence } from "../webview/utils"

import { Base } from "./base"
import { EmbeddingDatabase } from "./embeddings"
import { FileHandler } from "./file-handler"
import { TwinnyProvider } from "./provider-manager"
import { Reranker } from "./reranker"
import { SessionManager } from "./session-manager"
import { SymmetryService } from "./symmetry-service"
import { TemplateProvider } from "./template-provider"
import { FileTreeProvider } from "./tree"
import {
  getIsOpenAICompatible,
  getLanguage,
  sanitizeWorkspaceName,
  updateLoadingMessage
} from "./utils"

export class Chat extends Base {
  private _completion = ""
  private _controller?: AbortController
  private _conversation: ChatCompletionMessage[] = []
  private _db?: EmbeddingDatabase
  private _fileTreeProvider = new FileTreeProvider()
  private _functionArguments = ""
  private _functionId = ""
  private _functionName = ""
  private _isCollectingFunctionArgs = false
  private _lastStreamingRequest?: CompletionStreaming<LLMProvider>
  private _lastRequest?: CompletionNonStreaming<LLMProvider>
  private _reranker: Reranker
  private _sessionManager: SessionManager | undefined
  private _statusBar: StatusBarItem
  private _symmetryService?: SymmetryService
  private _templateProvider?: TemplateProvider
  private _tokenJs: TokenJS | undefined
  private _webView?: Webview
  private _isCancelled = false
  private _fileHandler: FileHandler
  private _workspaceName = sanitizeWorkspaceName(workspace.name)

  constructor(
    statusBar: StatusBarItem,
    templateDir: string | undefined,
    extensionContext: ExtensionContext,
    webView: Webview,
    db: EmbeddingDatabase | undefined,
    sessionManager: SessionManager | undefined,
    symmetryService: SymmetryService
  ) {
    super(extensionContext)
    this._webView = webView
    this._statusBar = statusBar
    this._templateProvider = new TemplateProvider(templateDir)
    this._reranker = new Reranker()
    this._db = db
    this._sessionManager = sessionManager
    this._symmetryService = symmetryService
    this._fileHandler = new FileHandler(webView)
    this.setupSymmetryListeners()
  }

  private setupSymmetryListeners() {
    this._symmetryService?.on(
      SYMMETRY_EMITTER_KEY.inference,
      (completion: string) => {
        this._webView?.postMessage({
          type: EVENT_NAME.twinnyOnCompletion,
          data: {
            content: completion.trimStart(),
            role: ASSISTANT
          }
        } as ServerMessage<ChatCompletionMessage>)
      }
    )
  }

  private async getRelevantFiles(
    text: string | undefined
  ): Promise<[string, number][]> {
    if (!this._db || !text || !this._workspaceName) return []

    const table = `${this._workspaceName}-file-paths`
    if (await this._db.hasEmbeddingTable(table)) {
      const embedding = await this._db.fetchModelEmbedding(text)
      if (!embedding) return []

      const relevantFileCountContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRelevantFilePaths}`
      const stored = this.context?.globalState.get(
        relevantFileCountContext
      ) as number
      const relevantFileCount = Number(stored) || DEFAULT_RELEVANT_FILE_COUNT

      const filePaths =
        (await this._db.getDocuments(embedding, relevantFileCount, table)) || []

      if (!filePaths.length) return []

      return this.rerankFiles(
        text,
        filePaths.map((f) => f.content)
      )
    }

    return []
  }

  private getRerankThreshold() {
    const rerankThresholdContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRerankThreshold}`
    const stored = this.context?.globalState.get(
      rerankThresholdContext
    ) as number
    const rerankThreshold = stored || DEFAULT_RERANK_THRESHOLD
    return rerankThreshold
  }

  private async rerankFiles(
    text: string | undefined,
    filePaths: string[] | undefined
  ) {
    if (!this._db || !text || !this._workspaceName || !filePaths?.length)
      return []

    const rerankThreshold = this.getRerankThreshold()
    logger.log(`Reranking threshold: ${rerankThreshold}`)
    const fileNames = filePaths?.map((filePath) => path.basename(filePath))
    const scores = await this._reranker.rerank(text, fileNames)
    if (!scores) return []

    return filePaths.map(
      (filePath, index) => [filePath, scores[index]] as [string, number]
    )
  }

  private async readFileContent(
    filePath: string | undefined,
    maxFileSize: number = 5 * 1024
  ): Promise<string | null> {
    if (!filePath) return null
    try {
      const stats = await fs.stat(filePath)
      if (stats.size > maxFileSize) return null
      if (stats.size === 0) return ""
      const content = await fs.readFile(filePath, "utf-8")
      return content
    } catch {
      return null
    }
  }

  private async getRelevantCode(
    text: string | undefined,
    relevantFiles: [string, number][]
  ): Promise<string> {
    if (!this._db || !text || !this._workspaceName) return ""

    const table = `${this._workspaceName}-documents`
    const rerankThreshold = this.getRerankThreshold()

    if (await this._db.hasEmbeddingTable(table)) {
      const relevantCodeCountContext = `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRelevantCodeSnippets}`
      const stored = this.context?.globalState.get(
        relevantCodeCountContext
      ) as number
      const relevantCodeCount = Number(stored) || DEFAULT_RELEVANT_CODE_COUNT

      const embedding = await this._db.fetchModelEmbedding(text)
      if (!embedding) return ""

      const query = relevantFiles?.length
        ? `file IN ("${relevantFiles.map((file) => file[0]).join("\",\"")}")`
        : ""

      const queryEmbeddedDocuments =
        (await this._db.getDocuments(
          embedding,
          Math.round(relevantCodeCount / 2),
          table,
          query
        )) || []

      const embeddedDocuments =
        (await this._db.getDocuments(
          embedding,
          Math.round(relevantCodeCount / 2),
          table
        )) || []

      const documents = [...embeddedDocuments, ...queryEmbeddedDocuments]
      const documentScores = await this._reranker.rerank(
        text,
        documents.map((item) => (item.content ? item.content.trim() : ""))
      )

      if (!documentScores) return ""

      const readThreshould = rerankThreshold
      const readFileChunks = []

      for (let i = 0; i < relevantFiles.length; i++) {
        if (relevantFiles[i][1] > readThreshould) {
          try {
            const fileContent = await this.readFileContent(relevantFiles[i][0])
            readFileChunks.push(fileContent)
          } catch (error) {
            console.error(`Error reading file ${relevantFiles[i][0]}:`, error)
          }
        }
      }

      const documentChunks = documents
        .filter((_, index) => documentScores[index] > rerankThreshold)
        .map(({ content }) => content)

      return [readFileChunks.filter(Boolean), documentChunks.filter(Boolean)]
        .join("\n\n")
        .trim()
    }

    return ""
  }

  private async onPart(response: CompletionResponseChunk) {
    try {
      const delta = response.choices[0]?.delta

      if (delta?.content) {
        this._completion += delta.content

        await this._webView?.postMessage({
          type: EVENT_NAME.twinnyOnCompletion,
          data: {
            content: this._completion.trimStart() || " ",
            role: ASSISTANT
          }
        } as ServerMessage<ChatCompletionMessage>)
      }
    } catch (error) {
      console.error("Error processing stream part:", error)
    }
  }

  public abort = () => {
    this._isCancelled = true
    this._statusBar.text = "$(code)"
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    this._controller?.abort()
  }

  private buildTemplatePrompt = async (
    template: string,
    language: CodeLanguageDetails,
    context?: string
  ) => {
    const editor = window.activeTextEditor
    const selection = editor?.selection
    const selectionContext =
      editor?.document.getText(selection) || context || ""

    const prompt = await this._templateProvider?.readTemplate<TemplateData>(
      template,
      {
        code: selectionContext || "",
        language: language?.langName || "unknown"
      }
    )
    return { prompt: prompt || "", selection: selectionContext }
  }

  private async llmNoStream(requestBody: CompletionNonStreaming<LLMProvider>) {
    this._controller = new AbortController()

    this._lastRequest = requestBody
    this._completion = ""
    this._functionArguments = ""
    this._functionName = ""
    this._isCollectingFunctionArgs = false

    if (!this._tokenJs || this._isCancelled) return

    try {
      const result = await this._tokenJs.chat.completions.create(requestBody)

      this._webView?.postMessage({
        type: EVENT_NAME.twinnyStopGeneration
      } as ServerMessage<ChatCompletionMessage>)

      this._webView?.postMessage({
        type: EVENT_NAME.twinnyAddMessage,
        data: {
          content: result.choices[0].message.content,
          role: ASSISTANT
        }
      } as ServerMessage<ChatCompletionMessage>)
    } catch (error) {
      this._controller?.abort()
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyStopGeneration
      } as ServerMessage<ChatCompletionMessage>)

      this._webView?.postMessage({
        type: EVENT_NAME.twinnyAddMessage,
        data: {
          content: error instanceof Error ? error.message : String(error),
          role: ASSISTANT
        }
      } as ServerMessage<ChatCompletionMessage>)
    }
  }

  private async llmStream(requestBody: CompletionStreamingWithId) {
    this._controller = new AbortController()

    this._lastStreamingRequest = requestBody
    this._completion = ""
    this._functionArguments = ""
    this._functionName = ""
    this._isCollectingFunctionArgs = false

    if (!this._tokenJs || this._isCancelled) return

    try {
      logger.log(
        `Chat completion request: ${JSON.stringify({
          model: requestBody.model,
          messages: requestBody.messages,
          stream: true,
          temperature: requestBody.temperature,
          max_tokens: requestBody.max_tokens
        })}`
      )

      const result = await this._tokenJs.chat.completions.create(requestBody)

      for await (const part of result) {
        if (this._controller?.signal.aborted) {
          break
        }

        await this.onPart(part)
      }

      const timestamp = Math.floor(Date.now() / 1000)
      const responseId = `chatcmpl-${timestamp}-${Math.random()
        .toString(36)
        .substring(2, 10)}`

      logger.log(
        `Chat completion response: ${JSON.stringify({
          id: responseId,
          object: "chat.completion",
          created: timestamp,
          model: requestBody.model || "unknown",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: this._completion.trim()
              },
              finish_reason: "stop"
            }
          ]
        })}`
      )

      await this._webView?.postMessage({
        type: EVENT_NAME.twinnyAddMessage,
        data: {
          content: this._completion.trim(),
          role: ASSISTANT
        }
      } as ServerMessage<ChatCompletionMessage>)

      this._webView?.postMessage({
        type: EVENT_NAME.twinnyStopGeneration
      } as ServerMessage<ChatCompletionMessage>)

      this._completion = ""
    } catch (error) {
      this._controller?.abort()
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyStopGeneration
      } as ServerMessage<ChatCompletionMessage>)

      this._webView?.postMessage({
        type: EVENT_NAME.twinnyAddMessage,
        data: {
          content: error instanceof Error ? error.message : String(error),
          role: ASSISTANT
        }
      } as ServerMessage<ChatCompletionMessage>)
    }
  }

  private sendEditorLanguage = () => {
    this._webView?.postMessage({
      type: EVENT_NAME.twinnySendLanguage,
      data: getLanguage()
    } as ServerMessage)
  }

  private focusChatTab = () => {
    this._webView?.postMessage({
      type: EVENT_NAME.twinnySetTab,
      data: WEBUI_TABS.chat
    } as ServerMessage<string>)
  }

  getProblemsContext(): string {
    const problems = workspace.textDocuments
      .flatMap((document) =>
        languages.getDiagnostics(document.uri).map((diagnostic) => ({
          severity: DiagnosticSeverity[diagnostic.severity],
          message: diagnostic.message,
          code: document.getText(diagnostic.range),
          line: document.lineAt(diagnostic.range.start.line).text,
          lineNumber: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1,
          source: diagnostic.source,
          diagnosticCode: diagnostic.code
        }))
      )
      .map((problem) => JSON.stringify(problem))
      .join("\n")

    return problems
  }

  public async getRagContext(text?: string): Promise<string | null> {
    const symmetryConnected = this._sessionManager?.get(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection
    )

    let combinedContext = ""

    const workspaceMentioned = text?.includes("@workspace")
    const problemsMentioned = text?.includes("@problems")

    if (symmetryConnected) return null

    let problemsContext = ""
    if (problemsMentioned) {
      problemsContext = this.getProblemsContext()
      if (problemsContext) combinedContext += problemsContext + "\n\n"
    }

    const prompt = text?.replace(/@workspace|@problems/g, "")
    let relevantFiles: [string, number][] | null = []
    let relevantCode: string | null = ""

    if (workspaceMentioned) {
      updateLoadingMessage(this._webView, "Exploring knowledge base")
      relevantFiles = await this.getRelevantFiles(prompt)
      relevantCode = await this.getRelevantCode(prompt, relevantFiles)
    }

    if (relevantFiles?.length) {
      const filesTemplate =
        await this._templateProvider?.readTemplate<TemplateData>(
          "relevant-files",
          { code: relevantFiles.map((file) => file[0]).join(", ") }
        )
      combinedContext += filesTemplate + "\n\n"
    }

    if (relevantCode) {
      const codeTemplate =
        await this._templateProvider?.readTemplate<TemplateData>(
          "relevant-code",
          { code: relevantCode }
        )
      combinedContext += codeTemplate
    }

    return combinedContext.trim() || null
  }

  private async loadFileContents(files?: AnyContextItem[]): Promise<string> {
    if (!files?.length) return ""
    let fileContents = ""

    for (const file of files) {
      try {
        const workspaceFolders = workspace.workspaceFolders
        if (!workspaceFolders) continue

        const filePath = path.join(workspaceFolders[0].uri.fsPath, file.path)

        const content = await fs.readFile(filePath, "utf-8")
        fileContents += `File: ${file.name}\n\n${content}\n\n`
      } catch (error) {
        console.error(`Error reading file ${file.path}:`, error)
      }
    }
    return fileContents.trim()
  }

  private async getSystemPrompt(): Promise<string> {
    return (
      (await this._templateProvider?.readTemplate<TemplateData>("system", {
        cwd: workspace.workspaceFolders?.[0].uri.fsPath,
        defaultShell: os.userInfo().shell,
        osName: os.platform(),
        homedir: os.homedir()
      })) || ""
    )
  }

  private async buildAdditionalContext(
    messageContent: string,
    filePaths?: AnyContextItem[]
  ): Promise<string> {
    const editor = window.activeTextEditor
    const userSelection = editor?.document.getText(editor.selection)

    let context = userSelection ? `Selected Code:\n${userSelection}\n\n` : ""
    const ragContext = await this.getRagContext(messageContent)
    if (ragContext) context += `Additional Context:\n${ragContext}\n\n`

    const workspaceFiles =
      this.context?.workspaceState.get<AnyContextItem[]>(
        WORKSPACE_STORAGE_KEY.contextItems
      ) || []
    const allFilePaths = [...(filePaths || []), ...workspaceFiles]

    const fileContents = await this.loadFileContents(
      allFilePaths.filter(
        (filepath) => !["workspace", "problems"].includes(filepath.name)
      )
    )
    if (fileContents) context += `File Contents:\n${fileContents}\n\n`

    return context
  }

  private instantiateTokenJS(provider: TwinnyProvider) {
    this._tokenJs = new TokenJS({
      baseURL: this.getProviderBaseUrl(provider),
      apiKey: provider.apiKey
    })
  }

  private async buildConversation(
    messages: ChatCompletionMessage[],
    fileContexts: AnyContextItem[] | undefined,
    id?: string
  ): Promise<ChatCompletionMessage[]> {
    const systemMessage: ChatCompletionMessage = {
      role: SYSTEM,
      content: await this.getSystemPrompt(),
      id
    }

    const lastMessage = messages[messages.length - 1]
    const messageContent = lastMessage.content?.toString() || ""
    const additionalContext = await this.buildAdditionalContext(
      messageContent,
      fileContexts
    )

    const conversation = [systemMessage, ...messages.slice(0, -1)]

    conversation.push({
      role: USER,
      content: `${lastMessage.content}\n\n${additionalContext.trim()}`.trim(),
      images: lastMessage.images
    })

    return conversation.map((message) => {
      const role = message.role
      const $ = cheerio.load(message.content as string)
      $("img").remove()

      const text = $.html("body")
        .replace(/&lt;/g, "<")
        .replace(/<body>|<\/body>/g, "")
        .replace(/@problems/g, "")
        .trim()
        .replace(/@workspace/g, "")
        .trim()
        .replace(/&amp;/g, "&")
        .replace(/&gt;/g, ">")
        .replace(/<span[^>]*data-type="mention"[^>]*>(.*?)<\/span>/g, "$1")
        .trimStart()

      const images =
        message.images?.map((img) => ({
          type: "image_url" as const,
          image_url: { url: typeof img === "string" ? img : img.data }
        })) || []

      const textPart = {
        type: "text" as const,
        text: images.length ? text : message.content
      }
      const contentParts =
        images.length > 0 ? [textPart, ...images] : [textPart]

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = {
        role,
        content: contentParts
      }

      if (role === "function" && message.name) {
        result.name = message.name
      }

      if (message.id) {
        result.id = message.id
      }

      return result as ChatCompletionMessage
    })
  }

  private shouldUseStreaming(provider: TwinnyProvider): boolean {
    const supportsStreaming =
      models[provider?.provider as keyof typeof models]?.supportsStreaming
    return Array.isArray(supportsStreaming)
      ? supportsStreaming.includes(provider.modelName)
      : true
  }

  private getStreamOptions(
    provider: TwinnyProvider,
    conversationId?: string
  ): CompletionStreamingWithId {
    const request = {
      messages: this._conversation,
      model: provider.modelName,
      stream: true as const,
      id: conversationId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: this.getProviderType(provider) as any
    }

    if (provider.provider !== API_PROVIDERS.Twinny) {
      delete request.id
    }

    return request
  }

  private getNoStreamOptions(
    provider: TwinnyProvider
  ): CompletionNonStreamingWithId {
    return {
      messages: this._conversation.filter((m) => m.role !== "system"),
      model: provider.modelName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: this.getProviderType(provider) as any
    }
  }

  private getProviderType(provider: TwinnyProvider) {
    return getIsOpenAICompatible(provider)
      ? API_PROVIDERS.OpenAICompatible
      : provider.provider
  }

  public resetConversation() {
    this._conversation = []
  }

  public async getTemplateMessages(
    template: string,
    context?: string
  ): Promise<ChatCompletionMessage[]> {
    this._statusBar.text = "$(loading~spin)"
    const { language } = getLanguage()
    this._completion = ""
    this.sendEditorLanguage()

    const { prompt, selection } = await this.buildTemplatePrompt(
      template,
      language,
      context
    )

    this.focusChatTab()

    this._webView?.postMessage({
      type: EVENT_NAME.twinnyAddMessage,
      data: {
        role: USER,
        content:
          `${kebabToSentence(
            template
          )}\n\n\n<pre><code>${selection}</code></pre>`.trim() || " "
      }
    } as ServerMessage<ChatCompletionMessage>)

    let ragContext = undefined
    if (["explain"].includes(template)) {
      ragContext = await this.getRagContext(selection)
    }

    const userContent = ragContext
      ? `${prompt}\n\nAdditional Context:\n${ragContext}`
      : prompt

    const provider = this.getProvider()
    if (!provider) return []

    this._conversation.push({
      role: USER,
      content: userContent.trim() || " "
    })

    return this._conversation
  }

  public async completion(
    messages: ChatCompletionMessage[],
    fileContexts?: AnyContextItem[],
    conversationId?: string
  ) {
    this._completion = ""
    this._isCancelled = false
    this.sendEditorLanguage()

    const provider = this.getProvider()

    if (!provider) return

    this.instantiateTokenJS(provider)

    this._conversation = await this.buildConversation(
      messages,
      fileContexts,
      conversationId
    )

    const stream = this.shouldUseStreaming(provider)

    return stream
      ? this.llmStream(this.getStreamOptions(provider, conversationId))
      : this.llmNoStream(this.getNoStreamOptions(provider))
  }

  public async templateCompletion(promptTemplate: string, context?: string) {
    this._isCancelled = false
    this._conversation = await this.getTemplateMessages(promptTemplate, context)
    const provider = this.getProvider()
    if (!provider) return []

    this.instantiateTokenJS(provider)

    const stream = this.shouldUseStreaming(provider)

    return stream
      ? this.llmStream(this.getStreamOptions(provider))
      : this.llmNoStream(this.getNoStreamOptions(provider))
  }

  public async generateSimpleCompletion(
    prompt: string
  ): Promise<string | undefined> {
    const provider = this.getProvider()
    if (!provider) {
      logger.error("No provider configured for simple completion.")
      return undefined
    }

    this.instantiateTokenJS(provider)

    if (!this._tokenJs) {
      logger.error("TokenJS not initialized for simple completion.")
      return undefined
    }

    const messages: ChatCompletionMessage[] = [{ role: USER, content: prompt }]

    const completionParams: CompletionNonStreaming<LLMProvider> = {
      messages: messages,
      model: provider.modelName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: this.getProviderType(provider) as any
    }

    try {
      const result = await this._tokenJs.chat.completions.create(
        completionParams
      )

      if (
        result.choices &&
        result.choices.length > 0 &&
        result.choices[0].message
      ) {
        return result.choices[0].message.content?.trim()
      }
      logger.log("LLM response for simple completion was empty or malformed.")
      return undefined
    } catch {
      logger.error("Error during simple LLM completion")
      return undefined
    }
  }
}
