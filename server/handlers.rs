use super::*;

pub(crate) async fn dispatch(state: &AppState, cmd: &str, args: Value) -> Result<String, String> {
    let s = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let st = state.clone();
    match cmd {
        // File scan / network ops run off the async thread — mirrors spawn_blocking in lib.rs.
        "open_vault" => {
            let p = ensure_within_data(&st, &s("path"))?;
            tokio::task::spawn_blocking(move || cmds::open_vault(&st, &p))
                .await
                .map_err(|e| e.to_string())?
        }
        "create_vault" => {
            let (name, parent) = (s("name"), s("parent"));
            let parent = ensure_within_data(&st, &parent)?;
            tokio::task::spawn_blocking(move || cmds::create_vault(&st, &parent, &name))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_clone" => {
            let (url, parent) = (s("url"), s("parent"));
            let parent = ensure_within_data(&st, &parent)?;
            tokio::task::spawn_blocking(move || cmds::git_clone(&st, &url, &parent))
                .await
                .map_err(|e| e.to_string())?
        }
        "search_vault" => {
            let q = s("query");
            tokio::task::spawn_blocking(move || cmds::search_vault(&st, &q))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_diff_summary" => tokio::task::spawn_blocking(move || cmds::git_diff_summary(&st))
            .await
            .map_err(|e| e.to_string())?,
        "git_commit" => {
            let m = s("message");
            tokio::task::spawn_blocking(move || cmds::git_commit(&st, &m))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_push_only" => {
            let remote = args
                .get("remote")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .filter(|v| !v.is_empty());
            tokio::task::spawn_blocking(move || cmds::git_push_only(&st, remote.as_deref()))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_remote_probe" => {
            let name = s("name");
            tokio::task::spawn_blocking(move || cmds::git_remote_probe(&st, &name))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_fetch" => {
            let name = s("name");
            tokio::task::spawn_blocking(move || cmds::git_fetch(&st, &name))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_pull" => {
            let request =
                serde_json::from_value(args.get("request").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Invalid GitPullRequest: {error}"))?;
            tokio::task::spawn_blocking(move || cmds::git_pull(&st, request))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_remote_merge" => {
            let (name, branch) = (s("name"), s("branch"));
            tokio::task::spawn_blocking(move || cmds::git_remote_merge(&st, &name, &branch))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_rebase" => {
            let (name, branch) = (s("name"), s("branch"));
            tokio::task::spawn_blocking(move || cmds::git_rebase(&st, &name, &branch))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_rebase_continue" => {
            tokio::task::spawn_blocking(move || cmds::git_rebase_continue(&st))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_rebase_abort" => tokio::task::spawn_blocking(move || cmds::git_rebase_abort(&st))
            .await
            .map_err(|e| e.to_string())?,
        "git_merge_abort" => tokio::task::spawn_blocking(move || cmds::git_merge_abort(&st))
            .await
            .map_err(|e| e.to_string())?,
        "git_branches" => tokio::task::spawn_blocking(move || cmds::git_branches(&st))
            .await
            .map_err(|e| e.to_string())?,
        "git_create_branch" => {
            let b = s("branch");
            tokio::task::spawn_blocking(move || cmds::git_create_branch(&st, &b))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_checkout" => {
            let b = s("branch");
            let r = args
                .get("remote")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            tokio::task::spawn_blocking(move || cmds::git_checkout(&st, &b, r))
                .await
                .map_err(|e| e.to_string())?
        }
        "close_vault" => sync(state, cmd, args),
        "list_tree" => sb(state, cmd, args).await,
        "resolve_mentions" => {
            let request = serde_json::from_value(args.get("request").cloned().unwrap_or(args))
                .map_err(|e| format!("Invalid mention request: {e}"))?;
            // Clone the shared handle, not the vault (Vault is Send but not Sync),
            // so the blocking task reuses the open vault instead of rebuilding it.
            let vault = st.vault.clone();
            tokio::task::spawn_blocking(move || {
                let guard = vault
                    .lock()
                    .map_err(|_| "Vault lock poisoned".to_string())?;
                let Some(v) = guard.as_ref() else {
                    return serde_json::to_string(&vault::mentions::Bundle::default())
                        .map_err(|e| e.to_string());
                };
                serde_json::to_string(&vault::mentions::resolve(v, request))
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "read_file" => sync(state, cmd, args),
        "file_version" => sync(state, cmd, args),
        "write_file" => sync(state, cmd, args),
        "write_file_checked" => sync(state, cmd, args),
        "create_file" => sync(state, cmd, args),
        "create_directory" => sync(state, cmd, args),
        "delete_file" => sb(state, cmd, args).await,
        "list_trash" => sync(state, cmd, args),
        "restore_file" => sync(state, cmd, args),
        "delete_trash_item" => sync(state, cmd, args),
        "rename_file" => sync(state, cmd, args),
        "git_settings" => sb(state, cmd, args).await,
        "git_add_remote" => sb(state, cmd, args).await,
        "git_remove_remote" => sb(state, cmd, args).await,
        "git_set_identity" => sb(state, cmd, args).await,
        "git_init" => {
            let branch = s("branch");
            tokio::task::spawn_blocking(move || cmds::git_init(&st, &branch))
                .await
                .map_err(|e| e.to_string())?
        }
        "git_stage" => sb(state, cmd, args).await,
        "git_status" => sb(state, cmd, args).await,
        "wiki_backlinks" => sync(state, cmd, args),
        "wiki_suggest" => sync(state, cmd, args),
        "wiki_resolve" => sync(state, cmd, args),
        "custom_ai_config" => sync(state, cmd, args),
        "ai_settings" => sync(state, cmd, args),
        "set_ai_settings" => sync(state, cmd, args),
        "set_probe" => sync(state, cmd, args),
        "md_to_html" => sync(state, cmd, args),
        "cancel_ai" => sync(state, cmd, args),
        "set_api_key" => sync(state, cmd, args),
        "set_custom_endpoint" => sync(state, cmd, args),
        "delete_api_key" => sync(state, cmd, args),
        "list_api_keys" => sync(state, cmd, args),
        // macOS-only deep link into Privacy & Security. The web build has no
        // privacy gate (trash lives in `.trash/` inside the vault), so this is a
        // deliberate no-op rather than an error: the UI reaches it only after a
        // permission failure, which the server never produces. Answering keeps
        // the command surface at parity and avoids a misleading "Unknown command".
        "open_system_settings" => Ok("null".to_string()),
        "web_vaults" => sync(state, cmd, args),
        "web_vault_root" => sync(state, cmd, args),
        "setup_status" => sync(state, cmd, args),
        "account_get" => sync(state, cmd, args),
        "change_password" => sync(state, cmd, args),
        "config_get" => sync(state, cmd, args),
        "config_set" => sync(state, cmd, args),
        "health" => Ok(cmds::health(state).to_string()),
        "list_models" => probe::list_models(state, &s("provider"), &s("baseUrl")).await,
        "test_connection" => {
            probe::test_connection(
                state,
                &s("provider"),
                &s("model"),
                &s("baseUrl"),
                &s("apiKey"),
            )
            .await
        }
        _ => Err(format!("Unknown command: {cmd}")),
    }
}

/** Run a cheap sync command body on the current thread. */
fn restore_key(data_dir: &std::path::Path, provider: &str, key: Option<&str>) {
    match key {
        Some(key) => {
            let _ = keys::set_key(data_dir, provider, key);
        }
        None => {
            let _ = keys::delete_key(data_dir, provider);
        }
    }
}

/** Roll the AI selection back after a failed multi-step save.
 *
 *  Takes the same `config` lock the callers hold while deciding to roll back, so
 *  every caller MUST drop its guard first (`{ ... }` around the failing
 *  `set_endpoint` call). `std::sync::Mutex` is not reentrant: locking it while
 *  already holding it blocks the thread on itself forever. */
fn restore_ai(state: &AppState, selection: &config::AiSelection) {
    let mut cfg = state.auth.config.lock().expect("lock");
    cfg.ai = selection.clone();
    let _ = cfg.save();
}

pub(crate) fn sync(state: &AppState, cmd: &str, args: Value) -> Result<String, String> {
    let s = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match cmd {
        "close_vault" => {
            *state.vault.lock().expect("lock") = None;
            *state.wiki.lock().expect("lock") = None;
            *state.git.lock().expect("lock") = None;
            Ok("null".into())
        }
        "list_tree" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => serde_json::to_string(&v.tree(&s("subpath"))).map_err(|e| e.to_string()),
            None => Ok("[]".into()),
        },
        "read_file" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.read_file_limited(&s("path"), httpm::MAX_FILE_BYTES),
            None => Err("No vault".into()),
        },
        "file_version" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => serde_json::to_string(&v.version_of(&s("path"))?).map_err(|e| e.to_string()),
            None => Err("No vault".into()),
        },
        "write_file" => {
            let r = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v
                    .write_file(&s("path"), &s("content"))
                    .map(|_| "null".into()),
                None => Err("No vault".into()),
            };
            if r.is_ok() {
                cmds::rescan_wiki(state);
            }
            r
        }
        "write_file_checked" => {
            // `baseVersion` is absent for "new file" writes, so distinguish a
            // missing key from an explicit null before forwarding to the vault.
            let base = match args.get("baseVersion") {
                Some(serde_json::Value::String(v)) => Some(v.clone()),
                _ => None,
            };
            let r = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v
                    .write_file_checked(&s("path"), &s("content"), base.as_deref())
                    .and_then(|o| serde_json::to_string(&o).map_err(|e| e.to_string())),
                None => Err("No vault".into()),
            };
            if matches!(r.as_deref(), Ok(v) if v.contains("\"written\"")) {
                cmds::rescan_wiki(state);
            }
            r
        }
        "create_file" => {
            let r = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v.create_file(&s("path")),
                None => Err("No vault".into()),
            };
            if r.is_ok() {
                cmds::rescan_wiki(state);
            }
            r
        }
        "create_directory" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.create_directory(&s("path")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "delete_file" => {
            let r = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v.delete_file(&s("path")).map(|_| "null".into()),
                None => Err("No vault".into()),
            };
            if r.is_ok() {
                cmds::rescan_wiki(state);
            }
            r
        }
        "list_trash" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => serde_json::to_string(&v.list_trash()).map_err(|e| e.to_string()),
            None => Ok("[]".to_string()),
        },
        "restore_file" => {
            let r = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v.restore_file(&s("trashName")).map(|_| "null".into()),
                None => Err("No vault".into()),
            };
            if r.is_ok() {
                cmds::rescan_wiki(state);
            }
            r
        }
        "delete_trash_item" => match state.vault.lock().expect("lock").as_ref() {
            Some(v) => v.delete_trash_item(&s("trashName")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "rename_file" => {
            let r = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v.rename_file(&s("from"), &s("to")).map(|_| "null".into()),
                None => Err("No vault".into()),
            };
            if r.is_ok() {
                cmds::rescan_wiki(state);
            }
            r
        }
        "git_settings" => cmds::git_settings(state),
        "git_add_remote" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g.add_remote(&s("name"), &s("url")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_remove_remote" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g.remove_remote(&s("name")).map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_set_identity" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g
                .set_identity(&s("name"), &s("email"))
                .map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_init" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => serde_json::to_string(&g.init(&s("branch"))?).map_err(|e| e.to_string()),
            None => Err("No vault".into()),
        },
        "git_stage" => {
            let path = s("path");
            match state.git.lock().expect("lock").as_ref() {
                Some(g) => {
                    let r = if path.is_empty() {
                        g.add_all()
                    } else {
                        g.stage_path(&path)
                    };
                    r.map_err(|e| e.to_string()).map(|_| "null".into())
                }
                None => Err("No vault".to_string()),
            }
        }
        "git_status" => {
            let guard = state.git.lock().expect("lock");
            match guard.as_ref() {
                Some(g) if g.is_repo() => {
                    let ws = g.status_with_branch().unwrap_or_default();
                    let remotes = g
                        .remotes()
                        .map(|list| list.into_iter().map(|(name, _)| name).collect::<Vec<_>>())
                        .unwrap_or_default();
                    Ok(json!({ "isRepo": true, "hasRemote": g.has_remote(), "branch": ws.branch, "upstream": ws.upstream, "status": ws.status.trim(), "ahead": ws.ahead, "behind": ws.behind, "pushTarget": g.push_target(), "hasCommits": g.has_commits(), "remotes": remotes, "state": ws.state }).to_string())
                }
                _ => Ok(r#"{"isRepo":false,"hasRemote":false,"branch":"","upstream":"","status":"","ahead":0,"behind":0,"pushTarget":"","hasCommits":false,"remotes":[],"state":"clean"}"#.to_string()),
            }
        }
        "wiki_backlinks" => {
            // Only the root is copied out under the vault lock: backlink snippets
            // read markdown files, so the wiki lock alone must cover that work.
            let root = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v.root().to_path_buf(),
                None => return Ok("[]".to_string()),
            };
            match state.wiki.lock().expect("lock").as_ref() {
                Some(w) => serde_json::to_string(&w.backlinks(&root, &s("path")))
                    .map_err(|e| e.to_string()),
                None => Ok("[]".to_string()),
            }
        }
        "wiki_suggest" => {
            let root = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v.root().to_path_buf(),
                None => return Ok("[]".to_string()),
            };
            match state.wiki.lock().expect("lock").as_ref() {
                Some(w) => {
                    serde_json::to_string(&w.suggest(&root, &s("query"))).map_err(|e| e.to_string())
                }
                None => Ok("[]".to_string()),
            }
        }
        "wiki_resolve" => match state.wiki.lock().expect("lock").as_ref() {
            Some(w) => Ok(w.resolve(&s("title")).unwrap_or_default()),
            None => Ok(String::new()),
        },
        "custom_ai_config" => {
            let env = probe::custom_env_config();
            let source = if env.is_some() { "env" } else { "file" };
            // A saved custom endpoint lives in config.json — the base URL is not a
            // secret and must not be pinned to one browser's keys.json.
            let base_url = match &env {
                Some((eb, _, _)) => Some(eb.clone()),
                None => state
                    .auth
                    .config
                    .lock()
                    .expect("lock")
                    .ai
                    .endpoints
                    .get(agent::CUSTOM_PROVIDER_ID)
                    .map(|e| e.base_url.clone())
                    .filter(|u| !u.is_empty()),
            };
            let has_key = match &env {
                Some((_, ek, _)) => {
                    ek.is_some()
                        || keys::get_key(&state.data_dir, agent::CUSTOM_PROVIDER_ID).is_ok()
                }
                None => keys::get_key(&state.data_dir, agent::CUSTOM_PROVIDER_ID).is_ok(),
            };
            let model = env.and_then(|(_, _, em)| em);
            Ok(serde_json::json!({ "source": source, "baseUrl": base_url, "hasKey": has_key, "model": model }).to_string())
        }
        "md_to_html" => Ok(markdown::markdown_to_safe_html(&s("content"))),
        "cancel_ai" => {
            state.ai_cancel.store(true, Ordering::SeqCst);
            Ok("null".into())
        }
        "set_api_key" => {
            let provider = s("provider");
            let key = s("key");
            let base_url = s("baseUrl");
            let previous_key = keys::get_key(&state.data_dir, &provider).ok();
            let model = args.get("model").and_then(|v| v.as_str()).unwrap_or("");
            // A configured provider is immutable until total revoke. Allow only
            // first-time creation here; an endpoint left by a failed/legacy save
            // may be completed only when no API key exists yet.
            {
                let cfg = state.auth.config.lock().expect("lock");
                if cfg.ai.endpoints.contains_key(&provider) && previous_key.is_some() {
                    return Err(
                        "Provider is already configured; revoke it before changing settings".into(),
                    );
                }
            }
            // Scoped so the guard is released before any later lock: both this and
            // `restore_ai` take the same non-reentrant config mutex. Snapshot first,
            // then set — never with both guards alive.
            let previous_ai = { state.auth.config.lock().expect("lock").ai.clone() };
            keys::set_key(&state.data_dir, &provider, &key)?;
            // `let` binding, not `if let`: a guard created in an `if let` scrutinee
            // lives until the end of the whole statement, which would keep the lock
            // held while the error arm calls `restore_ai`.
            let saved = {
                let mut cfg = state.auth.config.lock().expect("lock");
                if cfg.ai.endpoints.contains_key(&provider) {
                    cfg.complete_endpoint(&provider, model, &base_url)
                } else {
                    cfg.set_endpoint(&provider, model, &base_url)
                }
            };
            if let Err(error) = saved {
                restore_key(&state.data_dir, &provider, previous_key.as_deref());
                restore_ai(state, &previous_ai);
                return Err(format!(
                    "API key saved, but the endpoint could not be persisted: {error}"
                ));
            }
            Ok("null".into())
        }
        "set_custom_endpoint" => {
            if probe::custom_env_base_url().is_some() {
                return Err("Custom endpoint is controlled by DB_OPENAI_COMPAT_BASE_URL — remove the env var to edit in the UI".into());
            }
            let provider = s("provider");
            let url = s("baseUrl");
            let key = s("key");
            agent::validate_custom_base_url(&url, false)?;
            let previous_key = keys::get_key(&state.data_dir, &provider).ok();
            {
                let cfg = state.auth.config.lock().expect("lock");
                if cfg.ai.endpoints.contains_key(&provider) && previous_key.is_some() {
                    return Err(
                        "Provider is already configured; revoke it before changing settings".into(),
                    );
                }
            }
            // See `set_api_key` for why this snapshot is scoped and why the write
            // below is a `let` binding rather than an `if let` scrutinee.
            let previous_ai = { state.auth.config.lock().expect("lock").ai.clone() };
            keys::set_key(&state.data_dir, &provider, &key)?;
            let model = args.get("model").and_then(|v| v.as_str()).unwrap_or("");
            let saved = {
                let mut cfg = state.auth.config.lock().expect("lock");
                if cfg.ai.endpoints.contains_key(&provider) {
                    cfg.complete_endpoint(&provider, model, &url)
                } else {
                    cfg.set_endpoint(&provider, model, &url)
                }
            };
            if let Err(error) = saved {
                restore_key(&state.data_dir, &provider, previous_key.as_deref());
                restore_ai(state, &previous_ai);
                return Err(format!(
                    "API key saved, but the endpoint could not be persisted: {error}"
                ));
            }
            Ok("null".into())
        }
        "delete_api_key" => {
            // Total revoke: remove the key and endpoint together. If config
            // persistence fails after the key is deleted, restore both the key
            // and the in-memory/on-disk endpoint so no half-revoked state remains.
            let provider = s("provider");
            let previous_key = keys::get_key(&state.data_dir, &provider).ok();
            let previous_ai = { state.auth.config.lock().expect("lock").ai.clone() };
            keys::delete_key(&state.data_dir, &provider)?;
            let removed = {
                state
                    .auth
                    .config
                    .lock()
                    .expect("lock")
                    .remove_endpoint(&provider)
            };
            if let Err(error) = removed {
                restore_key(&state.data_dir, &provider, previous_key.as_deref());
                restore_ai(state, &previous_ai);
                return Err(format!(
                    "API key revoked, but endpoint cleanup failed: {error}"
                ));
            }
            Ok("null".into())
        }
        "list_api_keys" => {
            let providers: Vec<String> = args
                .get("providers")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|x| x.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            Ok(
                serde_json::to_string(&keys::list_keys(&state.data_dir, &providers))
                    .map_err(|e| e.to_string())?,
            )
        }
        // Non-secret AI configuration: every configured endpoint, which one is
        // active, and which providers have a key. The browser cannot recover these
        // from localStorage after a device or origin change, so it re-reads them
        // from here on every load.
        "ai_settings" => {
            let data_dir = state.data_dir.clone();
            let env = probe::custom_env_config();
            // Server-authoritative: the client list is never trusted here, so a
            // custom endpoint or a key saved before the catalog changed still
            // shows up after a browser/device switch.
            let mut saved = keys::configured_providers(&data_dir);
            saved.retain(|p| agent::PROVIDER_IDS.iter().any(|id| id == p));
            if env.is_some() && !saved.iter().any(|p| p == agent::CUSTOM_PROVIDER_ID) {
                saved.push(agent::CUSTOM_PROVIDER_ID.to_string());
            }
            let cfg = state.auth.config.lock().expect("lock");
            // Server-side guard: the active pointer can name an endpoint that is no
            // longer there (hand-edited config), so it is resolved, not echoed.
            let active = cfg
                .active_endpoint()
                .map(|(p, _)| p.to_string())
                .unwrap_or_default();
            let endpoints = cfg
                .ai
                .endpoints
                .iter()
                .map(|(provider, endpoint)| {
                    // `hasKey` is per endpoint: a configured URL with no credential
                    // is shown as incomplete rather than ready.
                    let has_key = if provider == agent::CUSTOM_PROVIDER_ID {
                        env.as_ref().is_some_and(|(_, key, _)| key.is_some())
                            || !keys::list_keys(&data_dir, std::slice::from_ref(provider))
                                .is_empty()
                    } else {
                        !keys::list_keys(&data_dir, std::slice::from_ref(provider)).is_empty()
                    };
                    (
                        provider.clone(),
                        json!({
                            "baseUrl": endpoint.base_url,
                            "model": endpoint.model,
                            // Measured tool-call support, so a new browser does not run
                            // text-only until every model is re-probed.
                            "probes": endpoint.probes,
                            "hasKey": has_key,
                        }),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            let mut out = json!({
                "active": active,
                "endpoints": endpoints,
                "savedProviders": saved,
            });
            // Env override: the UI shows the bound values as read-only. Omitted
            // entirely when unset so the browser can tell "not overridden".
            if let Some((url, key, model)) = env {
                out["env"] = json!({
                    "baseUrl": url,
                    "model": model.unwrap_or_default(),
                    "hasKey": key.is_some()
                        || !keys::list_keys(&data_dir, &[agent::CUSTOM_PROVIDER_ID.to_string()]).is_empty(),
                });
            }
            Ok(out.to_string())
        }
        "set_ai_settings" => {
            // Selection only: the endpoint itself is created by `set_api_key` /
            // `set_custom_endpoint`, so switching providers cannot invent one.
            let provider = s("provider");
            let model = s("model");
            let base_url = s("baseUrl");
            let mut cfg = state.auth.config.lock().expect("lock");
            cfg.set_active(&provider, &model)?;
            // The UI may report the URL it is bound to; adopt it when non-empty so
            // an endpoint saved before URL relocations did not exist still catches up.
            let needs_url = !base_url.is_empty()
                && cfg
                    .ai
                    .endpoints
                    .get(&provider)
                    .is_some_and(|e| e.base_url.is_empty());
            if needs_url {
                cfg.complete_endpoint(&provider, &model, &base_url)?;
            }
            Ok("null".into())
        }
        "set_probe" => {
            // Single measurement (auto-probe / API-key save). Does NOT touch the
            // selection: the probe is keyed by provider+model and arriving here
            // does not mean the user switched to that model.
            let provider = s("provider");
            let model = s("model");
            let tools = args.get("tools").and_then(|t| t.as_bool());
            let Some(tools) = tools else {
                return Err("tools must be a boolean".into());
            };
            state
                .auth
                .config
                .lock()
                .expect("lock")
                .set_probe(&provider, &model, tools)
                .map(|_| "null".into())
        }
        "web_vaults" => cmds::web_vaults(state),
        "web_vault_root" => Ok(state.data_dir.join("vaults").to_string_lossy().to_string()),
        // ── account / system ──
        "setup_status" => {
            let cfg = state.auth.config.lock().expect("lock");
            Ok(json!({ "setupRequired": cfg.admin.is_none(), "setupToken": cfg.setup_token.is_some() }).to_string())
        }
        "account_get" => {
            let cfg = state.auth.config.lock().expect("lock");
            match &cfg.admin {
                Some(a) => Ok(json!({ "email": a.email }).to_string()),
                None => Err("No admin account".into()),
            }
        }
        "change_password" => {
            state
                .auth
                .config
                .lock()
                .expect("lock")
                .change_password(&s("old"), &s("new"))?;
            state.auth.sessions.revoke_all();
            Ok("null".into())
        }
        "config_get" => Ok(state
            .auth
            .config
            .lock()
            .expect("lock")
            .view(&state.data_dir)
            .to_string()),
        "config_set" => {
            let key = s("key");
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            state
                .auth
                .config
                .lock()
                .expect("lock")
                .set(&key, &value)
                .map(|_| "null".into())
        }
        _ => Err(format!("Unknown command: {cmd}")),
    }
}

/** Run a blocking command body off the async runtime (spawn_blocking). */
pub(crate) async fn sb(state: &AppState, cmd: &str, args: Value) -> Result<String, String> {
    let st = state.clone();
    let c = cmd.to_string();
    let a = args;
    tokio::task::spawn_blocking(move || sync(&st, &c, a))
        .await
        .map_err(|e| e.to_string())?
}

// ── command bodies (mirror src-tauri/src/lib.rs) ──

pub(crate) async fn api(
    State(state): State<AppState>,
    AxPath(cmd): AxPath<String>,
    Json(args): Json<Value>,
) -> Response {
    match dispatch(&state, &cmd, args).await {
        Ok(s) => Json(json!({ "result": s })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/** F2: web server only — vault paths must stay inside DATA_DIR. Desktop is
 *  unaffected (it opens any local folder by design). All normal UI flows use
 *  paths under DATA_DIR/vaults, so this only blocks the arbitrary-read vector.
 *  Tolerates not-yet-existing children (first cmds::create_vault on a fresh data dir)
 *  by canonicalizing the nearest existing ancestor, then appending the tail. */
pub(crate) fn ensure_within_data(state: &AppState, path: &str) -> Result<String, String> {
    let data = state.data_dir.canonicalize().map_err(|e| e.to_string())?;
    let p = std::path::Path::new(path);
    let mut existing = p;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                existing = parent;
            }
            _ => break,
        }
    }
    let mut canon = existing
        .canonicalize()
        .map_err(|_| "Path does not exist".to_string())?;
    for part in tail.iter().rev() {
        canon.push(part);
    }
    if canon.starts_with(&data) {
        Ok(canon.to_string_lossy().to_string())
    } else {
        Err("Path is outside the server data directory".into())
    }
}
