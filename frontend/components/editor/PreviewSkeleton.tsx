import { Skeleton } from '@mantine/core'

/** The one loading placeholder for source-backed previews, shared by every
 *  preview kind so the "reserve space, do not flash raw source" recipe lives in
 *  exactly one place.
 *
 *  Two shapes, because the call sites differ:
 *   - `block` reserves a full diagram/equation box (96px).
 *   - `inline` sits inside a paragraph, so it only takes a line's worth of
 *     width and must stay on the text baseline instead of forcing a 96px gap
 *     into the middle of a sentence. */
export const PreviewSkeleton = ({ inline = false }: { inline?: boolean }) =>
  inline
    ? <Skeleton height={14} width="4.5em" radius="sm" animate data-testid="preview-skeleton-inline" style={{ display: 'inline-block', verticalAlign: 'middle' }} />
    : <Skeleton height={96} radius="sm" animate data-testid="preview-skeleton" />
