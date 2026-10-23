//! Application menu.
//!
//! Tauri's default macOS menu binds **Cmd+W** to *Close Window*
//! (`muda::PredefinedMenuItem::close_window`). In an editor that target is
//! wrong: Cmd+W must close the **active tab**, and only fall back to closing
//! the window when no tab is left. A predefined item exposes no accelerator
//! setter, so the menu is built explicitly here instead of patched.
//!
//! Everything else mirrors Tauri's default menu, so the Edit menu (clipboard
//! actions), the macOS app menu, and window management behave as before. The
//! window keeps an explicit shortcut (Cmd+Shift+W) rather than the one the
//! platform reserves for it.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// Menu id of the *Close Tab* item — routed to the frontend, which owns tabs.
pub const CLOSE_TAB: &str = "close_tab";
/// Menu id of the *Close Window* item — closes the window directly.
pub const CLOSE_WINDOW: &str = "close_window";

/// Accelerators live next to the items, in one place.
const ACCEL_CLOSE_TAB: &str = "CmdOrCtrl+W";
const ACCEL_CLOSE_WINDOW: &str = "CmdOrCtrl+Shift+W";

/// Builds the application menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // Cmd+W belongs to the active tab; the window gets its own explicit
    // shortcut instead of the one the platform reserves for it.
    let close_tab = MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some(ACCEL_CLOSE_TAB))?;
    let close_window =
        MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some(ACCEL_CLOSE_WINDOW))?;

    // File: the default File menu only held Close Window (plus Quit outside
    // macOS), so it becomes the home of the tab action.
    #[cfg(not(target_os = "macos"))]
    let file = SubmenuBuilder::new(app, "File")
        .item(&close_tab)
        .item(&close_window)
        .separator()
        .quit()
        .build()?;
    #[cfg(target_os = "macos")]
    let file = SubmenuBuilder::new(app, "File")
        .item(&close_tab)
        .item(&close_window)
        .build()?;

    // Edit/View/Window match Tauri's defaults so clipboard and window
    // management keep working exactly as they did before.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    // Help mirrors the default: empty on macOS (About lives in the app menu),
    // About elsewhere.
    #[cfg(target_os = "macos")]
    let help = SubmenuBuilder::new(app, "Help").build()?;
    #[cfg(not(target_os = "macos"))]
    let help = SubmenuBuilder::new(app, "Help")
        .about(Some(about.clone()))
        .build()?;

    let menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::new(app, pkg.name.clone())
            .about(Some(about))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .separator()
            .quit()
            .build()?,
    );
    let menu = menu
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help);

    menu.build()
}
