mod files;
#[cfg(test)]
mod tests;

use std::{
    future::Future,
    io,
    net::{Ipv4Addr, TcpListener},
    path::PathBuf,
    pin::Pin,
    sync::Arc,
};

use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::Response,
    routing::get,
};
use serde::Deserialize;
use tauri::async_runtime::{self, JoinHandle};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

type MediaResolution = Pin<Box<dyn Future<Output = Result<MediaFile, String>> + Send>>;
type MediaResolver = dyn Fn(String, String, String) -> MediaResolution + Send + Sync;

#[derive(Deserialize)]
pub(crate) struct MediaFile {
    root: PathBuf,
    path: PathBuf,
    #[serde(rename = "type")]
    mime: String,
}

struct MediaState {
    authority: HeaderValue,
    app_origin: HeaderValue,
    resolve: Box<MediaResolver>,
}

pub(crate) struct MediaServer {
    origin: String,
    server: JoinHandle<()>,
}

impl MediaServer {
    pub(crate) fn start<F, Fut>(app_origin: &str, resolve: F) -> io::Result<Self>
    where
        F: Fn(String, String, String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<MediaFile, String>> + Send + 'static,
    {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let authority = listener.local_addr()?.to_string();
        let origin = format!("http://{authority}");
        let state = Arc::new(MediaState {
            authority: HeaderValue::try_from(authority).map_err(io::Error::other)?,
            app_origin: HeaderValue::try_from(app_origin).map_err(io::Error::other)?,
            resolve: Box::new(move |window, token, path| Box::pin(resolve(window, token, path))),
        });
        let router = Router::new()
            .route("/media/{window}/{token}/{file}", get(read_media))
            .with_state(state);
        let server = async_runtime::spawn(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                let _ = axum::serve(listener, router).await;
            }
        });
        Ok(Self { origin, server })
    }

    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }
}

impl Drop for MediaServer {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn read_media(
    State(state): State<Arc<MediaState>>,
    Path((window, token, path)): Path<(String, String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    // Prevent DNS rebinding and exclude websites. Native WebKit media requests can omit Origin.
    if headers.get(header::HOST) != Some(&state.authority)
        || headers
            .get(header::ORIGIN)
            .is_some_and(|origin| origin != state.app_origin)
        || !window.starts_with("workspace-")
        || !uuid_token(&token)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let file = (state.resolve)(window, token, path)
        .await
        .map_err(|_| StatusCode::FORBIDDEN)?;
    if !["audio/", "video/", "image/"]
        .iter()
        .any(|kind| file.mime.starts_with(kind))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let mime = HeaderValue::try_from(&file.mime).map_err(|_| StatusCode::FORBIDDEN)?;
    let (mut descriptor, size) = files::open(file.root, file.path).await?;
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        )
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            state.app_origin.clone(),
        );

    let (start, length) = if let Some(range) = headers.get(header::RANGE) {
        let Some((start, end)) = range
            .to_str()
            .ok()
            .and_then(|range| files::range(range, size))
        else {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
        };
        response = response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
        (start, end - start + 1)
    } else {
        (0, size)
    };
    let body = if method == Method::HEAD || length == 0 {
        Body::empty()
    } else {
        files::seek(&mut descriptor, start).await?;
        Body::from_stream(ReaderStream::new(descriptor.take(length)))
    };
    response
        .header(header::CONTENT_LENGTH, length)
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn uuid_token(token: &str) -> bool {
    token.len() == 36
        && token.as_bytes().iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}
