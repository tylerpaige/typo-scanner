use tauri::ipc::{InvokeBody, Request};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri_plugin_dialog::DialogExt;

/// Receives a finished PDF as the raw request body, asks where to put it, and
/// writes it there. Returns the saved path, or `None` if the dialog was cancelled.
#[tauri::command]
async fn save_pdf(app: tauri::AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the PDF as raw bytes".into());
    };
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name("scan.pdf")
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // macOS still asks once for camera access; this stops WebKit asking again on every launch.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .invoke_handler(tauri::generate_handler![save_pdf])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
