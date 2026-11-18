use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

type Outcome = Result<Box<RawValue>, String>;
type Replies = HashMap<u64, oneshot::Sender<Outcome>>;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Message {
    Request {
        id: u64,
        method: String,
        args: Vec<Value>,
    },
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Event {
        event: String,
        args: Vec<Value>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Request,
    Response,
    Event,
}

// Deserialize the envelope directly so serde can borrow the JSON response text.
// Internally tagged enums buffer their fields before choosing a variant.
#[derive(Deserialize)]
struct IncomingFrame<'a> {
    kind: Kind,
    id: Option<u64>,
    method: Option<String>,
    event: Option<String>,
    args: Option<Vec<Value>>,
    ok: Option<bool>,
    #[serde(borrow)]
    value: Option<&'a RawValue>,
    error: Option<String>,
}

enum IncomingMessage<'a> {
    Request {
        id: u64,
        method: String,
        args: Vec<Value>,
    },
    Response {
        id: u64,
        outcome: Result<&'a RawValue, String>,
    },
    Event {
        event: String,
        args: Vec<Value>,
    },
}

impl<'a> IncomingMessage<'a> {
    fn parse(line: &'a str) -> Option<Self> {
        let frame: IncomingFrame<'_> = serde_json::from_str(line).ok()?;
        Some(match frame.kind {
            Kind::Request => Self::Request {
                id: frame.id?,
                method: frame.method?,
                args: frame.args?,
            },
            Kind::Response => Self::Response {
                id: frame.id?,
                outcome: if frame.ok? {
                    Ok(frame.value.unwrap_or(RawValue::NULL))
                } else {
                    Err(frame
                        .error
                        .unwrap_or_else(|| "The workspace service rejected the request.".into()))
                },
            },
            Kind::Event => Self::Event {
                event: frame.event?,
                args: frame.args?,
            },
        })
    }
}

pub(super) struct Sidecar {
    outgoing: mpsc::UnboundedSender<Message>,
    replies: Mutex<Replies>,
    next: AtomicU64,
}

impl Sidecar {
    pub(super) fn launch(
        app: &AppHandle,
        runtime: &Path,
        entry: &Path,
    ) -> std::io::Result<Arc<Self>> {
        let mut child = Command::new(runtime)
            .arg(entry)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdin = child.stdin.take().expect("sidecar stdin was piped");
        let stdout = child.stdout.take().expect("sidecar stdout was piped");
        let (outgoing, mut outgoing_messages) = mpsc::unbounded_channel::<Message>();
        let sidecar = Arc::new(Self {
            outgoing,
            replies: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
        });

        let writer = tauri::async_runtime::spawn(async move {
            while let Some(message) = outgoing_messages.recv().await {
                let mut bytes = serde_json::to_vec(&message).expect("wire message is serializable");
                bytes.push(b'\n');
                if stdin.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });

        let app = app.clone();
        let reader = Arc::clone(&sidecar);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match IncomingMessage::parse(&line) {
                    Some(message) => reader.receive(&app, message),
                    None => eprintln!(
                        "Diffpane received an invalid message from the workspace service."
                    ),
                }
            }
            reader.replies.lock().expect("reply registry").clear();
            writer.abort();
            let status =
                match tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()).await {
                    Ok(status) => status,
                    Err(_) => {
                        let _ = child.start_kill();
                        child.wait().await
                    }
                };
            super::sidecar_exited(&app, status);
        });
        Ok(sidecar)
    }

    fn receive(self: &Arc<Self>, app: &AppHandle, message: IncomingMessage<'_>) {
        match message {
            IncomingMessage::Response { id, outcome } => {
                let reply = self.replies.lock().expect("reply registry").remove(&id);
                if let Some(reply) = reply {
                    let _ = reply.send(outcome.map(RawValue::to_owned));
                }
            }
            IncomingMessage::Request { id, method, args } => {
                let app = app.clone();
                let sidecar = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let outcome = super::native_request(&app, &method, args).await;
                    let (value, error) = match outcome {
                        Ok(value) => (Some(value), None),
                        Err(error) => (None, Some(error)),
                    };
                    let _ = sidecar.outgoing.send(Message::Response {
                        id,
                        ok: error.is_none(),
                        value,
                        error,
                    });
                });
            }
            IncomingMessage::Event { event, args } => super::native_event(app, &event, args),
        }
    }

    pub(super) async fn request(&self, method: &str, args: Vec<Value>) -> Outcome {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, response) = oneshot::channel();
        self.replies
            .lock()
            .expect("reply registry")
            .insert(id, reply);
        let pending = Pending { id, sidecar: self };
        self.outgoing
            .send(Message::Request {
                id,
                method: method.into(),
                args,
            })
            .map_err(|_| unavailable())?;
        let outcome = response.await.map_err(|_| unavailable())?;
        drop(pending);
        outcome
    }

    pub(super) fn event(&self, event: &str, args: Vec<Value>) {
        let _ = self.outgoing.send(Message::Event {
            event: event.into(),
            args,
        });
    }
}

struct Pending<'a> {
    id: u64,
    sidecar: &'a Sidecar,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.sidecar
            .replies
            .lock()
            .expect("reply registry")
            .remove(&self.id);
    }
}

fn unavailable() -> String {
    "The workspace service is unavailable.".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(line: &str) -> Result<&RawValue, String> {
        let Some(IncomingMessage::Response { id, outcome }) = IncomingMessage::parse(line) else {
            panic!("expected a response frame");
        };
        assert_eq!(id, 42);
        outcome
    }

    #[test]
    fn response_borrows_json_without_rewriting_it() {
        let payload = r#"{"z":[null, 1e+4, {"text":"line\n\"\ud83d\ude80"}], "a":0}"#;
        let prefix = r#"{"value": "#;
        let line = format!(r#"{prefix}{payload},"id":42,"ok":true,"kind":"response"}}"#);
        let raw = response(&line).unwrap().get();
        assert_eq!(raw, payload);
        assert_eq!(raw.as_ptr(), line[prefix.len()..].as_ptr());
    }

    #[test]
    fn response_preserves_null_and_failure_semantics() {
        let base = r#"{"id":42,"kind":"response","ok":true"#;
        for suffix in ["}", r#","value":null}"#] {
            assert_eq!(response(&format!("{base}{suffix}")).unwrap().get(), "null");
        }
        assert_eq!(
            response(r#"{"kind":"response","id":42,"ok":false,"error":"read failed"}"#)
                .unwrap_err(),
            "read failed"
        );
        assert_eq!(
            response(r#"{"kind":"response","id":42,"ok":false}"#).unwrap_err(),
            "The workspace service rejected the request."
        );
        assert!(IncomingMessage::parse(r#"{"kind":"response","id":42,"value":null}"#).is_none());
        assert!(
            IncomingMessage::parse(r#"{"kind":"response","id":42,"ok":true,"value":[}"#).is_none()
        );
    }
}
