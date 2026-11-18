use super::*;
use serde_json::json;

fn utf16(value: &str) -> Vec<u8> {
    [0].into_iter()
        .chain(value.encode_utf16().flat_map(u16::to_le_bytes))
        .collect()
}

#[test]
fn selects_only_the_known_file_origin_preferences_without_changing_the_database() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("Local Storage").join("leveldb");
    fs::create_dir_all(&source).unwrap();

    let mut db = DB::open(&source, Options::default()).unwrap();
    db.put(b"VERSION", b"1").unwrap();
    db.put(KEYS[0].1, &utf16(r#"{"font":"Ménlo 字"}"#)).unwrap();
    db.put(KEYS[1].1, b"\x01{\"panel\":123}").unwrap();
    db.put(KEYS[2].1, b"\x01true").unwrap();
    db.put(
        b"_https://other.example\0\x01diffpane.appearance",
        b"\x01false",
    )
    .unwrap();
    db.put(b"_file://\0\x01other-data", b"\x01false").unwrap();
    db.flush().unwrap();

    let snapshot = |source: &Path| -> Map<String, Value> {
        fs::read_dir(source)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name().into_string().unwrap(),
                    json!(fs::read(entry.path()).unwrap()),
                )
            })
            .collect()
    };
    let before = snapshot(&source);
    assert_eq!(
        Value::Object(read_values(&source).unwrap()),
        json!({
            "appearance": { "font": "Ménlo 字" },
            "layout": { "panel": 123 },
            "ideasVisible": true,
        })
    );
    assert_eq!(snapshot(&source), before);
}

#[test]
fn rejects_invalid_or_oversized_records() {
    assert_eq!(decode_value(b"\x01caf\xe9"), Some("café".into()));
    assert_eq!(decode_value(b"\x00a"), None);
    assert_eq!(decode_value(b"\x02value"), None);
    assert_eq!(decode_value(&vec![1; MAX_VALUE_BYTES + 1]), None);
}
