//! CBOR archive: an array of envelope objects, as written by the Go compaction
//! path (`fxamacker/cbor`). Decoded/encoded here with `ciborium`.
//!
//! Two properties the Go side pins (see server/interop_vectors_test.go) that a
//! reader must respect:
//!   - JSON numbers arrive as CBOR **doubles** — compaction does
//!     `json.Unmarshal` into `any` (→ float64) before `cbor.Marshal`. So a field
//!     like `"v":1` decodes to `Value::Float(1.0)`, not an integer.
//!   - Map key order is **not canonical** (Go map iteration). Decoding must be
//!     order-tolerant; byte-identical re-encoding is not a goal.
//!
//! The Go `map[any]any`-vs-`map[string]any` duality is a Go-internal artifact —
//! here every archive map is just text-keyed, decoded directly.

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
