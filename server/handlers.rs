// Command handlers (isolated).
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
        "git_push" => {
            let m = s("message");
            tokio::task::spawn_blocking(move || cmds::git_push(&st, &m))
                .await
                .map_err(|e| e.to_string())?
        }
        "close_vault" => sync(state, cmd, args),
        "list_tree" => sb(state, cmd, args).await,
        "read_file" => sync(state, cmd, args),
        "write_file" => sync(state, cmd, args),
        "create_file" => sync(state, cmd, args),
        "create_directory" => sync(state, cmd, args),
        "delete_file" => sb(state, cmd, args).await,
        "list_trash" => sync(state, cmd, args),
        "restore_file" => sync(state, cmd, args),
        "empty_trash" => sync(state, cmd, args),
        "rename_file" => sync(state, cmd, args),
        "git_settings" => sb(state, cmd, args).await,
        "git_add_remote" => sb(state, cmd, args).await,
        "git_remove_remote" => sb(state, cmd, args).await,
        "git_set_identity" => sb(state, cmd, args).await,
        "git_init" => sb(state, cmd, args).await,
        "git_stage" => sb(state, cmd, args).await,
        "git_status" => sb(state, cmd, args).await,
        "wiki_backlinks" => sync(state, cmd, args),
        "wiki_suggest" => sync(state, cmd, args),
        "wiki_resolve" => sync(state, cmd, args),
        "custom_ai_config" => sync(state, cmd, args),
        "markdown_preview" => sync(state, cmd, args),
        "md_to_html" => sync(state, cmd, args),
        "cancel_ai" => sync(state, cmd, args),
        "set_api_key" => sync(state, cmd, args),
        "set_custom_endpoint" => sync(state, cmd, args),
        "delete_api_key" => sync(state, cmd, args),
        "list_api_keys" => sync(state, cmd, args),
        "web_vaults" => sync(state, cmd, args),
        "web_vault_root" => sync(state, cmd, args),
        "setup_status" => sync(state, cmd, args),
        "account_get" => sync(state, cmd, args),
        "change_password" => sync(state, cmd, args),
        "config_get" => sync(state, cmd, args),
        "config_set" => sync(state, cmd, args),
        "ai_grounding_context" => cmds::ai_grounding_context(state, &s("query"), &s("activePath")),
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
            Some(v) => v.read_file(&s("path")),
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
        "empty_trash" => {
            let r = match state.vault.lock().expect("lock").as_ref() {
                Some(v) => v.empty_trash().map(|_| "null".into()),
                None => Err("No vault".into()),
            };
            if r.is_ok() {
                cmds::rescan_wiki(state);
            }
            r
        }
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
            Some(g) => g.init().map(|_| "null".into()),
            None => Err("No vault".into()),
        },
        "git_stage" => match state.git.lock().expect("lock").as_ref() {
            Some(g) => g
                .add_all()
                .map_err(|e| e.to_string())
                .map(|_| "null".into()),
            None => Err("No vault".to_string()),
        },
        "git_status" => {
            let guard = state.git.lock().expect("lock");
            match guard.as_ref() {
                Some(g) if g.is_repo() => {
                    let (branch, status) = g.status_with_branch().unwrap_or_default();
                    Ok(json!({ "branch": branch, "status": status.trim() }).to_string())
                }
                _ => Ok(r#"{"branch":"","status":""}"#.to_string()),
            }
        }
        "wiki_backlinks" => match state.wiki.lock().expect("lock").as_ref() {
            Some(w) => serde_json::to_string(&w.backlinks(&s("path"))).map_err(|e| e.to_string()),
            None => Ok("[]".to_string()),
        },
        "wiki_suggest" => match state.wiki.lock().expect("lock").as_ref() {
            Some(w) => serde_json::to_string(&w.suggest(&s("query"))).map_err(|e| e.to_string()),
            None => Ok("[]".to_string()),
        },
        "wiki_resolve" => match state.wiki.lock().expect("lock").as_ref() {
            Some(w) => Ok(w.resolve(&s("title")).unwrap_or_default()),
            None => Ok(String::new()),
        },
        "custom_ai_config" => {
            let env = probe::custom_env_config();
            let source = if env.is_some() { "env" } else { "file" };
            let base_url = match &env {
                Some((eb, _, _)) => Some(eb.clone()),
                None => keys::get_base_url(&state.data_dir, agent::CUSTOM_PROVIDER_ID).ok(),
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
        "markdown_preview" => Ok(markdown::markdown_preview(&s("content"))),
        "md_to_html" => Ok(markdown::markdown_to_safe_html(&s("content"))),
        "cancel_ai" => {
            state.ai_cancel.store(true, Ordering::SeqCst);
            Ok("null".into())
        }
        "set_api_key" => {
            keys::set_key(&state.data_dir, &s("provider"), &s("key")).map(|_| "null".into())
        }
        "set_custom_endpoint" => {
            if probe::custom_env_base_url().is_some() {
                return Err("Custom endpoint is controlled by DB_OPENAI_COMPAT_BASE_URL — remove the env var to edit in the UI".into());
            }
            let url = s("baseUrl");
            agent::validate_custom_base_url(&url, false)?;
            keys::set_base_url(&state.data_dir, &s("provider"), &url)?;
            keys::set_key(&state.data_dir, &s("provider"), &s("key")).map(|_| "null".into())
        }
        "delete_api_key" => {
            let _ = keys::delete_base_url(&state.data_dir, &s("provider")); // best-effort — entry may not exist
            keys::delete_key(&state.data_dir, &s("provider")).map(|_| "null".into())
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
        "web_vaults" => cmds::web_vaults(state),
        "web_vault_root" => Ok(state.data_dir.join("vaults").to_string_lossy().to_string()),
        // ── account / system ──
        "setup_status" => {
            let cfg = state.auth.config.lock().expect("lock");
            Ok(json!({ "setupRequired": cfg.admin.is_none(), "noAuth": cfg.no_auth, "setupToken": cfg.setup_token.is_some() }).to_string())
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
