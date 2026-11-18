use serde::{Deserialize, Serialize};
use serde_json::Value;
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

type Outcome = Result<Value, String>;
type Replies = HashMap<u64, oneshot::Sender<Outcome>>;

#[derive(Debug, Deserialize, Serialize)]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Event {
        event: String,
        args: Vec<Value>,
    },
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
                match serde_json::from_str::<Message>(&line) {
                    Ok(message) => reader.receive(&app, message),
                    Err(_) => eprintln!(
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

    fn receive(self: &Arc<Self>, app: &AppHandle, message: Message) {
        match message {
            Message::Response {
                id,
                ok,
                value,
                error,
            } => {
                if let Some(reply) = self.replies.lock().expect("reply registry").remove(&id) {
                    let outcome = if ok {
                        Ok(value.unwrap_or(Value::Null))
                    } else {
                        Err(error.unwrap_or_else(|| {
                            "The workspace service rejected the request.".into()
                        }))
                    };
                    let _ = reply.send(outcome);
                }
            }
            Message::Request { id, method, args } => {
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
            Message::Event { event, args } => super::native_event(app, &event, args),
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
