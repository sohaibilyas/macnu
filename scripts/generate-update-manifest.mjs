#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const TARGET = "macos-universal-official-stable";
const REPOSITORY = "sohaibilyas/macnu";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  console.error("Manifest generation failed: " + message);
  process.exit(1);
}

const [version, signaturePath, outputPath] = process.argv.slice(2);
if (!version || !signaturePath || !outputPath) {
  fail("usage: generate-update-manifest.mjs <version> <signature-file> <output-file>");
}
if (!STABLE_SEMVER.test(version)) {
  fail("the version must be a strict stable X.Y.Z value.");
}

const signature = fs.readFileSync(signaturePath, "utf8").trim();
if (
  signature.length === 0 ||
  signature.length > 16 * 1024 ||
  signature.length % 4 !== 0 ||
  !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)
) {
  fail("the updater signature is not canonical base64.");
}
const decodedBytes = Buffer.from(signature, "base64");
const decodedSignature = decodedBytes.toString("utf8");
if (!Buffer.from(decodedSignature, "utf8").equals(decodedBytes)) {
  fail("the updater signature box is not valid UTF-8.");
}
const signatureBox = decodedSignature.endsWith("\n")
  ? decodedSignature.slice(0, -1)
  : decodedSignature;
const signatureLines = signatureBox.split("\n");
const isCanonicalLine = (value, decodedLength) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === decodedLength && decoded.toString("base64") === value;
};
if (
  signatureLines.length !== 4 ||
  !/^untrusted comment: [ -~]{1,200}$/.test(signatureLines[0]) ||
  !isCanonicalLine(signatureLines[1], 74) ||
  !/^trusted comment: timestamp:(0|[1-9]\d*)\tfile:[ -~]{1,255}$/.test(
    signatureLines[2],
  ) ||
  !isCanonicalLine(signatureLines[3], 64)
) {
  fail("the updater signature is not a valid Minisign signature box.");
}

const sourceDate = process.env.SOURCE_DATE_EPOCH;
const timestamp = sourceDate
  ? new Date(Number.parseInt(sourceDate, 10) * 1000)
  : new Date();
if (Number.isNaN(timestamp.getTime())) {
  fail("SOURCE_DATE_EPOCH is invalid.");
}

const manifest = {
  version,
  pub_date: timestamp.toISOString(),
  platforms: {
    [TARGET]: {
      url:
        "https://github.com/" +
        REPOSITORY +
        "/releases/download/v" +
        version +
        "/Macnu.app.tar.gz",
      signature,
    },
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", {
  mode: 0o644,
});
console.log("Generated updater manifest for v" + version + ".");
