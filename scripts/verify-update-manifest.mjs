#!/usr/bin/env node
import fs from "node:fs";

const TARGET = "macos-universal-official-stable";
const REPOSITORY = "sohaibilyas/macnu";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  console.error("Manifest verification failed: " + message);
  process.exit(1);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(label + " has unexpected fields.");
  }
}

const [version, signaturePath, manifestPath] = process.argv.slice(2);
if (!version || !signaturePath || !manifestPath) {
  fail("usage: verify-update-manifest.mjs <version> <signature-file> <manifest-file>");
}
if (!STABLE_SEMVER.test(version)) {
  fail("the version must be a strict stable X.Y.Z value.");
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch {
  fail("latest.json is missing or invalid JSON.");
}
const signature = fs.readFileSync(signaturePath, "utf8").trim();

if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  fail("latest.json must be an object.");
}
exactKeys(manifest, ["version", "pub_date", "platforms"], "latest.json");
if (manifest.version !== version) {
  fail("latest.json has the wrong version.");
}
if (
  typeof manifest.pub_date !== "string" ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.pub_date) ||
  Number.isNaN(Date.parse(manifest.pub_date))
) {
  fail("latest.json has an invalid publication date.");
}
if (!manifest.platforms || typeof manifest.platforms !== "object") {
  fail("latest.json has no platforms object.");
}
exactKeys(manifest.platforms, [TARGET], "latest.json platforms");

const platform = manifest.platforms[TARGET];
if (!platform || typeof platform !== "object" || Array.isArray(platform)) {
  fail("latest.json has an invalid Macnu platform.");
}
exactKeys(platform, ["url", "signature"], "latest.json platform");
const expectedUrl =
  "https://github.com/" +
  REPOSITORY +
  "/releases/download/v" +
  version +
  "/Macnu.app.tar.gz";
if (platform.url !== expectedUrl) {
  fail("latest.json has an unexpected updater URL.");
}
if (platform.signature !== signature) {
  fail("latest.json does not contain the exact updater signature.");
}

console.log("Verified updater manifest for v" + version + ".");
