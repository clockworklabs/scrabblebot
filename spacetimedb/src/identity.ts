import { blake3 } from "@noble/hashes/blake3.js";
import { Identity } from "spacetimedb";

const encoder = new TextEncoder();

// The identity a client with these `iss` and `sub` claims connects as. A
// port of Rust's `Identity::from_claims`, which the TypeScript module
// library doesn't provide. Sim bots act through such identities.
export function identityFromClaims(issuer: string, subject: string): Identity {
  const idHash = blake3(encoder.encode(`${issuer}|${subject}`)).slice(0, 26);
  const checksumInput = new Uint8Array(28);
  checksumInput[0] = 0xc2;
  checksumInput[1] = 0x00;
  checksumInput.set(idHash, 2);
  const checksum = blake3(checksumInput);

  // Big-endian, so the identity's hex starts with `c200`.
  const bytes = new Uint8Array(32);
  bytes[0] = 0xc2;
  bytes[1] = 0x00;
  bytes.set(checksum.slice(0, 4), 2);
  bytes.set(idHash, 6);
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b);
  }
  return new Identity(n);
}
