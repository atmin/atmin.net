//! CBOR archive: an array of envelope objects written by the compaction path,
//! decoded/encoded here with `ciborium`.
//!
//! Two properties of the archive format a reader must respect:
//!   - JSON numbers arrive as CBOR **doubles** — compaction round-trips each
//!     envelope through an untyped JSON decode (numbers become floats) before
//!     CBOR-encoding. So a field like `"v":1` decodes to `Value::Float(1.0)`,
//!     not an integer.
//!   - Map key order is **not canonical**. Decoding must be order-tolerant;
//!     byte-identical re-encoding is not a goal.
//!
//! Every archive map is text-keyed and decoded directly.

use ciborium::value::Value;

#[derive(Debug, PartialEq, Eq)]
pub enum CborError {
    Decode,
    Encode,
}

/// Decode a CBOR archive (a top-level array) into its entries.
pub fn decode_archive(bytes: &[u8]) -> Result<Vec<Value>, CborError> {
    ciborium::de::from_reader(bytes).map_err(|_| CborError::Decode)
}

/// Re-encode archive entries to CBOR.
pub fn encode_archive(entries: &[Value]) -> Result<Vec<u8>, CborError> {
    let mut buf = Vec::new();
    ciborium::ser::into_writer(&entries, &mut buf).map_err(|_| CborError::Encode)?;
    Ok(buf)
}

/// Look up a key in a CBOR map entry, returning the raw value.
pub fn get<'a>(entry: &'a Value, key: &str) -> Option<&'a Value> {
    let Value::Map(pairs) = entry else {
        return None;
    };
    pairs.iter().find_map(|(k, v)| match k {
        Value::Text(t) if t.as_str() == key => Some(v),
        _ => None,
    })
}

/// Convenience: look up a text-valued field.
pub fn get_text<'a>(entry: &'a Value, key: &str) -> Option<&'a str> {
    match get(entry, key) {
        Some(Value::Text(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// Deduplicate archive entries by `msg_id`, keeping the first occurrence; entries
/// without a `msg_id` (e.g. key backups) are always kept. Order is preserved.
pub fn deduplicate_by_msg_id(objects: Vec<Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::with_capacity(objects.len());
    for obj in objects {
        if let Some(id) = get_text(&obj, "msg_id") {
            if seen.contains(id) {
                continue;
            }
            seen.insert(id.to_string());
        }
        result.push(obj);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(msg_id: Option<&str>) -> Value {
        let mut pairs = vec![(Value::Text("v".into()), Value::Integer(1.into()))];
        if let Some(id) = msg_id {
            pairs.push((Value::Text("msg_id".into()), Value::Text(id.into())));
        }
        Value::Map(pairs)
    }

    #[test]
    fn dedup_keeps_first_by_msg_id_and_all_without() {
        let input = vec![
            obj(Some("a")),
            obj(Some("b")),
            obj(Some("a")), // duplicate of the first → dropped
            obj(None),      // no msg_id → kept
            obj(None),      // no msg_id → kept
        ];
        let out = deduplicate_by_msg_id(input);
        assert_eq!(out.len(), 4);
        assert_eq!(get_text(&out[0], "msg_id"), Some("a"));
        assert_eq!(get_text(&out[1], "msg_id"), Some("b"));
        assert_eq!(get_text(&out[2], "msg_id"), None);
        assert_eq!(get_text(&out[3], "msg_id"), None);
    }
}
