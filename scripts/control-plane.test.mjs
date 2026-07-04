import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPlaneBase } from "./control-plane.mjs";

test("default hosted URL maps to the bare origin", () => {
  assert.equal(
    controlPlaneBase("https://api.orcarouter.ai/v1/chat/completions"),
    "https://api.orcarouter.ai",
  );
});

test("sub-path deployments keep their prefix", () => {
  assert.equal(
    controlPlaneBase("https://host.example/orca/v1/chat/completions"),
    "https://host.example/orca",
  );
  assert.equal(
    controlPlaneBase("https://host.example/a/b/v1/responses"),
    "https://host.example/a/b",
  );
});

test("bare /v1 with no trailing path is stripped", () => {
  assert.equal(controlPlaneBase("https://host.example/orca/v1"), "https://host.example/orca");
  assert.equal(controlPlaneBase("https://host.example/v1"), "https://host.example");
});

test("URLs without /v1 keep their full path, sans trailing slash", () => {
  assert.equal(controlPlaneBase("https://host.example/gateway/"), "https://host.example/gateway");
  assert.equal(controlPlaneBase("https://host.example"), "https://host.example");
});

test("a /v1 mid-path is not stripped, only the trailing relay segment", () => {
  assert.equal(
    controlPlaneBase("https://host.example/v1x/chat/completions"),
    "https://host.example/v1x/chat/completions",
  );
});

test("ports and http scheme survive", () => {
  assert.equal(
    controlPlaneBase("http://127.0.0.1:3000/v1/chat/completions"),
    "http://127.0.0.1:3000",
  );
});

test("garbage throws (callers fail open)", () => {
  assert.throws(() => controlPlaneBase("not a url"));
});
