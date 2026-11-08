import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { canonicalJson, digestOf, sha256Hex } from "./canonical.ts";

describe("sha256Hex", () => {
  test("matches FIPS 180-4 test vectors", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    assert.equal(sha256Hex("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  test("agrees with node:crypto across padding boundaries and multi-byte UTF-8", () => {
    const pieces = ["a", "é", "火", "🚒", "z"];
    for (let length = 0; length < 140; length++) {
      const text = Array.from({ length }, (_, i) => pieces[(i * 7 + length) % pieces.length]).join("");
      assert.equal(sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), `length ${length}`);
    }
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 31) & 0xff);
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("canonicalJson", () => {
  test("is independent of key insertion order at every depth", () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: "s" } };
    const b = { a: { c: "s", d: [1, { x: 1, y: 2 }] }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(canonicalJson(a), '{"a":{"c":"s","d":[1,{"x":1,"y":2}]},"b":1}');
  });

  test("omits undefined members and normalizes negative zero", () => {
    assert.equal(canonicalJson({ a: undefined, b: -0 }), '{"b":0}');
  });

  test("rejects values that would not round-trip through JSON", () => {
    for (const bad of [NaN, Infinity, [undefined], () => 1, BigInt(1), new Date(0), new Map(), { nested: { x: Number.NEGATIVE_INFINITY } }]) {
      assert.throws(() => canonicalJson(bad), TypeError);
    }
  });

  test("digest changes when any nested field changes", () => {
    const base = { action: { kind: "spray", flowLps: 0.2, standoff: { x: 1, y: 2, z: 3 } }, cited: ["obs-1"] };
    const digest = digestOf(base);
    assert.notEqual(digestOf({ ...base, action: { ...base.action, flowLps: 0.21 } }), digest);
    assert.notEqual(digestOf({ ...base, action: { ...base.action, standoff: { x: 1, y: 2, z: 3.0001 } } }), digest);
    assert.notEqual(digestOf({ ...base, cited: ["obs-1", "obs-2"] }), digest);
    assert.equal(digestOf(JSON.parse(JSON.stringify(base))), digest);
  });
});
