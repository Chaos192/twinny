import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import { Editor, EditorContent, JSONContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  VSCodeBadge,
  VSCodeButton,
  VSCodeDivider,
  VSCodePanelView
} from "@vscode/webview-ui-toolkit/react"
import cn from "classnames"

import { EVENT_NAME, USER, WORKSPACE_STORAGE_KEY } from "../common/constants"
import {
  ChatCompletionMessage,
  ClientMessage,
  MentionType,
  ServerMessage
} from "../common/types"

import { EmbeddingOptions } from "./embedding-options"
import {
  useAutosizeTextArea,
  useConversationHistory,
  useSuggestion,
  useSymmetryConnection,
  useTheme,
  useWorkSpaceContext
} from "./hooks"
import { Message as MessageComponent } from "./message"
import { ProviderSelect } from "./provider-select"
import TypingIndicator from "./typing-indicator"
import { CustomKeyMap  } from "./utils"

import styles from "./styles/index.module.css"

interface ChatProps {
  fullScreen?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = (props: ChatProps): JSX.Element => {
  const { fullScreen } = props
  const generatingRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const stopRef = useRef(false)
  const theme = useTheme()
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(false)
  const [messages, setMessages] = useState<ChatCompletionMessage[]>()
  const [completion, setCompletion] = useState<ChatCompletionMessage | null>()
  const markdownRef = useRef<HTMLDivElement>(null)
  const { symmetryConnection } = useSymmetryConnection()

  const disableAutoScrollRef = useRef(false)
  const [, setIsAtBottom] = useState(true)
  const { context: showProvidersContext, setContext: setShowProvidersContext } =
    useWorkSpaceContext<boolean>(WORKSPACE_STORAGE_KEY.showProviders)
  const {
    context: showEmbeddingOptionsContext,
    setContext: setShowEmbeddingOptionsContext
  } = useWorkSpaceContext<boolean>(WORKSPACE_STORAGE_KEY.showEmbeddingOptions)
  const { conversation, saveLastConversation, setActiveConversation } =
    useConversationHistory()

  const chatRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    if (markdownRef.current) {
      markdownRef.current.scrollTo({
        top: markdownRef.current.scrollHeight,
        behavior: "auto"
      })
    }
  }, [])

  const handleScroll = useCallback(() => {
    const el = markdownRef.current
    if (!el) return

    const isScrollable = el.scrollHeight > el.clientHeight

    if (!isScrollable) {
      setIsAtBottom(true)
      disableAutoScrollRef.current = false
      return
    }

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom < 50

    if (nearBottom) {
      setIsAtBottom(true)
      disableAutoScrollRef.current = false
    } else {
      disableAutoScrollRef.current = true
      setIsAtBottom(false)
    }
  }, [])

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0) {
      disableAutoScrollRef.current = true
    }
  }, [])

  useEffect(() => {
    const el = markdownRef.current
    if (!el) return

    el.addEventListener("scroll", handleScroll)
    el.addEventListener("wheel", handleWheel)

    const ro = new ResizeObserver(() => {
      const isScrollable = el.scrollHeight > el.clientHeight

      // Force scroll to bottom when content first becomes scrollable
      if (isScrollable && !disableAutoScrollRef.current) {
        scrollToBottom()
      }

      // Update scroll state
      handleScroll()
    })
    ro.observe(el)

    return () => {
      el.removeEventListener("scroll", handleScroll)
      el.removeEventListener("wheel", handleWheel)
      ro.disconnect()
    }
  }, [handleScroll, handleWheel, scrollToBottom])

  useEffect(() => {
    if (!disableAutoScrollRef.current) {
      scrollToBottom()
    }
  }, [messages, completion, isLoading, scrollToBottom])

  const handleAddMessage = (message: ServerMessage<ChatCompletionMessage>) => {
    if (!message.data) {
      setCompletion(null)
      setIsLoading(false)
      generatingRef.current = false
      return
    }

    setMessages((prev) => {
      if (message.data.id) {
        const existingIndex = prev?.findIndex((m) => m.id === message.data.id)

        if (existingIndex !== -1) {
          const updatedMessages = [...(prev || [])]

          updatedMessages[existingIndex || 0] = message.data

          saveLastConversation({
            ...conversation,
            messages: updatedMessages
          })
          return updatedMessages
        }
      }

      const messages = [...(prev || []), message.data]
      saveLastConversation({
        ...conversation,
        messages: messages
      })
      return messages
    })

    setTimeout(() => {
      editorRef.current?.commands.focus()
      stopRef.current = false
    }, 200)

    setCompletion(null)
    setIsLoading(false)
  }

  const handleCompletionMessage = (
    message: ServerMessage<ChatCompletionMessage>
  ) => {
    setCompletion(message.data)
    if (!disableAutoScrollRef.current) {
      scrollToBottom()
    }
  }

  const handleLoadingMessage = () => {
    setIsLoading(true)
    if (!disableAutoScrollRef.current) {
      scrollToBottom()
    }
  }

  const messageEventHandler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    switch (message.type) {
      case EVENT_NAME.twinnyAddMessage: {
        handleAddMessage(message as ServerMessage<ChatCompletionMessage>)
        break
      }
      case EVENT_NAME.twinnyOnCompletion: {
        handleCompletionMessage(message as ServerMessage<ChatCompletionMessage>)
        break
      }
      case EVENT_NAME.twinnyOnLoading: {
        handleLoadingMessage()
        break
      }
      case EVENT_NAME.twinnyNewConversation: {
        setMessages([])
        setCompletion(null)
        setActiveConversation(undefined)
        generatingRef.current = false
        setIsLoading(false)
        chatRef.current?.focus()
        setTimeout(() => {
          stopRef.current = false
        }, 1000)
        break
      }
      case EVENT_NAME.twinnyStopGeneration: {
        setIsLoading(false)
        setCompletion(null)
        stopRef.current = false
        generatingRef.current = false
        setTimeout(() => {
          chatRef.current?.focus()
        }, 200)
      }
    }
  }

  const handleStopGeneration = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyStopGeneration
    } as ClientMessage)
  }

  const handleRegenerateMessage = (index: number): void => {
    generatingRef.current = true
    setIsLoading(true)
    setMessages((prev) => {
      if (!prev) return prev
      const updatedMessages = prev.slice(0, index)

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages
      } as ClientMessage)

      return updatedMessages
    })
  }

  const handleDeleteMessage = (index: number): void => {
    setMessages((prev) => {
      if (!prev || prev.length === 0) return prev

      if (prev.length === 2) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        ...prev.slice(index + 2)
      ]

      saveLastConversation({
        ...conversation,
        messages: updatedMessages
      })

      return updatedMessages
    })
  }

  const handleEditMessage = (message: string, index: number): void => {
    generatingRef.current = true
    setIsLoading(true)
    setMessages((prev) => {
      if (!prev) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        { ...prev[index], content: message }
      ]

      global.vscode.postMessage({
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages
      } as ClientMessage)

      return updatedMessages
    })
  }

  const getMentions = () => {
    const mentions: MentionType[] = []
    editorRef.current?.getJSON().content?.forEach((node) => {
      if (node.type === "paragraph" && Array.isArray(node.content)) {
        node.content.forEach((innerNode: JSONContent) => {
          if (innerNode.type === "mention" && innerNode.attrs) {
            mentions.push({
              name:
                innerNode.attrs.label ||
                innerNode.attrs.id.split("/").pop() ||
                "",
              path: innerNode.attrs.id
            })
          }
        })
      }
    })

    return mentions
  }

  const replaceMentionsInText = useCallback(
    (text: string, mentions: MentionType[]): string => {
      return mentions.reduce(
        (result, mention) => result.replace(mention.path, `@${mention.name}`),
        text
      )
    },
    []
  )

  const handleSubmitForm = () => {
    const input = editorRef.current?.getText().trim()

    if (!input || generatingRef.current) return

    generatingRef.current = true

    const mentions = getMentions()

    setIsLoading(true)
    clearEditor()
    setMessages((prevMessages) => {
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prevMessages || []),
        { role: USER, content: replaceMentionsInText(input, mentions) }
      ]

      const clientMessage: ClientMessage<
        ChatCompletionMessage[],
        MentionType[]
      > = {
        type: EVENT_NAME.twinnyChatMessage,
        data: updatedMessages,
        meta: mentions
      }

      saveLastConversation({
        ...conversation,
        messages: updatedMessages
      })

      global.vscode.postMessage(clientMessage)

      return updatedMessages
    })

    if (!disableAutoScrollRef.current) {
      scrollToBottom()
    }
  }

  const clearEditor = useCallback(() => {
    editorRef.current?.commands.clearContent()
  }, [])

  const handleToggleProviderSelection = () => {
    if (showEmbeddingOptionsContext) handleToggleEmbeddingOptions()
    setShowProvidersContext((prev) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: WORKSPACE_STORAGE_KEY.showProviders,
        data: !prev
      } as ClientMessage)
      return !prev
    })
  }

  const handleToggleEmbeddingOptions = () => {
    if (showProvidersContext) handleToggleProviderSelection()
    setShowEmbeddingOptionsContext((prev) => {
      global.vscode.postMessage({
        type: EVENT_NAME.twinnySetWorkspaceContext,
        key: WORKSPACE_STORAGE_KEY.showEmbeddingOptions,
        data: !prev
      } as ClientMessage)
      return !prev
    })
  }

  const handleNewConversation = () => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyNewConversation
    })
  }

  useEffect(() => {
    global.vscode.postMessage({
      type: EVENT_NAME.twinnyHideBackButton
    })
  }, [])

  useEffect(() => {
    window.addEventListener("message", messageEventHandler)
    editorRef.current?.commands.focus()
    scrollToBottom()
    return () => {
      window.removeEventListener("message", messageEventHandler)
    }
  }, [])

  useEffect(() => {
    if (conversation?.messages?.length) {
      return setMessages(conversation.messages)
    }
  }, [conversation?.id])

  const { suggestion, filePaths } = useSuggestion()

  const memoizedSuggestion = useMemo(
    () => suggestion,
    [JSON.stringify(filePaths)]
  )

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Mention.configure({
          HTMLAttributes: {
            class: "mention"
          },
          suggestion: memoizedSuggestion,
          renderText({ node }) {
            if (node.attrs.name) {
              return `${node.attrs.name ?? node.attrs.id}`
            }
            return node.attrs.id ?? ""
          }
        }),
        CustomKeyMap.configure({
          handleSubmitForm,
          clearEditor
        }),
        Placeholder.configure({
          placeholder: t("placeholder") // "How can twinny help you today?",
        })
      ]
    },
    [memoizedSuggestion]
  )

  useAutosizeTextArea(chatRef, editorRef.current?.getText() || "")

  useEffect(() => {
    if (editor) editorRef.current = editor
    editorRef.current?.commands.focus()
  }, [editor])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.extensionManager.extensions.forEach((extension) => {
        if (extension.name === "mention") {
          extension.options.suggestion = memoizedSuggestion
        }
      })
    }
  }, [memoizedSuggestion])

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        {!!fullScreen && (
          <div className={styles.fullScreenActions}>
            <VSCodeButton
              onClick={handleNewConversation}
              appearance="icon"
              title={t("new-conversation")}
            >
              <i className="codicon codicon-comment-discussion" />
            </VSCodeButton>
          </div>
        )}
        <h4 className={styles.title}>
          {conversation?.title
            ? conversation?.title
            : generatingRef.current && <span>New conversation</span>}
        </h4>
        <div
          className={cn({
            [styles.markdown]: !fullScreen,
            [styles.markdownFullScreen]: fullScreen
          })}
          ref={markdownRef}
        >
          {messages?.map((message, index) => (
            <MessageComponent
              key={index}
              onRegenerate={handleRegenerateMessage}
              onUpdate={handleEditMessage}
              onDelete={handleDeleteMessage}
              isLoading={isLoading || generatingRef.current}
              isAssistant={index % 2 !== 0}
              conversationLength={messages?.length}
              message={message}
              theme={theme}
              index={index}
            />
          ))}
          {isLoading && !completion ? (
            <div className={cn(styles.message, styles.assistantMessage)}>
              <TypingIndicator />
            </div>
          ) : (
            !!completion && (
              <MessageComponent
                isLoading={false}
                isAssistant
                theme={theme}
                message={{
                  ...completion
                }}
              />
            )
          )}
        </div>
        {showProvidersContext && showEmbeddingOptionsContext && (
          <VSCodeDivider />
        )}
        {showEmbeddingOptionsContext && !symmetryConnection && (
          <EmbeddingOptions />
        )}
        <div className={styles.chatOptions}>
          <div>
            {generatingRef.current && !symmetryConnection && (
              <VSCodeButton
                type="button"
                appearance="icon"
                onClick={handleStopGeneration}
                aria-label={t("stop-generation")}
              >
                <span className="codicon codicon-debug-stop"></span>
              </VSCodeButton>
            )}
          </div>
          <div>
            {!symmetryConnection && (
              <>
                <VSCodeButton
                  title={t("toggle-embedding-options")}
                  appearance="icon"
                  onClick={handleToggleEmbeddingOptions}
                >
                  <span className="codicon codicon-database"></span>
                </VSCodeButton>
              </>
            )}
            {!!symmetryConnection && (
              <a
                href={`https://twinny.dev/symmetry/?id=${symmetryConnection.id}`}
              >
                {/* TODO interpolate */}
                <VSCodeBadge
                  title={`Connected to symmetry network provider ${symmetryConnection?.name}, model ${symmetryConnection?.modelName}, provider ${symmetryConnection?.provider}`}
                >
                  ⚡️ {symmetryConnection?.name}
                </VSCodeBadge>
              </a>
            )}
          </div>
        </div>
        <form>
          <div className={styles.chatBox}>
            <EditorContent
              className={styles.tiptap}
              editor={editorRef.current}
            />
            <div
              role="button"
              onClick={handleSubmitForm}
              className={styles.chatSubmit}
            >
              <span className="codicon codicon-send"></span>
            </div>
          </div>
        </form>
        <ProviderSelect />
      </div>
    </VSCodePanelView>
  )
}
