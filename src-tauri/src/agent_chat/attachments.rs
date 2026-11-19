/// Where pasted images are kept. Under ~/.octiqflow rather than in the
/// project, because a screenshot pasted into a chat is not part of a
/// repository and must never turn up in git status.
pub(crate) fn attachments_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::paths::home_dir()
        .ok_or("could not find your home folder")?
        .join(".octiqflow")
        .join("attachments");
    crate::profile::create_dir_all(&dir).map_err(|e| format!("could not make {dir:?}: {e}"))?;
    Ok(dir)
}

/// Save a browser upload and return the server path used by both agents.
/// Older clients send only an image extension; new clients also send a filename.
pub fn save_attachment(
    data_base64: String,
    extension: String,
    filename: Option<String>,
) -> Result<String, String> {
    let bytes = decode_attachment(&data_base64)?;
    let name = attachment_name(filename.as_deref(), &extension)?;
    let path = attachments_dir()?.join(format!("{}-{name}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| format!("could not save the file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub(super) fn attachment_name(filename: Option<&str>, extension: &str) -> Result<String, String> {
    if let Some(filename) = filename {
        // Strip both platforms' path separators and controls. Keep Unicode and
        // the original extension so document tools can recognize the upload.
        let name: String = filename
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        if name.is_empty() || name == "." || name == ".." || name.len() > 200 {
            return Err("invalid filename (maximum 200 bytes)".into());
        }
        return Ok(name);
    }
    let ext = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Ok(format!("pasted.{ext}")),
        _ => Err(format!("unsupported image type: {extension}")),
    }
}

pub(super) fn decode_attachment(data_base64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    const LIMIT: usize = 12 * 1024 * 1024;
    if data_base64.len() > LIMIT / 3 * 4 {
        return Err("file is larger than 12 MB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("not valid base64: {e}"))?;
    if bytes.len() > LIMIT {
        return Err("file is larger than 12 MB".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod upload_tests {
    use super::{attachment_name, decode_attachment};
    use base64::Engine;

    #[test]
    fn accepts_documents_without_mime_types_and_keeps_unicode_names() {
        assert_eq!(
            attachment_name(Some("报告.docx"), ""),
            Ok("报告.docx".into())
        );
        assert_eq!(attachment_name(Some("README"), ""), Ok("README".into()));
        let pdf = b"%PDF-1.7\n\0\xff";
        assert_eq!(
            decode_attachment(&base64::engine::general_purpose::STANDARD.encode(pdf)),
            Ok(pdf.to_vec())
        );
        assert_eq!(decode_attachment(""), Ok(vec![]));
    }

    #[test]
    fn confines_names_and_keeps_legacy_image_uploads() {
        assert_eq!(
            attachment_name(Some("../../report.pdf"), ""),
            Ok("report.pdf".into())
        );
        assert_eq!(
            attachment_name(Some(r"C:\docs\report.pdf"), ""),
            Ok("report.pdf".into())
        );
        assert!(attachment_name(Some(".."), "").is_err());
        assert!(attachment_name(Some(&"a".repeat(201)), "").is_err());
        assert_eq!(attachment_name(None, ".JPEG"), Ok("pasted.jpeg".into()));
        assert!(attachment_name(None, "../pdf").is_err());
    }

    #[test]
    fn rejects_invalid_and_oversized_payloads() {
        assert!(decode_attachment("!invalid!").is_err());
        assert!(decode_attachment(&"A".repeat(16 * 1024 * 1024 + 4)).is_err());
    }
}
