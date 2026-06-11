//! Cross-language interop: the wire formats (token, auth-proof over JCS, CBOR
//! archive) must match the TS production signer (the `canonicalize` npm package)
//! byte-for-byte. Vectors are generated upstream — by the JCS interop generator in
//! `web/src/lib/jcs-interop-vectors.gen.test.ts` and a matching reference emitter,
//! both under `GEN_VECTORS=1` — and embedded here at compile time.
//!
//! These vectors are an *independent oracle* — only ever regenerate them from
//! those emitters, never from this crate, or the conformance check degrades into a
//! circular self-snapshot (see `tests/vectors/README.md`).

use atmin_server::{authproof, cbor, model::KeyVersion, token};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ciborium::value::Value;
use serde::Deserialize;

#[derive(Deserialize)]
struct Vectors {
    tokens: Vec<TokenVec>,
    auth_proof: AuthProofVec,
    jcs_battery: Vec<JcsCase>,
    cbor_archive: CborArchiveVec,
}

#[derive(Deserialize)]
struct CborArchiveVec {
    blob_hex: String,
    msg_ids: Vec<String>,
    count: usize,
}

#[derive(Deserialize)]
struct TokenVec {
    secret: String,
    user_id: String,
    device_id: String,
    key_version: u32,
    token: String,
}

#[derive(Deserialize)]
struct AuthProofVec {
    public_key_hex: String,
    payload_json: String,
    signature_b64url: String,
    jcs_canonical_hex: String,
}

#[derive(Deserialize)]
struct JcsCase {
    name: String,
    input_json: String,
    canonical_hex: String,
}

fn vectors() -> Vectors {
    let raw = include_str!("vectors/go-vectors.json");
    serde_json::from_str(raw).expect("parse go-vectors.json")
}

/// Canonical bytes from the TS production signer (`canonicalize` npm package).
#[derive(Deserialize)]
struct TsVectors {
    jcs_battery: Vec<TsCase>,
    auth_proof_payload_canonical_hex: String,
}

#[derive(Deserialize)]
struct TsCase {
    name: String,
    canonical_hex: String,
}

fn ts_vectors() -> TsVectors {
    let raw = include_str!("vectors/ts-vectors.json");
    serde_json::from_str(raw).expect("parse ts-vectors.json")
}

/// TS canonical bytes keyed by case name, for cross-referencing the JCS battery.
fn ts_canonical_by_name() -> std::collections::HashMap<String, Vec<u8>> {
    ts_vectors()
        .jcs_battery
        .into_iter()
        .map(|c| (c.name, hex::decode(c.canonical_hex).unwrap()))
        .collect()
}

#[test]
fn token_byte_identity_with_go() {
    for v in vectors().tokens {
        let secret = v.secret.as_bytes();

        // generate() reproduces the vector's token bytes exactly.
        let kv = KeyVersion::new(v.key_version).expect("vector key_version >= 1");
        let got = token::generate(secret, &v.user_id, &v.device_id, kv);
        assert_eq!(got, v.token, "token mismatch for {}", v.user_id);

        // parse() round-trips a vector-supplied token.
        let (uid, did, parsed_kv) = token::parse(secret, &v.token).expect("parse Go token");
        assert_eq!(
            (uid.as_str(), did.as_str(), parsed_kv.get()),
            (v.user_id.as_str(), v.device_id.as_str(), v.key_version)
        );
    }
}

/// Cases where serde_jcs is *known* to diverge from the reference canonicalizers.
/// serde_jcs keeps JSON integers beyond 2^53 exact, whereas RFC 8785 — and the
/// JS/TS `canonicalize` signer (JS numbers are IEEE-754 doubles) — round to the
/// nearest double. The protocol never signs such numbers, so this is a documented
/// constraint, not a blocker. `jcs_known_number_divergence_pinned` pins it.
const KNOWN_DIVERGENCES: &[&str] = &["num_over_2pow53"];

#[test]
fn jcs_battery_matches_go() {
    // Collect *all* divergences rather than fail-fast, so one run shows the full
    // picture. Known divergences are pinned separately and skipped here.
    let mut mismatches = Vec::new();
    for c in vectors().jcs_battery {
        if KNOWN_DIVERGENCES.contains(&c.name.as_str()) {
            continue;
        }
        let got = authproof::canonicalize(c.input_json.as_bytes())
            .unwrap_or_else(|e| panic!("canonicalize {}: {e:?}", c.name));
        let want = hex::decode(&c.canonical_hex).unwrap();
        if got != want {
            mismatches.push(format!(
                "  [{}]\n    input = {}\n    rust  = {}\n    go    = {}",
                c.name,
                c.input_json,
                String::from_utf8_lossy(&got),
                String::from_utf8_lossy(&want),
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "serde_jcs diverged from gowebpki/jcs on {} unexpected case(s):\n{}",
        mismatches.len(),
        mismatches.join("\n"),
    );
}

#[test]
fn jcs_battery_matches_ts() {
    // serde_jcs vs the production signer (`canonicalize`). Known divergences skipped.
    let ts = ts_canonical_by_name();
    let mut mismatches = Vec::new();
    for c in vectors().jcs_battery {
        if KNOWN_DIVERGENCES.contains(&c.name.as_str()) {
            continue;
        }
        let got = authproof::canonicalize(c.input_json.as_bytes())
            .unwrap_or_else(|e| panic!("canonicalize {}: {e:?}", c.name));
        let want = ts
            .get(&c.name)
            .unwrap_or_else(|| panic!("ts vector missing case {}", c.name));
        if &got != want {
            mismatches.push(format!(
                "  [{}]\n    input = {}\n    rust  = {}\n    ts    = {}",
                c.name,
                c.input_json,
                String::from_utf8_lossy(&got),
                String::from_utf8_lossy(want),
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "serde_jcs diverged from the TS production signer on {} case(s):\n{}",
        mismatches.len(),
        mismatches.join("\n"),
    );
}

/// The two reference canonicalizers (the TS production signer and the vector
/// emitter) must agree on every case — a property of the system as a whole.
/// Holds even for the >2^53 case: both round to the nearest IEEE-754 double.
#[test]
fn go_and_ts_agree() {
    let ts = ts_canonical_by_name();
    for c in vectors().jcs_battery {
        let go = hex::decode(&c.canonical_hex).unwrap();
        let want = ts
            .get(&c.name)
            .unwrap_or_else(|| panic!("ts vector missing case {}", c.name));
        assert_eq!(
            &go, want,
            "Go server and TS signer disagree on `{}` — a current-system bug, not a port issue",
            c.name
        );
    }
}

#[test]
fn auth_proof_canonical_matches_ts() {
    let canonical = authproof::canonicalize(vectors().auth_proof.payload_json.as_bytes()).unwrap();
    assert_eq!(
        hex::encode(&canonical),
        ts_vectors().auth_proof_payload_canonical_hex,
        "auth-proof canonical bytes differ from the TS production signer",
    );
}

/// Pins the one known JCS divergence so a future serde_jcs change (e.g. it starts
/// rounding large integers to f64 like RFC 8785) flips this test and prompts a
/// docs update — rather than silently changing signing behaviour. The reference
/// canonicalizers both round; serde_jcs alone keeps the exact integer.
#[test]
fn jcs_known_number_divergence_pinned() {
    let case = vectors()
        .jcs_battery
        .into_iter()
        .find(|c| c.name == "num_over_2pow53")
        .expect("num_over_2pow53 vector present");

    let rust = authproof::canonicalize(case.input_json.as_bytes()).unwrap();
    let go = hex::decode(&case.canonical_hex).unwrap();
    let ts = ts_canonical_by_name();
    let ts_case = ts.get("num_over_2pow53").unwrap();

    assert_eq!(String::from_utf8_lossy(&rust), r#"{"n":10000000000000001}"#);
    assert_eq!(String::from_utf8_lossy(&go), r#"{"n":10000000000000000}"#);
    assert_eq!(go, *ts_case, "Go and TS both round to f64");
    assert_ne!(
        rust, go,
        "if these now match, serde_jcs changed — update the docs"
    );
}

#[test]
fn auth_proof_canonical_matches_and_verifies() {
    let p = vectors().auth_proof;

    // Canonical bytes agree with the vector...
    let canonical = authproof::canonicalize(p.payload_json.as_bytes()).unwrap();
    assert_eq!(
        hex::encode(&canonical),
        p.jcs_canonical_hex,
        "canonical bytes differ from Go"
    );

    // ...and the vector's signature verifies.
    let pubkey = hex::decode(&p.public_key_hex).unwrap();
    let sig = URL_SAFE_NO_PAD.decode(&p.signature_b64url).unwrap();
    authproof::verify(&pubkey, p.payload_json.as_bytes(), &sig).expect("verify Go-signed proof");
}

#[test]
fn auth_proof_rejects_tampered_payload() {
    let p = vectors().auth_proof;
    let pubkey = hex::decode(&p.public_key_hex).unwrap();
    let sig = URL_SAFE_NO_PAD.decode(&p.signature_b64url).unwrap();

    // Same signature, mutated payload → must not verify.
    let tampered = p.payload_json.replace("u-alice", "u-mallory");
    assert_eq!(
        authproof::verify(&pubkey, tampered.as_bytes(), &sig),
        Err(authproof::AuthProofError::VerifyFailed),
    );
}

#[test]
fn cbor_decodes_go_archive() {
    let a = vectors().cbor_archive;
    let blob = hex::decode(&a.blob_hex).unwrap();

    let entries = cbor::decode_archive(&blob).expect("decode Go-marshaled archive");
    assert_eq!(entries.len(), a.count);

    // msg_ids decode in order; the entry without one is skipped (as dedup does).
    let ids: Vec<&str> = entries
        .iter()
        .filter_map(|e| cbor::get_text(e, "msg_id"))
        .collect();
    assert_eq!(ids, a.msg_ids);

    // A text field round-trips...
    assert_eq!(cbor::get_text(&entries[0], "to_user"), Some("u-bob"));

    // ...and JSON numbers are stored as CBOR doubles.
    assert!(
        matches!(cbor::get(&entries[0], "v"), Some(Value::Float(_))),
        "expected `v` to be a CBOR double (compaction: json.Unmarshal -> float64 -> cbor)"
    );
}

#[test]
fn cbor_roundtrip_stable() {
    let blob = hex::decode(&vectors().cbor_archive.blob_hex).unwrap();
    let entries = cbor::decode_archive(&blob).unwrap();

    let reencoded = cbor::encode_archive(&entries).unwrap();
    let again = cbor::decode_archive(&reencoded).unwrap();

    // Semantic stability. Byte-identity is *not* asserted: archives aren't
    // canonically encoded (map key order isn't fixed), so re-encoded bytes may differ.
    assert_eq!(entries, again);
}
