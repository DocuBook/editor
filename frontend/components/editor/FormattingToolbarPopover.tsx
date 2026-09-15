/** Overflows the compact (<640px web) formatting toolbar into a panel.
 *
 *  `.bn-toolbar` is a `flex-wrap: nowrap` row positioned by floating-ui from a
 *  measured rect, so at phone widths the tail buttons land past the viewport
 *  edge in a scroll container that cannot be reached. Moving those buttons
 *  behind one trigger removes the width problem instead of fighting it.
 *
 *  Mirrors `CreateLinkButtonPreserveUrl` in linkToolbar.tsx: a controlled
 *  popover with the toggle in the trigger's `onClick` and no `portalRoot`, so
 *  Mantine owns positioning and the portal. `position="top"` is a preference —
 *  flip moves the panel below when it does not fit above, shift keeps it on
 *  screen. Native macOS never renders this: `compact` comes from the same
 *  `isDesktop` media query as the rest of the shell, so no breakpoint is added. */
import { useEffect, useRef, useState, type ComponentProps, type ComponentType, type ReactNode, type Ref } from 'react'
import { useComponentsContext } from '@blocknote/react'
import { Ellipsis } from 'lucide-react'

export function FormattingToolbarPopover({ label, children }: { label: string; children: ReactNode }) {
  const Components = useComponentsContext()!
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  /** `ToolbarButtonType` omits `ref`, but the Mantine button is a forwardRef and
   *  `Popover.Target` merges the ref of its child. */
  const TriggerButton = Components.Generic.Toolbar.Button as ComponentType<
    ComponentProps<typeof Components.Generic.Toolbar.Button> & { ref?: Ref<HTMLButtonElement> }
  >

  /** Escape closes the panel and hands focus back to the trigger: the panel
   *  unmounts while one of its own buttons holds focus, which would drop focus
   *  to <body>. Capture phase, because the editor consumes the key first. */
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <Components.Generic.Popover.Root open={open} onOpenChange={setOpen} position="top">
      <Components.Generic.Popover.Trigger>
        {/** Generic.Toolbar (not FormattingToolbar) so the trigger is not
         *  re-styled by `.bn-mantine .bn-toolbar .mantine-Button-root`. */}
        <TriggerButton
          ref={triggerRef}
          className="bn-button"
          label={label}
          mainTooltip={label}
          icon={<Ellipsis size={14} />}
          isSelected={open}
          onClick={() => setOpen(current => !current)}
        />
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover" variant="form-popover">
        {/** A grid, not a column: a full-height stack is taller than the space
         *  the bubble menu has above it. */}
        <div data-testid="formatting-toolbar-more-panel" className="grid grid-cols-4 gap-0.5 p-1">
          {children}
        </div>
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  )
}
