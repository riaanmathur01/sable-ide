//! LSP wire framing — the `Content-Length` header protocol that wraps
//! every JSON-RPC message travelling to/from a language server.
//!
//! Each message on the wire looks EXACTLY like this:
//!
//! ```text
//! Content-Length: 124\r\n
//! \r\n
//! {"jsonrpc":"2.0", ...}      <- exactly 124 *bytes* of UTF-8 JSON
//! ```
//!
//! Two rules cause ~all "server connects but nothing works" bugs:
//!   1. `Content-Length` is the number of **bytes** in the UTF-8 payload,
//!      not the number of characters. For ASCII they're equal; for any
//!      multi-byte character they differ and the stream desyncs.
//!   2. The header block ends with a blank line — i.e. the four bytes
//!      `\r\n\r\n` separate headers from the payload. Read headers
//!      line-by-line until an empty line, THEN read exactly N bytes.

use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};

/// Write one JSON payload as a framed LSP message.
///
/// `payload` is already-serialized JSON. We measure its byte length
/// (`payload.len()` on a `&str`/`String` is the UTF-8 byte count, which
/// is exactly what LSP wants), write the header + blank line, then the
/// raw bytes.
pub async fn write_message<W: AsyncWrite + Unpin>(
    writer: &mut W,
    payload: &str,
) -> std::io::Result<()> {
    let header = format!("Content-Length: {}\r\n\r\n", payload.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(payload.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

/// Read one framed LSP message, returning its JSON payload as a String.
///
/// Returns `Ok(None)` on a clean EOF (the server closed its stdout),
/// which the caller treats as "the server exited".
pub async fn read_message<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> std::io::Result<Option<String>> {
    let mut content_length: Option<usize> = None;

    // --- Header block: read lines until the blank separator line. ---
    loop {
        let mut line = String::new();
        let bytes_read = reader.read_line(&mut line).await?;
        if bytes_read == 0 {
            // EOF before any header — the server is gone.
            return Ok(None);
        }
        // `read_line` keeps the trailing \r\n; trim it to inspect.
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            // Blank line: end of headers, payload follows.
            break;
        }
        // Headers are `Name: value`. We only care about Content-Length.
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().ok();
        }
        // Other headers (e.g. Content-Type) are ignored.
    }

    let length = content_length.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "LSP message missing Content-Length header",
        )
    })?;

    // --- Payload: read EXACTLY `length` bytes, no more, no less. ---
    let mut payload_bytes = vec![0u8; length];
    reader.read_exact(&mut payload_bytes).await?;
    let payload = String::from_utf8(payload_bytes).map_err(|error| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, error)
    })?;
    Ok(Some(payload))
}
