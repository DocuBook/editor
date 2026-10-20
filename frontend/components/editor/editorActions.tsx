import { Fragment } from 'react'
import { BsMarkdown } from 'react-icons/bs'
import { LuPencilRuler } from 'react-icons/lu'
import type { EditMode } from '../../stores/editor'
import type { EditorAction } from './editorActionItems'

/** The one mode-switch icon, shared by every control that switches mode: shows
 *  the mode a click switches TO (markdown icon while in WYSIWYG, pencil-ruler
 *  while in source). Single source, so the controls can never drift apart. */
export function ModeSwitchIcon({ editMode, size }: { editMode: EditMode; size: number }) {
  return editMode === 'editor' ? <BsMarkdown size={size} /> : <LuPencilRuler size={size} />
}

/** The popover behind every Actions trigger. Rows use the same theme tokens and
 *  spacing as the sidebar context menu. */
export function EditorActionsMenu({ actions }: { actions: EditorAction[] }) {
  return (
    <div className="ui-popover absolute top-full right-0 mt-1 min-w-50 p-1 z-50">
      {actions.map(action => (
        <Fragment key={action.key}>
          {action.divider && <div className="border-t border-border-subtle my-1" />}
          <button onClick={action.onSelect} disabled={action.disabled} title={action.title}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 cursor-pointer text-[13px] bg-transparent border-none rounded hover:bg-surface-active disabled:opacity-40 disabled:cursor-not-allowed text-left">
            <span className="text-foreground-secondary shrink-0">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  )
}
