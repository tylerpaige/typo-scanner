use image::codecs::jpeg::{JpegDecoder, JpegEncoder};
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder};
use serde::Serialize;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
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

/// Asks for the folder the scanner saves into.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    Ok(Some(picked.into_path().map_err(|e| e.to_string())?.display().to_string()))
}

const SCAN_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "tif", "tiff", "heic", "heif"];

fn is_scan(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SCAN_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

#[derive(Serialize)]
struct ScanFile {
    path: String,
    size: u64,
    /// Milliseconds since the epoch.
    modified: u64,
}

/// The image files directly inside `dir`, for the scanner intake to watch.
#[tauri::command]
fn list_scans(dir: String) -> Result<Vec<ScanFile>, String> {
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    Ok(entries
        .filter_map(Result::ok)
        .filter(|e| is_scan(&e.path()) && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some(ScanFile { path: e.path().display().to_string(), size: meta.len(), modified })
        })
        .collect())
}

/// A scan or photo's bytes, as JPEG or PNG the right way up. TIFFs become PNG and HEICs JPEG,
/// since the webview may not decode them, and photos stored sideways (as iPhones do) are turned upright.
#[tauri::command]
async fn read_scan(path: String) -> Result<Response, String> {
    scan_bytes(Path::new(&path)).map(Response::new)
}

fn scan_bytes(path: &Path) -> Result<Vec<u8>, String> {
    if !is_scan(path) {
        return Err("not a scan".into());
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "heic" | "heif" => upright_jpeg(heic_to_jpeg(path)?),
        "jpg" | "jpeg" => upright_jpeg(std::fs::read(path).map_err(err)?),
        "tif" | "tiff" => {
            let mut decoder = image::ImageReader::open(path).map_err(err)?.with_guessed_format().map_err(err)?.into_decoder().map_err(err)?;
            let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
            let mut img = DynamicImage::from_decoder(decoder).map_err(err)?;
            img.apply_orientation(orientation);
            let mut png = Vec::new();
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                &mut png,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::Sub,
            );
            img.to_rgb8().write_with_encoder(encoder).map_err(err)?;
            Ok(png)
        }
        _ => std::fs::read(path).map_err(err),
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Passes a JPEG through untouched, unless its EXIF says it's stored turned or flipped,
/// in which case it's re-encoded the right way up.
fn upright_jpeg(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut decoder = JpegDecoder::new(Cursor::new(&bytes)).map_err(err)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    if matches!(orientation, Orientation::NoTransforms) {
        return Ok(bytes);
    }
    let mut img = DynamicImage::from_decoder(decoder).map_err(err)?;
    img.apply_orientation(orientation);
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 92).encode_image(&img.to_rgb8()).map_err(err)?;
    Ok(out)
}

/// Converts with macOS's own `sips`, which reads HEIC through the system's image libraries.
fn heic_to_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    static COUNT: AtomicU32 = AtomicU32::new(0);
    let out = std::env::temp_dir().join(format!(
        "webcam-document-scanner-{}-{}.jpg",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg", "-s", "formatOptions", "92"])
        .arg(path)
        .arg("--out")
        .arg(&out)
        .output()
        .map_err(|e| format!("couldn't run sips: {e}"));
    let bytes = result.and_then(|o| {
        if o.status.success() {
            std::fs::read(&out).map_err(err)
        } else {
            Err(format!("couldn't convert HEIC: {}", String::from_utf8_lossy(&o.stderr).trim()))
        }
    });
    let _ = std::fs::remove_file(&out);
    bytes
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
        .invoke_handler(tauri::generate_handler![save_pdf, pick_folder, list_scans, read_scan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_scans_and_converts_tiff() {
        let dir = std::env::temp_dir().join(format!("wds-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = image::RgbImage::from_pixel(3, 2, image::Rgb([10, 20, 30]));
        img.save(dir.join("a.tiff")).unwrap();
        img.save(dir.join("b.png")).unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join(".hidden.jpg"), "x").unwrap();

        let mut names: Vec<_> = list_scans(dir.display().to_string())
            .unwrap()
            .into_iter()
            .map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["a.tiff", "b.png"]);

        let png = scan_bytes(&dir.join("a.tiff")).unwrap();
        assert_eq!(image::guess_format(&png).unwrap(), image::ImageFormat::Png);
        let decoded = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!((decoded.width(), decoded.height(), decoded.get_pixel(1, 1).0), (3, 2, [10, 20, 30]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wds-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 4×2 image: left half red, right half blue.
    fn halves() -> image::RgbImage {
        image::RgbImage::from_fn(4, 2, |x, _| if x < 2 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) })
    }

    #[test]
    fn turns_sideways_jpegs_upright_and_leaves_others_alone() {
        let mut plain = Vec::new();
        JpegEncoder::new_with_quality(&mut plain, 95).encode_image(&halves()).unwrap();
        assert_eq!(upright_jpeg(plain.clone()).unwrap(), plain);

        // Insert an EXIF block saying "rotate 90° clockwise to display" (orientation 6), as an iPhone writes.
        let exif: &[u8] = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0";
        let mut tagged = plain[..2].to_vec();
        tagged.extend([0xFF, 0xE1]);
        tagged.extend(((exif.len() + 2) as u16).to_be_bytes());
        tagged.extend(exif);
        tagged.extend(&plain[2..]);

        let upright = image::load_from_memory(&upright_jpeg(tagged).unwrap()).unwrap().to_rgb8();
        assert_eq!((upright.width(), upright.height()), (2, 4));
        // Turned clockwise, the red left half is now on top.
        assert!(upright.get_pixel(1, 0).0[0] > 200 && upright.get_pixel(1, 3).0[2] > 200);
    }

    #[test]
    fn reads_heic_and_lists_it() {
        let dir = test_dir("heic");
        let png = dir.join("page.png");
        halves().save(&png).unwrap();
        let heic = dir.join("IMG_0001.HEIC");
        let made = std::process::Command::new("/usr/bin/sips").args(["-s", "format", "heic"]).arg(&png).arg("--out").arg(&heic).output().unwrap();
        assert!(made.status.success(), "sips couldn't make a HEIC to test with");

        let listed: Vec<_> = list_scans(dir.display().to_string()).unwrap().into_iter().map(|f| f.path).collect();
        assert!(listed.iter().any(|p| p.ends_with("IMG_0001.HEIC")));
        let jpeg = scan_bytes(&heic).unwrap();
        assert_eq!(image::guess_format(&jpeg).unwrap(), image::ImageFormat::Jpeg);
        let decoded = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!((decoded.width(), decoded.height()), (4, 2));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

