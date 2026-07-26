# Edge report signing v1

Every Edge report is signed with Ed25519 as defined by RFC 8032. Protocol v1
uses plain Ed25519: it does not use Ed25519ph, Ed25519ctx, or an application
level prehash.

## Signing bytes

The signing payload is the following byte concatenation:

```text
UTF8("workbuddy-buddy/edge-report/v1\0")
||
UTF8(canonical_json(envelope_without_signature))
```

The trailing NUL (`00` hex) is part of the domain separator. The complete
31-byte separator is:

```text
776f726b62756464792d62756464792f656467652d7265706f72742f763100
```

To produce `envelope_without_signature`, remove only the top-level
`signature` member. Canonical JSON is UTF-8 JSON with no byte-order mark or
whitespace; object member names are sorted lexicographically (all protocol v1
member names are ASCII); array order is preserved; strings use JSON escaping;
and protocol integers use their shortest decimal representation. The signed
payload therefore never contains the Base64 signature itself.

`canonicalPayload` used for receipt replay and audit remains the canonical form
of the complete envelope, including `signature`. It is not the signing payload.

## Key and signature encoding

- Enrollment stores an RFC 8032 Ed25519 public key as exactly 32 raw bytes.
- `signature` is the 64-byte Ed25519 signature encoded as canonical standard
  Base64: exactly 88 characters, including the required `==` padding.
- URL-safe Base64, omitted padding, ignored whitespace, and non-canonical
  encodings are invalid.

The frozen fixture
`fixtures/edge-report-signature.v1.golden.json` uses the public key and private
seed from RFC 8032 test vector 1, but signs this protocol's non-empty payload.
The seed is public test material and must never be used by a real device.
