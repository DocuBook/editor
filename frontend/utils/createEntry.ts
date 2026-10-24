import { invoke } from '../lib/ipc'
import { useEditorStore } from '../stores/editor'
import { useVaultStore } from '../stores/vault'

export type EntryKind = 'file' | 'folder'

/** The one create path for every new note and folder: compact New note, the
 *  sidebar form (context menu, popover, shortcuts). The vault picks the final
 *  name and returns where the entry landed. A created note is opened, then the
 *  tree is reloaded, because the sidebar list is a snapshot. */
export async function createEntry(kind: EntryKind, name: string, folder = ''): Promise<string> {
  const path = folder && !name.startsWith(folder + '/') ? `${folder}/${name}` : name
  const created = await invoke<string>('create_entry', { kind, path })
  if (kind === 'file') await useEditorStore.getState().openFile(created, created.split('/').pop() ?? created)
  await useVaultStore.getState().loadTree()
  return created
}
