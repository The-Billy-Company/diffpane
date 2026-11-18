use base64::{Engine, engine::general_purpose::STANDARD};
#[cfg(target_os = "macos")]
use security_framework::os::macos::{keychain::SecKeychain, passwords::find_generic_password};
use serde_json::{Value, json};

pub(in crate::host) async fn request(method: &str, args: Vec<Value>) -> Result<Value, String> {
    let create = method == "keychain.create";
    let mut args = args.into_iter();
    let service = args
        .next()
        .and_then(string)
        .ok_or("Invalid Keychain service.")?;
    let account = args
        .next()
        .and_then(string)
        .ok_or("Invalid Keychain account.")?;
    let current = service == "com.diffpane.app.secure-storage"
        && matches!(account.as_str(), "Local state" | "Claude credentials");
    let legacy = service == "Diffpane Safe Storage" && account == "Diffpane Key";
    if !current && (create || !legacy) {
        return Err("Unknown Diffpane Keychain item.".into());
    }
    let password = if create {
        let encoded = args
            .next()
            .and_then(string)
            .ok_or("Invalid Keychain value.")?;
        Some(
            STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid Keychain value.")?,
        )
    } else {
        None
    };
    #[cfg(debug_assertions)]
    if let Some(result) = isolated_keychain(&service, &account, password.as_deref()) {
        return result;
    }
    tauri::async_runtime::spawn_blocking(move || access(&service, &account, password))
        .await
        .map_err(|error| error.to_string())?
}

fn string(value: Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn access(service: &str, account: &str, password: Option<Vec<u8>>) -> Result<Value, String> {
    const NOT_FOUND: i32 = -25300;
    const DUPLICATE: i32 = -25299;

    if let Some(password) = password {
        let keychain = SecKeychain::default().map_err(|error| error.to_string())?;
        match keychain.add_generic_password(service, account, &password) {
            Ok(()) => return Ok(json!(STANDARD.encode(password))),
            Err(error) if error.code() == DUPLICATE => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    match find_generic_password(None, service, account) {
        Ok((password, _)) => Ok(json!(STANDARD.encode(password.as_ref()))),
        Err(error) if error.code() == NOT_FOUND => Ok(Value::Null),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn access(_service: &str, _account: &str, _password: Option<Vec<u8>>) -> Result<Value, String> {
    Err("This system has no supported Diffpane credential store.".into())
}

#[cfg(debug_assertions)]
fn isolated_keychain(
    service: &str,
    account: &str,
    value: Option<&[u8]>,
) -> Option<Result<Value, String>> {
    use std::{
        collections::HashMap,
        env,
        sync::{Mutex, OnceLock},
    };

    if env::var("DIFFPANE_TEST_KEYCHAIN").as_deref() != Ok("1") {
        return None;
    }
    let profile =
        env::var_os("DIFFPANE_PROFILE_DIR").and_then(|path| std::fs::canonicalize(path).ok());
    let temporary = env::temp_dir().canonicalize().ok();
    if !profile
        .as_ref()
        .zip(temporary.as_ref())
        .is_some_and(|(profile, temporary)| profile != temporary && profile.starts_with(temporary))
    {
        return Some(Err(
            "The test Keychain requires an isolated temporary profile.".into(),
        ));
    }

    type Key = (String, String);
    static KEYS: OnceLock<Mutex<HashMap<Key, Vec<u8>>>> = OnceLock::new();
    let mut keys = KEYS
        .get_or_init(Mutex::default)
        .lock()
        .expect("test Keychain");
    let key = (service.into(), account.into());
    let stored = match value {
        Some(value) => Some(keys.entry(key).or_insert_with(|| value.to_vec()).as_slice()),
        None => keys.get(&key).map(Vec::as_slice),
    };
    Some(Ok(json!(stored.map(|value| STANDARD.encode(value)))))
}
