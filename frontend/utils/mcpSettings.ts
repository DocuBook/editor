/** Pure merge/validation helpers for the MCP server settings form.
 *
 *  The form used to build these arrays inline in JSX, which made the save
 *  payload — the part that decides whether a stored bearer token is kept,
 *  replaced, or dropped — impossible to test without mounting the settings
 *  pane. Keeping it here makes the contract explicit and unit-testable. */

/** One configured remote MCP server, as the backend reports it. */
export interface McpServer {
  name: string
  url: string
  timeoutSeconds?: number | null
  hasToken: boolean
  token?: string
  /** Set only on an edit that must clear the stored token. */
  removeToken?: boolean
}

/** The "add a server" form fields, all strings because they come from inputs. */
export interface McpServerDraft {
  name: string
  url: string
  timeoutSeconds: string
  token: string
}

/** The "edit a server" form fields. */
export interface McpServerEdit {
  url: string
  timeoutSeconds: string
  token: string
  removeToken: boolean
}

/** A blank timeout field means "use the server default". */
export function parseTimeout(value: string): number | null {
  const trimmed = value.trim()
  return trimmed ? Number(trimmed) : null
}

/** True when every override is a whole number inside `1..max`. `null`/absent
 *  means the server default and is always valid. */
export function timeoutsValid(servers: readonly Pick<McpServer, 'timeoutSeconds'>[], max: number): boolean {
  return servers.every(server => server.timeoutSeconds == null
    || (Number.isInteger(server.timeoutSeconds) && server.timeoutSeconds >= 1 && server.timeoutSeconds <= max))
}

/** Append a server from the add form. `hasToken` describes the *saved* state:
 *  a fresh row only claims a token when one is being submitted with it, and the
 *  list is refreshed from the backend after the save anyway. */
export function addMcpServer(servers: readonly McpServer[], draft: McpServerDraft): McpServer[] {
  return [...servers, {
    name: draft.name,
    url: draft.url,
    timeoutSeconds: parseTimeout(draft.timeoutSeconds),
    hasToken: !!draft.token,
    token: draft.token,
  }]
}

/** Apply the edit form to one server.
 *
 *  Token semantics, in precedence order: `removeToken` clears it; a non-empty
 *  field replaces it; an empty field leaves the stored one untouched. That is
 *  what the backend expects, so a user editing only the URL does not wipe their
 *  credentials. */
export function editMcpServer(servers: readonly McpServer[], name: string, edit: McpServerEdit): McpServer[] {
  return servers.map(server => server.name !== name ? server : {
    ...server,
    url: edit.url,
    timeoutSeconds: parseTimeout(edit.timeoutSeconds),
    ...(edit.removeToken
      ? { token: '', removeToken: true }
      : edit.token ? { token: edit.token } : {}),
  })
}

/** Drop one server by name. */
export function removeMcpServer(servers: readonly McpServer[], name: string): McpServer[] {
  return servers.filter(server => server.name !== name)
}
