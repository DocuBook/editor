/** File name with its path shown as secondary ("nested") metadata — the shared
 *  structure used by every file row that pairs a name with a path/folder hint.
 *
 *  Styling is entirely the caller's: this only lays out the two spans and skips
 *  the metadata span when there is none, so each surface passes its own classes
 *  (search modal, mention picker, git rows) instead of the label forcing one look. */
export default function FileMetaLabel({ name, meta, nameClassName, metaClassName }: {
  name: string
  meta?: string
  nameClassName?: string
  metaClassName?: string
}) {
  return (
    <>
      <span className={nameClassName}>{name}</span>
      {meta && <span className={metaClassName}>{meta}</span>}
    </>
  )
}
