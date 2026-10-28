import { create } from 'zustand'

/** The mutating git operation running anywhere in the Git UI ('' = none).
 *  Commit, Push, Sync, branch switch and conflict staging used to keep their
 *  own busy flags, so one could start while another was still writing the
 *  index. The backend refuses the overlap too; this keeps the buttons honest. */
export const useGitOperation = create<{ active: string }>(() => ({ active: '' }))

export async function withGitOperation<T>(label: string, task: () => Promise<T>): Promise<T> {
  const { active } = useGitOperation.getState()
  if (active) throw new Error(`Wait for ${active} to finish`)
  useGitOperation.setState({ active: label })
  try {
    return await task()
  } finally {
    useGitOperation.setState({ active: '' })
  }
}
