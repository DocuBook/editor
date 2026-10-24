# Changelog

## v0.4.0 — 2026-10-24


### 🚀 Features

* **auth:** enforce password policy with live setup checklist ([#315](https://github.com/DocuBook/editor/issues/315)) ([6230c19](https://github.com/DocuBook/editor/commit/6230c192d391aa6f603c690e8bb1fbc281ab24a3))
* **editor:** add compact empty-state new note action ([#313](https://github.com/DocuBook/editor/issues/313)) ([7053e01](https://github.com/DocuBook/editor/commit/7053e0199399440efb98113f110fc7cbd4b9b65f))
* **rust-ai:** page large MCP context results instead of rejecting them ([cff32c1](https://github.com/DocuBook/editor/commit/cff32c126ddfc0b1840d4cff0a98fcaabaae359c))


### 🐛 Bug Fixes

* **ai:** preserve text outside selected range ([#309](https://github.com/DocuBook/editor/issues/309)) ([7d2737a](https://github.com/DocuBook/editor/commit/7d2737a9ab2306ec1c40841e870c4d5a2b8a438c))
* **ai:** scope SSE cancellation to page lifecycle ([#307](https://github.com/DocuBook/editor/issues/307)) ([27319e4](https://github.com/DocuBook/editor/commit/27319e4ca0265c73fc8c0a0bfbe892aabdcdfc34))
* **ai:** show "Generating…" until operations reach the editor ([#306](https://github.com/DocuBook/editor/issues/306)) ([03f8139](https://github.com/DocuBook/editor/commit/03f81394ce3b1f3c583f4714a53d48e58f3fedf6))
* **editor:** close the active tab on cmd+w and polish the compact switcher ([#310](https://github.com/DocuBook/editor/issues/310)) ([d8e7a09](https://github.com/DocuBook/editor/commit/d8e7a095ae914c46706f7090024234cb2011f5c7))
* **editor:** enlarge compact tab badge tap target and ime-aware switcher ([#312](https://github.com/DocuBook/editor/issues/312)) ([96f83f9](https://github.com/DocuBook/editor/commit/96f83f947f9598b78f0b3ee0ca6b487948301fa1))
* **editor:** hide compact empty-state prompt and outline the new note action ([e0841be](https://github.com/DocuBook/editor/commit/e0841be105ebb94fcbce77ebcb1e1030452013ad))
* **frontend:** adjust code block spacing ([0922460](https://github.com/DocuBook/editor/commit/092246043f768be5530da1d661a499d579fac6c3))
* **rust-ai:** honor Stop during stalled streams and poisoned locks ([#301](https://github.com/DocuBook/editor/issues/301)) ([cf4c632](https://github.com/DocuBook/editor/commit/cf4c6321a2eaa06000d14d3ae600e1ee4b62e8cd))
* **rust-ai:** use secure context result handles ([58945eb](https://github.com/DocuBook/editor/commit/58945eb30482722ee131d95f631d4aa48640c02a))
* **settings:** render MCP edit Save/Cancel as real buttons ([#316](https://github.com/DocuBook/editor/issues/316)) ([00fab85](https://github.com/DocuBook/editor/commit/00fab854ad20492bf04c2cdc604825a4507c3129))
* **tauri:** extend macOS overlay drag region ([#308](https://github.com/DocuBook/editor/issues/308)) ([2969616](https://github.com/DocuBook/editor/commit/29696168513af420060576850c63957b83187ff0))
* **vault:** prevent duplicate names on creation ([#314](https://github.com/DocuBook/editor/issues/314)) ([2d2cf39](https://github.com/DocuBook/editor/commit/2d2cf39645b7fb930e9a7e21bfa37d391c077915))


### 🛡️ Security

* **editor:** harden note content surfaces and scope sync per vault ([#304](https://github.com/DocuBook/editor/issues/304)) ([bfde2c4](https://github.com/DocuBook/editor/commit/bfde2c4119cb36d272b7862ea581f97bf9e3f2d3))

## v0.3.0 — 2026-10-20


### 🚀 Features

* **tabbar:** unify actions menu and add desktop editor actions ([#300](https://github.com/DocuBook/editor/issues/300)) ([be77254](https://github.com/DocuBook/editor/commit/be772546d9d05d8ce3555bd747e38c1dce260939))


### 🐛 Bug Fixes

* **sidebar:** keep panel tab labels uncut and icon tabs tappable ([#298](https://github.com/DocuBook/editor/issues/298)) ([f50e064](https://github.com/DocuBook/editor/commit/f50e064caf100da577dcb1b86cea98455fa2ce24))

## v0.2.2 — 2026-10-17


### 🐛 Bug Fixes

* **settings:** top-align the last settings section on short windows ([#279](https://github.com/DocuBook/editor/issues/279)) ([e6e3c82](https://github.com/DocuBook/editor/commit/e6e3c82326d5a59bce5bf1acc0df9d4867ec3fb0))

## v0.2.1 — 2026-10-17


### 🐛 Bug Fixes

* **docker:** check out the repo before running the tag resolver ([2e95bb3](https://github.com/DocuBook/editor/commit/2e95bb39b05f44890d02a3cefc795bc93541783d))
* **docker:** only smoke-test the local image when a build produced it ([32297f1](https://github.com/DocuBook/editor/commit/32297f165277d9b90e72939dd0f69c560f194d45))
* **release:** publish artifacts for release-please tags ([998b019](https://github.com/DocuBook/editor/commit/998b019d562c25d83e18b048fa0f87969a21abb1))
* **release:** skip publish on a non-release push instead of failing it ([00291b9](https://github.com/DocuBook/editor/commit/00291b907f9e15d8be822688b8fb2b953d2ac3ee))
* **release:** sync the nested core lock entries and gate on them ([4272649](https://github.com/DocuBook/editor/commit/427264918e9ac6e8e2b4006ed16a2f500538ad81))
* **release:** sync the stale core dependency in the desktop lockfile ([880f64f](https://github.com/DocuBook/editor/commit/880f64f7599f330a25e929d8e9470987bcf74540))
* **settings:** keep sidebar toggle and search at every width ([#277](https://github.com/DocuBook/editor/issues/277)) ([c190520](https://github.com/DocuBook/editor/commit/c1905205646b082e05731ad4049e2b5e4a01298d))

## v0.2.0 — 2026-10-16


### 🚀 Features

* add sidebar profile menu ([#256](https://github.com/DocuBook/editor/issues/256)) ([a825774](https://github.com/DocuBook/editor/commit/a825774d8c4b9386d383d64856ab7468e447a70c))
* **ai:** add accept keyboard shortcut ([#258](https://github.com/DocuBook/editor/issues/258)) ([54fd1c4](https://github.com/DocuBook/editor/commit/54fd1c49a700d28ad28ef5a05551c318791eb9f2))
* **ai:** add MCP context tools ([#239](https://github.com/DocuBook/editor/issues/239)) ([9233df0](https://github.com/DocuBook/editor/commit/9233df08540b8a30cbc1dadf2ae0e4f61a45aae3))
* **ai:** prototype model-driven context tool round-trips ([#236](https://github.com/DocuBook/editor/issues/236)) ([86a8723](https://github.com/DocuBook/editor/commit/86a8723be7943ac2d13e3e6ede6fab9ee8f25e5b))
* **editor:** persist WYSIWYG-only block formatting in a vault snapshot cache ([882b29d](https://github.com/DocuBook/editor/commit/882b29d91bed347e3b9686b587979350d5b8d161))
* **git:** open changes as an inline diff in the editor ([#232](https://github.com/DocuBook/editor/issues/232)) ([4407812](https://github.com/DocuBook/editor/commit/4407812af049c33634801b9fbd8b1000b617143c))
* **mcp:** align remote settings and runtime filtering ([#242](https://github.com/DocuBook/editor/issues/242)) ([a7dc5aa](https://github.com/DocuBook/editor/commit/a7dc5aa80893eb98c52b1648b8ae33f60c5cc9ab))
* **mcp:** complete MCP settings and lifecycle follow-ups ([#241](https://github.com/DocuBook/editor/issues/241)) ([ca94ed1](https://github.com/DocuBook/editor/commit/ca94ed1080817a623f4609ef382f5880c6b26216))


### 🐛 Bug Fixes

* **ai:** drop stale model on revoke and unify the settings refresh path ([#268](https://github.com/DocuBook/editor/issues/268)) ([cba7c6a](https://github.com/DocuBook/editor/commit/cba7c6a0f803a6e2b3e297f7cd2359764e683ec3))
* **ai:** keep the formatting toolbar down after an AI result ([#226](https://github.com/DocuBook/editor/issues/226)) ([04d49cb](https://github.com/DocuBook/editor/commit/04d49cbf0ddd18d5ed64bed5a01c25a7afcde466))
* **deps:** force katex ^0.19.0 to clear transitive advisory ([#228](https://github.com/DocuBook/editor/issues/228)) ([28c775d](https://github.com/DocuBook/editor/commit/28c775dc86d9ba080696477c427e86676841eb66))
* **editor:** drop #root specificity from Safari 15 popup fallback ([#263](https://github.com/DocuBook/editor/issues/263)) ([#265](https://github.com/DocuBook/editor/issues/265)) ([349c3e1](https://github.com/DocuBook/editor/commit/349c3e19d822d49e10f528f3c7d570e84d11c985))
* **editor:** satisfy exhaustive-deps in the AI accept shortcut ([f390ca8](https://github.com/DocuBook/editor/commit/f390ca8277afa512a53c644ceabfb3af3faa88cb))
* **editor:** seed each cached editor with its own markdown ([#229](https://github.com/DocuBook/editor/issues/229)) ([2ce815b](https://github.com/DocuBook/editor/commit/2ce815bdcb5ac6d5fbd23be0713b9ac4be5f661e))
* **editor:** show a skeleton, never raw source, on a cold open ([#259](https://github.com/DocuBook/editor/issues/259)) ([c24b51e](https://github.com/DocuBook/editor/commit/c24b51e996d2795c5e0c685952950cd55ae1b610))
* **editor:** tab close affordance on every tab + neighbour activation ([#233](https://github.com/DocuBook/editor/issues/233)) ([1a9d386](https://github.com/DocuBook/editor/commit/1a9d38669c4f5fba4187489a96760ac7e5f608c7))
* **editor:** use one scroll container ([#257](https://github.com/DocuBook/editor/issues/257)) ([8d26e01](https://github.com/DocuBook/editor/commit/8d26e0106b3335d124cc22ca029924a5c4e65e70))
* **git:** refresh status when the Changes tab opens ([#231](https://github.com/DocuBook/editor/issues/231)) ([149a728](https://github.com/DocuBook/editor/commit/149a7283525126da69c48928f3fc0b0fea5f11e6))
* **git:** style the inline diff as coloured +/- callouts ([#234](https://github.com/DocuBook/editor/issues/234)) ([00087c7](https://github.com/DocuBook/editor/commit/00087c7afad36cb3dfd85f65791b99025fd0899f))
* **permissions:** include WYSIWYG snapshot commands in default ACL ([b3abbda](https://github.com/DocuBook/editor/commit/b3abbda478fdd83b2ebcd4324b92c9d8f96153bc))
* **profile-menu:** remove duplicate email line in popover header ([564aa91](https://github.com/DocuBook/editor/commit/564aa9173a4bcf44741d2954a7cc9de613dc0bc8))
* **profile-menu:** restore focus to trigger after Escape dismissal ([d71fb2e](https://github.com/DocuBook/editor/commit/d71fb2eb66aca0fa83fa5b4ee4029085fe88e4dc))
* **release:** repair the release PR heading normaliser and lockfile sync ([#274](https://github.com/DocuBook/editor/issues/274)) ([22a89bb](https://github.com/DocuBook/editor/commit/22a89bb2a9cc79cbd00ff2b4dfd1e244455610a6))
* **release:** track the core crate version with the app release ([#275](https://github.com/DocuBook/editor/issues/275)) ([7eb4683](https://github.com/DocuBook/editor/commit/7eb46833f9e92db6066909f10df3cf568d1d2886))
* **settings:** restore mobile navigation controls ([#271](https://github.com/DocuBook/editor/issues/271)) ([7ff2552](https://github.com/DocuBook/editor/commit/7ff2552dea944522d96c20b4fc1e5ebdb98aa9f0))
* **sidebar:** scope search bar to the Folders tab and keep Trash reachable ([#269](https://github.com/DocuBook/editor/issues/269)) ([088de8b](https://github.com/DocuBook/editor/commit/088de8b977677f2d3511bf24367483d42e42cd22))
* **vault:** bound and serialize snapshot operations ([d2f6774](https://github.com/DocuBook/editor/commit/d2f6774dbc6ea9c2aa83e282367bd0336d6c72ab))
* **vault:** cap desktop reads and surface media errors across runtimes ([#225](https://github.com/DocuBook/editor/issues/225)) ([d14e3ee](https://github.com/DocuBook/editor/commit/d14e3ee1637a4f8f32494fe034c7cd4088583a0a))


### 🛡️ Security

* **deps:** bump rustls to 0.23.46 for RUSTSEC-2026-0346..0349 ([#267](https://github.com/DocuBook/editor/issues/267)) ([74d151b](https://github.com/DocuBook/editor/commit/74d151b329e92016974d036522de1ead5f40e623))


### 🔄 Refactor

* **core:** extract the shared Rust engine into a docubook-core crate ([#227](https://github.com/DocuBook/editor/issues/227)) ([e8f328d](https://github.com/DocuBook/editor/commit/e8f328d1dc50b1541a742c48803d3ca740cb67b3))
* **git:** move branch picker into changes panel ([#255](https://github.com/DocuBook/editor/issues/255)) ([fd986c4](https://github.com/DocuBook/editor/commit/fd986c488cbd840936b000c10624036e238bc863))
* **search:** extract reusable file meta label ([#235](https://github.com/DocuBook/editor/issues/235)) ([7b09b67](https://github.com/DocuBook/editor/commit/7b09b67921e8cf65e70858f57de041fbd1ecc229))
* **settings:** move settings from dialog to sidebar menu + editor container ([#266](https://github.com/DocuBook/editor/issues/266)) ([bf73750](https://github.com/DocuBook/editor/commit/bf737502afdbb05cec706a1d88a1557524839c91))
* **ui:** give the tab bar the sidebar's surface background ([#270](https://github.com/DocuBook/editor/issues/270)) ([10fb1ee](https://github.com/DocuBook/editor/commit/10fb1ee157470e1e6ccc5b796c5fe336b3ec2447))


### 🔧 CI

* **release:** automate releases with release-please ([#272](https://github.com/DocuBook/editor/issues/272)) ([e096e9c](https://github.com/DocuBook/editor/commit/e096e9c7c7d9ec85621e06ed13e3d6950443400e))

## v0.1.8 — 2026-10-03

### Patch Release

#### 🐛 Bug Fixes

- **Leaving the AI composer in one press or tap, and returning the caret** — Tapping or clicking outside the composer now dismisses it in a single interaction, and Escape does the same, both handing the caret back to the document. The outside-click listener previously ran only while the panel was expanded, so a collapsed composer with an open picker or a prompt awaiting input could not be left by clicking away, and it listened for `mousedown` — a touch or pen tap never fired it. It now tracks `pointerdown`, covering mouse, touch and pen alike, and is armed whenever the composer is expanded, a picker is open, or the turn is awaiting user input. Escape also calls `editor.focus()` on every platform: the AI extension restores focus only where focusing raises no soft keyboard, so on a phone the caret stayed stuck in the prompt box until the reader tapped the page — the reported “Escape twice to get back to the editor”. A composition guard was added too: a `compositionstart`/`compositionend` ref means the IME owns every key while it composes, including the cancel Escape some Android IMEs deliver with `isComposing` already false, so that key no longer tears the menu down mid-composition and wedges the keyboard. The commit timestamp lives in a ref rather than the effect-local variable, because the keydown effect re-mounts on every picker/menu change and used to forget the commit it was still guarding.
- **Per-request AI cancellation and live text streaming on web** — Web cancel state moved from a single in-flight slot to a map of `Set<AbortController>` keyed by request id, so concurrent turns — an AI panel edit next to a commit-message summary — each own their handle: a late Stop targets exactly one id, a turn that finishes no longer clears another turn's slot, duplicate ids are retained as a group so cancelling one aborts every matching turn, and id-less callers get an isolated `anon-N` slot, with a no-id `cancel_ai` aborting them all. On the transport side, `bufferText` is now driven by `useTools`: the tool-capable path still buffers and lets a meaningful tool op win, while the text-only fallback streams live again — restoring the reply as it types instead of flushing the whole thing once at the end.

## v0.1.7 — 2026-10-01

### Patch Release

#### 🚀 Features

- **Copy/paste in the vault tree context menu** — Right-clicking a tree row now offers Copy and Paste, backed by an in-app file clipboard kept deliberately separate from the editor's text clipboard and, like it, in-app only: the OS clipboard is never touched, so file paste behaves identically on desktop and web. Copy only records the row — nothing touches the filesystem until Paste, which runs through a new `copy_path` command. Paste targets the clicked row's folder (the row itself for a folder, its parent for a file — the same resolution New File uses) and resolves a name collision with a Finder-style suffix (`note.md` → `note copy.md` → `note copy 2.md`), comparing names case-insensitively so a case-sensitive Linux server never grows two rows a case-insensitive desktop reads as one; a leading dot stays with the stem, so `.env` copies to `.env copy`, not `.env.copy`. A folder copies its whole subtree (symlinks skipped, since following one can leave the vault or loop) and cannot be pasted into itself or a descendant. Because a path is relative, the clipboard is scoped to the vault it came from — Paste is disabled in another vault and when nothing has been copied, and the keyboard path skips the disabled row rather than landing on an action the pointer could not pick either.
- **Cut and move in the vault tree context menu** — The row menu gains Cut beside Copy: Paste then moves the row through a new `move_path` command instead of duplicating it, and a cut is consumed by the single paste that spends it. A move keeps its name or does nothing — a taken name is refused with the vault's own message rather than silently renamed (silent renaming would make cut-and-paste a different operation than the user asked for), a move within the same folder is a no-op, and a folder cannot land inside itself or a descendant. Because a move rewrites the row's path, a dirty editor buffer is flushed first so its next save cannot resurrect the file where it was moved from; open tabs are renamed and the create-here target is remapped to follow the row. Copy, cut and paste moved out of `Sidebar.tsx` into `useTreeActions`, so all four tree mutations now live in one hook.

#### 🐛 Bug Fixes

- **Sign out after a password change, and a revalidating app shell** — Changing the password revokes every session server-side, this one included, but the UI kept running on a cookie the server already rejected, so the sign-in screen only appeared at the next request's 401 or after a manual reload; the settings pane now ends the dead session itself, after a short pause that keeps the confirmation readable before Login replaces it. Alongside it, the web server sets an explicit cache policy on the static frontend: content-hashed files under `/assets/` are cached for a year as `immutable`, while the app shell (`/`, deep links, `index.html`) is revalidated on every load so a redeploy is picked up without a hard refresh. The immutable branch is keyed on the response, not the request path — a missing asset falls through the SPA fallback and answers with `index.html`, and pinning that shell to a year under the asset URL would recreate the stale-shell problem the policy exists to fix.
- **Stacked toasts, and one toast per trash batch** — Concurrent toasts now stack one above the other instead of overlapping until hovered (sonner's `expand`). Restoring or permanently deleting from the Trash reports its outcome and any refresh fallout in a single toast: previously the result was emitted before the refreshes were known, so a green “restored” could land beside a red “could not refresh” — two toasts that read as a contradiction — and a failed vault-view refresh could return before the success toast was ever shown. A batch blocked by a missing permission still goes to the permission dialog alone, with no toast repeating it.

## v0.1.6 — 2026-09-29

### Patch Release

#### 🐛 Bug Fixes

- **Language picker dropdown in the app theme** — The code block's language list is Mantine's Select popover, and its default portal target is `document.body`, outside the themed `.bn-container` that carries `data-mantine-color-scheme` — so the component CSS fell back to the library's light palette: a white dropdown inside a dark editor. It now portals through BlockNote's documented `usePortalElement()` (the `editor.portalElement` getter it replaces is undocumented and absent outside a mounted editor), and the dropdown, its rows and its empty state are painted from the app's own tokens in `index.css`, since a portalled popover is out of reach of the header's chrome rules. Hover stays scoped to unselected rows, so the pointer cannot paint over the row Enter would pick.
- **IME toolbar menus that opened behind the keyboard** — The mobile formatting toolbar sits at the bottom edge of the visual viewport, where the default `bottom` anchor leaves its dropdown in the keyboard's band: floating-ui measures zero room there and hands the skin a negative available height — an invalid `max-height` the browser drops — so the dropdown was neither clamped to the visible area nor flipped, and a tall one, the color menu, rendered entirely behind the keyboard where no tap could reach it. The row's menus now anchor to `top` on the IME toolbar, which gives the clamp a positive height to fit and scroll in; desktop has room below its bubble menu by construction and keeps upstream behavior. Both `Menu.Root` and `Popover.Root` also report their open state, so the editor caret is suppressed while a popup is up — the popup opens over the caret's own line — with only `.bn-editor` affected, so the link form and the AI prompt keep their carets, and the toolbar's unmount clears the counter so a popup torn down with the editor (tab switch) cannot leave the caret hidden.
- **Overflow panel buttons painted as pressed** — The formatting toolbar's “More formatting” panel is portalled through its popover, so its buttons land outside `.bn-toolbar`, where BlockNote scopes every toolbar-button rule: they fell back to Mantine's filled default, every button read as pressed, `data-selected` painted nothing (the current alignment was indistinguishable) and `data-disabled` kept the library's palette instead of the editor's. The toolbar's own tokens are re-scoped to the panel's class, leaving the other portalled popovers untouched.
- **AI composer under the IME toolbar** — The composer used to lift itself clear of BlockNote's mobile formatting strip by that strip's own height. It now collapses while the strip is up instead — the strip's gates are the keyboard being open and the editor holding focus, so while it is on screen the reader is editing the document — and it returns the moment the strip goes, draft intact. Closing the AI menu also stops restoring focus on a system whose focus raises the on-screen keyboard, which raised the strip under the composer mid-collapse; the caret, selection and scroll restore are unchanged, and desktop keeps the focus restore.
- **Placeholder flash on first open** — A created editor instance starts on BlockNote's default document, a single empty paragraph, and the markdown parse lived in a mount effect — after the first paint — so every first open of a note showed the placeholder (“Enter text or type '/' for commands”) until the note landed. The instance is now created with its markdown: `createBlockEditor` seeds through the same `loadMarkdownIntoEditor` path every later re-parse uses (code-mode edits, external changes), so the first paint is the note itself. A cache hit ignores the markdown on purpose — re-parsing there would throw away the undo history and in-flight edits the cache exists to keep.
- **System settings buttons** — “Update password” is now a submit button, disabled until all three fields are filled, wearing the page's primary style instead of a grey surface action; “Sign out” is `type="button"`, so it no longer submits the password form on its way to logging out, and is quiet until hovered — sign-out is destructive and should not out-shout the action it sits next to.

## v0.1.5 — 2026-09-28

### Patch Release

#### 🚀 Features

- **BlockNote 0.55.0** — The editor's block stack moves from 0.54.2 to 0.55.0 (`@blocknote/core`, `react`, `mantine`, `math-block`, `diagram-block`). Popovers now portal through the editor's themed portal element, which 0.55 takes as an explicit `portalElement`, so the formatting-toolbar and link/AI popovers keep the editor's styling and escape scroll-container clipping; their forms (link URL and title) commit through the form's native submit with `ScreenReaderOnlySubmit`, since an IME commits a candidate through submit without dispatching a key event — suggestion-list navigation stays on the key handler.
- **AI composer above the mobile formatting toolbar** — 0.55's mobile formatting toolbar is portalled into a body-level container pinned to the bottom of the visual viewport — the same strip above the on-screen keyboard the AI composer occupies on a phone. The composer now measures how far that strip's top edge reaches above its own positioning box and lifts itself by the same margin through a transitioned `margin-bottom`, following the strip as a taller keyboard or iOS panning the viewport moves it: it re-measures on `visualViewport` resize and scroll as well as on the toolbar appearing or disappearing, with the body mutation observer filtered to the toolbar node so per-keystroke ProseMirror DOM churn forces no layout. Without the strip the lift is 0, and a future BlockNote that renames the class degrades to overlap rather than mispositioning.
- **Block actions in the mobile formatting toolbar** — Where the hover-driven side menu does not exist — every shell below the 640px breakpoint, keyed to the same `isDesktop` query that drives `sideMenu` — the formatting toolbar now carries the side menu's block actions: a `+` that inserts a paragraph directly below the block at the text cursor and puts the caret on it (not the slash menu, which `/` already opens — a click and a keystroke for “add a block” were ambiguous), and Move up/down buttons around the public `moveBlocksUp`/`moveBlocksDown`, because dragging is HTML5 drag-and-drop and never fires from a touch pointer. The move passes no block id, so the selection travels with the block and the caret stays where it was; document edges are the commands' own no-op, and a click against a stale toolbar with no cursor to act on does nothing instead of throwing. At phone width the buttons live in the toolbar's overflow panel rather than its row, which cannot hold them without pushing its tail past the viewport edge.
- **Single mode toggle in the tab bar** — The Markdown/Blocks toggle group becomes one button whose icon shows the mode a click switches TO: the markdown icon while in WYSIWYG, the pencil-ruler while in source. The inline toolbar button and the compact Actions item share one `ModeSwitchIcon`, so the two controls can never show different icons; `toggleEditMode` wiring, the disabled state for non-`.md` files, and the tooltips are unchanged.

#### 🐛 Bug Fixes

- **Caret-reveal scrolls that hid the composer** — The composer's scroll-direction reveal now reacts only to a scroll a wheel or touch gesture produced (within 300 ms, ahead of the rAF-batched scroll event); a scroll the browser performs on its own — revealing the caret when the soft keyboard opens, advancing under an IME composition, restoring a `scrollIntoView` — merely re-syncs the tracked position. Previously that reveal read as the user scrolling down and hid the composer with the user's hands off the screen.
- **IME keys treated as composer keys** — The Enter that commits an IME candidate no longer sends the prompt, and while a composition is active the keys belong to the IME: the candidate arrows no longer walk the `@mention` picker, and Escape — or one landing within 250 ms of `compositionend`, since the window-capture listener runs ahead of the element handlers — cancels the candidate strip instead of dismissing the picker or the composer.
- **Keyboard raised when a note opens on a touch device** — Opening a note on a system whose focus raises an on-screen keyboard no longer claims focus: WYSIWYG and raw Markdown still restore the caret, selection, and scroll, but focus waits for the reader's tap, so a note opened on a phone no longer flashes the IME up only for the drawer's exit handoff to drop it again. The platform test reads Chromium's client hint, mobile UA tokens, and iPadOS's `MacIntel` plus touch points, and for Firefox on Android — a plain desktop UA with no hints — falls back to ARM Linux with a handset-sized short side; desktop systems and touchscreen laptops keep their focus restore, and the caret restore is unchanged on every platform.

## v0.1.4 — 2026-09-26

### Patch Release

#### 🚀 Features

- **Code block language picker** — The header's language label is now a searchable picker over every language Shiki can tokenize, loaded on demand the first time a dropdown opens so a document gains no eager weight. Picking a language rewrites only the fence's first token, so a `title="…"` or any other info the user typed survives in place. Search matches fence tokens as well as display names (`js`, `ts`, `jsonc` — not just “JavaScript”, “TypeScript”, “JSON with Comments”), and the control renders the fence token as typed, so a raw Markdown → WYSIWYG switch mounts every code block without waiting on an async import. The list stays inside the app window instead of running past it, a long language name ellipsizes instead of widening the block, and the tinted frame keeps the same 12px vertical rhythm as its neighbours.
- **Writing phase from the provider's first delta** — rust-ai emits `ai:generating` on the first non-empty delta — prose or tool-call arguments — and the AI menu leaves “thinking” as soon as the provider starts writing. In tool mode the completed call only lands at end of stream, so the status previously sat in “thinking” for the whole write and only moved once the client-side reveal began.
- **New File and New Folder in the tree context menu** — Right-clicking a vault row now offers New File, New Folder, Rename, and Delete. A new entry lands in the clicked row's folder — the folder itself for a folder row, the parent for a file — and a collapsed target is expanded first so the reload reveals the new child in place instead of inside a closed folder. The menu owns its dismissal, closing before handing an action to the caller so a row cannot leave a stale menu behind, and its keyboard controls: focus lands on the menu rather than its first row, arrows walk the rows and wrap at both ends, Home/End jump, and Escape dismisses.

#### 🐛 Bug Fixes

- **Half-parsed AI stream frames** — The hand-rolled SSE parser split the provider stream on newlines and flushed whatever was left in its byte buffer when the connection ended, so a connection that died mid-frame handed half a JSON payload on: if that half happened to parse, it was emitted as a real token or tool call. Framing now comes from `eventsource-stream`, the parser behind async-openai — multi-line `data:` fields are joined with LF, `data:value` without the optional space is accepted, CR-only line endings and a leading BOM are handled, and an event whose terminating blank line never arrives is dropped at EOF instead of parsed. The 8 MB guard sits on the raw byte stream, before the parser allocates anything, so a provider that never terminates an event cannot grow the buffer without bound; tripping it stays tripped and is reported as `response_too_large` rather than flattened into a generic transport failure. Cancel is checked before the first read, so Stop no longer waits for a chunk. The 30 s first-event timeout, `AI_MAX_SECONDS`, per-request event tagging, tool-call batching, and `process_sse_data` are unchanged. New dependencies: `eventsource-stream` 0.2.3 in both crates, plus `bytes` and `futures-util`.
- **Text-mode replies that were not content** — The text-only path has no schema to lean on, so a reply on its own could not say whether it was content or commentary *about* content — an answer, an apology, or an echo of the prompt was previously written into the document, replacing the selection or appending prose after the cursor. The text-mode prompt now asks for the payload inside `<content>…</content>`, and the transport writes only a delimited, non-empty payload; anything else reports “no document changes” instead. Casing and spacing variants of the tags still resolve, preamble and trailing notes are tolerated because the tags bound the payload, and the last closing tag wins so content that itself contains the literal tag is not truncated. When a request needs no document change at all — “fix spelling” on clean text — the model now answers without a content block instead of failing the turn.
- **Code blocks the AI is still writing** — While a fence is still streaming (` ```py ` → ` ```pyth ` …) Shiki is no longer asked for the half-typed language, which would fetch the wrong grammar or record an unknown one as unsupported, and cache an empty decoration set for the block. Once writing ends, the blocks the pause skipped parse again with the language they actually ended up with, and again whenever the language changes.
- **Drawer overlays on a phone** — Full-screen dialogs and the pointer-anchored context menu opened inside the mobile sidebar were centred and clipped by the drawer: its slide transition leaves an inline `transform` on the drawer content, which makes that element the containing block for `position: fixed` descendants. Both are now hosted on `document.body` through `OverlayPortal`, which keeps them above the drawer and carries its own focus trap so keyboard focus cannot fall back into the drawer behind the overlay or leave the menu unreachable. The drawer is also sized at 70% of the viewport instead of a fixed 224px, which was truncating every folder name, and the settings-permission dialog's opening control regains initial focus ahead of “Not now”.

#### 🔄 Refactor

- Tree mutations (`create`, `rename`, `delete`) and the transient state of their inline inputs moved out of `Sidebar.tsx` into `useTreeActions`, with the row menu in `SidebarContextMenu` and the viewport host in `OverlayPortal`. Any surface can now reach a tree action without owning its flow, and the sidebar stays a render. The rename input is keyed by path, so starting a rename on another row remounts it instead of inheriting the previous row's text. New coverage pins the menu (unit and integration), the code block header's DOM contract, the language catalogue, Shiki's refresh after an AI write, and the delimited-content rules.

## v0.1.3 — 2026-09-24

### Patch Release

#### 🐛 Bug Fixes

- **Request-scoped AI streams** — Every AI request now carries its own id, and both transports tag each event with the request that produced it. Stop, retry, and a superseded attempt can only affect the turn they belong to, so a commit-message generation running next to an AI panel turn no longer interleaves their tokens or cancels the wrong stream.
- **Prose fallback in tool mode** — A tool-capable provider that answers with prose instead of calling a tool is now re-asked once with the text-only prompt rather than failing the turn. The prose itself is never converted into a document edit, so the block ids from the tool prompt cannot leak into the text.
- **Retry budget** — Manual Retry is capped per turn and disabled once the budget is spent, and a stale Retry click against a closed or aborted session is a no-op instead of an unhandled rejection.
- **Composer model pick** — A model chosen in the composer now survives the settings hydration that can still land after boot, and the picker keeps the active model visible with a highlighted row, a check mark, and a scroll into view over a long model list.
- **Empty documents** — A document holding a single empty paragraph now counts as empty instead of only a document with zero blocks, so prompts and placeholders take the empty path. Prompt cursor context also resolves from the AI menu anchor rather than the live cursor, which goes stale once the composer takes focus and the editor is locked.
- **Git status without a timer** — Replaced the 3-second git-status poller with event-driven refreshes on git actions, vault open/close, and window focus. Vaults that are not repositories no longer fire a request every three seconds, and a failed refresh no longer leaves the store permanently empty.
- **Custom AI provider** — The server's saved-provider list keeps a custom OpenAI-compatible endpoint instead of filtering it out, so saving one no longer reports an empty provider list and disables the composer on the next browser or redeploy.
- **Mobile shell viewport** — The app shell is sized against the visible viewport (`dvh`, with the `100vh` fallback for Safari 15 and chrome105), and the soft keyboard resizes the layout viewport on Chromium, so the tab bar and the composer no longer scroll apart when the composer is focused on a phone. The document also reserves room for the composer at its full height at every width.

#### 🔄 Refactor

- Unit tests moved from `test/unit` to `test/__fixtures__`, with the shared React-settle helpers extracted into one harness, and the Docker build no longer copies the test directory.

#### 🔧 CI

- Added the `pullfrog.yml` workflow with dry-mode prompts for review, plan, build, and address-reviews.
- The browser E2E matrix no longer waits on the manual build-approval gate — it is a required PR check.
- E2E suites are discovered from `test/*.mjs` instead of a hardcoded list, a failing suite writes a per-assertion frame trail as an artifacts GIF, and a new mobile-shell suite pins the viewport contract as live geometry plus shipped artifacts.
- Retired the stale one-off E2E scripts (`trash`, `theme`, `overlay-surface`, `raw-markdown-highlight`, formatting toolbar, cursor table) and the `test:e2e:*` aliases that pointed at them.

## v0.1.2 — 2026-09-23

### Patch Release

#### 🚀 Features

- **Scroll-aware AI composer** — The floating AI composer now hides while scrolling down and fades back in when scrolling up, without covering content, and without clashing with the mobile sidebar drawer below 640px.

#### 🐛 Bug Fixes

- **AI settings across browsers** — Hydrating AI settings now waits for a logged-in session and retries with bounded backoff, so a fresh browser (or one that logged in after the server was briefly unreachable) no longer shows a disabled AI composer after the config was saved elsewhere.
- **Desktop AI composer padding** — Restored desktop padding so the composer does not overlap the last lines of the document.

## v0.1.1 — 2026-09-22

### Patch Release

#### 🚀 Features

- **AI settings sync** — Persisted the selected provider, model, configured endpoints, API-key state, and tool-call probes in the backend so AI settings survive browser changes and reloads.

#### 🐛 Bug Fixes

- **Mobile editor** — Kept the mobile chrome sticky so editor controls remain available while scrolling.
- **Sync conflicts** — Removed the misleading “Keep both” resolution option.

## v0.1.0 — 2026-09-21

### First Stable Release

DocuBook's first stable release. The early-access series (`0.1.0-next`) is now
promoted to stable: the API and configuration formats are considered settled,
and the desktop and web builds share one frozen command surface.

#### 🚀 Features

- **Offline sync** — Edits made without a connection are queued durably and reconciled on reconnect through a content-version guard, so a stale write can no longer silently clobber newer content.
- **AI selection and tool-call probes** — The selected model and tool-call capability are probed once and persisted across browsers, so the AI panel no longer re-discovers them per session.

#### 🐛 Bug Fixes

- **Editors** — Restored tabs after reload, kept the shell viewport-bound so the AI chat stays on screen, and aligned the raw caret with its WYSIWYG block across mode switches.
- **Safari compatibility** — Restored Safari 15 rendering on macOS 12.
- **Mentions** — Dropped the recursive tagline from mention folder rows.
- **Vault** — Added an opening state while a vault loads and closed the gaps in the vault opening overlay.
- **AI** — Retried the original prompt when the first attempt fails.
- **Chrome** — Fixed settings dropdowns misplaced by the dialog `backdrop-filter`.
- **Docker** — Scoped the `/data` ownership repair to the mount type.
- **CI** — Kept the Docker smoke test green on non-root runners.

#### 🔄 Refactor

- Removed the unused `.tip` tooltip system.

#### 🔧 CI

- Silenced unactionable build warnings and corrected the stale polyfill note.

#### 🔄 Version / Hygiene

- Dependency bumps: `trash` 5.2.9, `esbuild` 0.28.2, `@tauri-apps/plugin-opener` 2.5.5, `oxlint` 1.83.0, `lint-staged` 17.5.1, Rust 1.97-alpine.
- Fixed the Coolify mount table and documented the stale container issue.
- Updated the README description.

---

## v0.1.0-next — 2026-09-18

### Early Access Release for testing

First public build, published for early access testing. Everything listed below is already present and usable, but features, APIs, and configuration formats are still **unstable** — expect breaking changes before a stable release.

#### 🚀 Features

- **Local vaults** — Open, create, or clone vaults as plain folders of Markdown files, with no proprietary format. Other text formats can be viewed; `.md` and `.mdx` use the WYSIWYG editor.
- **WYSIWYG block editing** — Headings, lists, quotes, code, math, and Mermaid diagram blocks, plus inline formatting. Open the block menu with `/`, and switch to raw Markdown mode to edit the source directly.
- **Reviewable AI** — Write, improve, summarize, translate, and fix text from an in-editor AI menu and a floating AI chat. Every suggestion streams in and can be accepted or rejected before it reaches the document.
- **Provider choice** — Built-in AI providers plus custom OpenAI-compatible endpoints, configured in **Settings → AI**, with keys stored backend-side.
- **Git publishing** — Configure identity and a remote, then stage, commit, push, and see the active branch without leaving the editor.
- **Fast navigation** — File search, expandable folders, backlinks, wikilinks, and keep-alive editor tabs that survive folder renames.
- **Desktop and web** — macOS desktop builds for Apple Silicon and Intel, and a Docker image for web with a required admin account on first run plus a `/api/health` check.
- **Theming** — Named themes with light- and dark-mode polish across the editor and app chrome.
- **Reliable autosave** — Editor changes are persisted at the app layer instead of depending on tab transitions.

---

## Versioning

Versions are proposed automatically by **release-please** from the conventional
commits on `master`, following SemVer adjusted for a pre-1.0 project. The
release type is decided by the **highest-ranked conventional commit type in the
range**, so one `feat` anywhere in the release lifts the whole release to minor,
and a `fix` alongside it does not pull it back down.

### Which commit type yields which bump

| Commit type | Bump (pre-1.0) | Bump (post-1.0) | Example |
| --- | --- | --- | --- |
| `feat` | minor | minor | `0.1.8` → `0.2.0`, `1.0.0` → `1.1.0` |
| `feat!` / `fix!` / any `BREAKING CHANGE:` footer | **minor** | **major** | `0.1.8` → `0.2.0`, `1.0.0` → `2.0.0` |
| `fix`, `security`, `perf`, `refactor`, `ci`, `docs`, `test`, `chore` | patch | patch | `0.1.8` → `0.1.9`, `1.0.0` → `1.0.1` |

In other words: **patch** is the floor (any commit that is not a feature or a
breaking change), **minor** is a feature, and **major** is a breaking change —
except that while the major is `0` a breaking change is held at minor, because
`0.x` carries no stability promise.

### Reaching 1.0.0

Nothing bumps the major automatically today. `bump-minor-pre-major` (set in
`release-please-config.json`) deliberately caps a breaking change at a **minor**
bump while the major is `0`, so `1.0.0` is a **manual decision**, not a
side effect of a breaking commit:

1. Open a release PR as usual and let it propose `0.x.y`.
2. On that PR, add `Release-As: 1.0.0` as a **footer of the release commit**, or
   set `"release-as": "1.0.0"` in `release-please-config.json` for one run.
   release-please then proposes `1.0.0` instead of the computed version.
3. **Remove the override** — `release-as` is sticky and would otherwise pin
   every later release to `1.0.0`.

After `1.0.0` exists, breaking changes bump the major on their own and
`bump-minor-pre-major` no longer applies.

`bump-patch-for-minor-pre-major` is deliberately **not** set: enabling it would
fold a `feat` into a patch release, so features would stop advancing the minor
version.

### Versions this project has shipped

- `0.1.0` — First stable release. API and configuration formats are settled.
- `0.1.x` — Patch releases. Historically some carried features too, because
  versions were set by hand before release-please; under the current rules a
  `feat` now always advances the minor instead.
- `0.x.0` — Minor releases. New features, and breaking changes while the major is
  `0`.
- `0.x.y-next` / `0.x.y-beta` — Testing and beta builds, cut with the
  `prerelease` versioning strategy (`prerelease-type` set to `next` or `beta`) so
  the pre-release part is generated rather than typed by hand. Published as
  GitHub pre-releases and excluded from `:latest`.
- `1.x.0` — Future stable releases, once the API is declared stable (see
  **Reaching 1.0.0** above).

**Nobody sets a version by hand.** The version in `CHANGELOG.md`, the four
manifests, and the git tag all come from the same release PR — see
[Release workflow](./CONTRIBUTING.md#release-workflow-automated--release-please).

See [README.md](README.md) for documentation and setup guide.
