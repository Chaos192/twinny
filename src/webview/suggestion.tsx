/* eslint-disable @typescript-eslint/no-explicit-any */
import { RefAttributes } from "react"
import { MentionNodeAttrs } from "@tiptap/extension-mention"
import { ReactRenderer } from "@tiptap/react"
import { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion"
import tippy, { Instance as TippyInstance } from "tippy.js"

import { topLevelItems } from "../common/constants"
import { CategoryType, FileItem } from "../common/types"

import { MentionList, MentionListProps, MentionListRef } from "./mention-list"

export const getSuggestions = (fileList: string[]) => ({
  items: ({ query }: { query: string }): FileItem[] => {
    const fileItems = fileList.map((file) => {
      const isFolder = !file.includes(".")
      return {
        name: file.split("/").pop() || file,
        path: file,
        category: isFolder
          ? ("folders" as CategoryType)
          : ("files" as CategoryType)
      }
    })

    if (query) {
      return fileItems.filter((item) =>
        item.name.toLowerCase().startsWith(query.toLowerCase())
      )
    }

    return topLevelItems
  },

  render: () => {
    let component: ReactRenderer<
      MentionListRef,
      MentionListProps & RefAttributes<MentionListRef>
    >
    let popup: TippyInstance[]

    return {
      onStart: (props: SuggestionProps<MentionNodeAttrs>) => {
        component = new ReactRenderer(MentionList, {
          props,
          editor: props.editor
        })

        const getReferenceClientRect = props.clientRect as () => DOMRect

        if (!props.clientRect) {
          return
        }

        popup = tippy("body", {
          getReferenceClientRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "top-start"
        })
      },

      onUpdate(props: SuggestionProps<MentionNodeAttrs>) {
        component.updateProps({
          ...props,
          items: getSuggestions(fileList).items({ query: props.query })
        })

        if (!props.clientRect) {
          return
        }

        popup[0].setProps({
          getReferenceClientRect: props.clientRect as () => DOMRect
        })
      },

      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === "Escape") {
          popup[0].hide()
          return true
        }

        return component.ref?.onKeyDown(props) || false
      },

      onExit() {
        if (popup.length > 0) {
          popup[0].destroy()
          component.destroy()
        }
      }
    }
  }
})
