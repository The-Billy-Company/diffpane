// Copyright (c) 2026 The Billy Company
use super::{MediaFile, MediaServer};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

const TOKEN: &str = "53ae5355-431c-46b8-8306-8ced6501ff09";
const VIDEO_PATH: &str = "videos%2Fspace%20%23%20%E9%9B%AA.MP4";
const APP_ORIGIN: &str = "tauri://localhost";

struct Workspace {
    directory: PathBuf,
    root: PathBuf,
}

impl Workspace {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "diffpane-media-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        let root = directory.join("workspace");
        std::fs::create_dir_all(root.join("videos")).unwrap();
        Self { directory, root }
    }

    fn serve(&self) -> MediaServer {
        let root = self.root.clone();
        MediaServer::start(APP_ORIGIN, move |window, token, file| {
            let root = root.clone();
            async move {
                if window != "workspace-1" || token != TOKEN {
                    return Err("Media authorization expired.".into());
                }
                let mime = if file.ends_with(".png") {
                    "image/png"
                } else if file.ends_with(".svg") {
                    "image/svg+xml"
                } else if file.ends_with(".MP4") {
                    "video/mp4"
                } else {
                    return Err("Unsupported media.".into());
                };
                Ok(MediaFile {
                    root,
                    path: PathBuf::from(file),
                    mime: mime.into(),
                })
            }
        })
        .unwrap()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

struct Response {
    headers: String,
    body: Vec<u8>,
}

impl Response {
    fn has_status(&self, status: u16) -> bool {
        self.headers.starts_with(&format!("HTTP/1.1 {status} "))
    }
}

async fn request(server: &MediaServer, method: &str, route: &str, headers: &str) -> Response {
    timeout(Duration::from_secs(5), async {
        let authority = server.origin().strip_prefix("http://").unwrap();
        let mut socket = TcpStream::connect(authority).await.unwrap();
        let request = format!(
            "{method} /media/{route} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n{headers}\r\n"
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        socket.read_to_end(&mut reply).await.unwrap();
        let body_start = reply.windows(4).position(|part| part == b"\r\n\r\n").unwrap() + 4;
        Response {
            body: reply.split_off(body_start),
            headers: String::from_utf8(reply).unwrap(),
        }
    })
    .await
    .unwrap()
}

fn route(file: &str) -> String {
    format!("workspace-1/{TOKEN}/{file}")
}

#[tokio::test]
async fn streams_large_unicode_named_media_and_byte_ranges() {
    let workspace = Workspace::new();
    let bytes = vec![42; 3 * 1024 * 1024];
    std::fs::write(workspace.root.join("videos/space # 雪.MP4"), &bytes).unwrap();
    let server = workspace.serve();
    let route = route(VIDEO_PATH);

    let response = request(&server, "GET", &route, "Origin: tauri://localhost\r\n").await;
    assert!(response.has_status(200), "{}", response.headers);
    assert!(response.headers.contains("content-type: video/mp4"));
    assert!(
        response
            .headers
            .contains("access-control-allow-origin: tauri://localhost")
    );
    assert_eq!(response.body, bytes);

    let length = bytes.len();
    for (range, start, end) in [
        ("bytes=100-199", 100, 199),
        ("bytes=3145720-", 3_145_720, length - 1),
        ("bytes=-10", length - 10, length - 1),
        ("bytes=3145720-9999999", 3_145_720, length - 1),
    ] {
        let response = request(&server, "GET", &route, &format!("Range: {range}\r\n")).await;
        assert!(response.has_status(206), "{}", response.headers);
        assert!(
            response
                .headers
                .contains(&format!("content-range: bytes {start}-{end}/{length}"))
        );
        assert_eq!(response.body, bytes[start..=end], "{range}");
    }

    let head = request(&server, "HEAD", &route, "").await;
    assert!(head.has_status(200), "{}", head.headers);
    assert!(head.headers.contains(&format!("content-length: {length}")));
    assert!(head.body.is_empty());

    for range in [
        "bytes=9999999-",
        "bytes=3-1",
        "bytes=-0",
        "bytes=0-1,3-4",
        "bytes=-",
    ] {
        let response = request(&server, "GET", &route, &format!("Range: {range}\r\n")).await;
        assert!(response.has_status(416), "{}", response.headers);
        assert!(
            response
                .headers
                .contains(&format!("content-range: bytes */{length}"))
        );
        assert!(response.body.is_empty());
    }
}

#[tokio::test]
async fn validates_origin_window_scope_and_files_before_streaming() {
    let workspace = Workspace::new();
    let outside = workspace.directory.join("secret.png");
    std::fs::write(&outside, b"external").unwrap();
    std::fs::write(workspace.root.join("normal.png"), b"workspace").unwrap();
    std::fs::write(workspace.root.join("script.js"), b"other").unwrap();
    std::fs::create_dir(workspace.root.join("directory.png")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        symlink(&outside, workspace.root.join("link.png")).unwrap();
        symlink(&workspace.directory, workspace.root.join("outside")).unwrap();
    }
    let server = workspace.serve();
    let valid = route("normal.png");
    assert!(request(&server, "GET", &valid, "").await.has_status(200));
    assert!(
        request(&server, "GET", &valid, "Origin: https://example.com\r\n")
            .await
            .has_status(403)
    );
    assert!(request(&server, "POST", &valid, "").await.has_status(405));
    for invalid in ["%2e%2e%2fsecret.png", "script.js", "directory.png"] {
        assert!(
            request(&server, "GET", &route(invalid), "")
                .await
                .has_status(403),
            "{invalid}"
        );
    }
    assert!(
        request(&server, "GET", &route("missing.png"), "")
            .await
            .has_status(404)
    );
    let wrong_token = "workspace-1/a3e6fb9a-a3ed-44e9-83df-ed5204208009/normal.png";
    assert!(
        request(&server, "GET", wrong_token, "")
            .await
            .has_status(403)
    );
    let wrong_window = format!("workspace-2/{TOKEN}/normal.png");
    assert!(
        request(&server, "GET", &wrong_window, "")
            .await
            .has_status(403)
    );
    #[cfg(unix)]
    for symlink in ["link.png", "outside%2Fsecret.png"] {
        assert!(
            request(&server, "GET", &route(symlink), "")
                .await
                .has_status(403),
            "{symlink}"
        );
    }
}

#[tokio::test]
async fn returns_empty_media_without_opening_a_body_stream() {
    let workspace = Workspace::new();
    std::fs::write(workspace.root.join("empty.svg"), b"").unwrap();
    let response = request(&workspace.serve(), "GET", &route("empty.svg"), "").await;
    assert!(response.has_status(200), "{}", response.headers);
    assert!(response.headers.contains("content-type: image/svg+xml"));
    assert!(response.headers.contains("content-length: 0"));
    assert!(response.body.is_empty());
}
