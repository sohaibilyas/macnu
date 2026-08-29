#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI4N0VDRjcwMjM1MDRGQkUKUldTK1QxQWpjTTkrS0h3THZ6L2UzWkZuVGwvVVZNOGJWMVgxbjFiOEJiZ09MTHFSRGlaK21uazAK";
const EXPECTED_ENDPOINT =
  "https://github.com/sohaibilyas/macnu/releases/latest/download/latest.json";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error("Release preflight failed: " + message);
  process.exit(1);
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
  } catch {
    fail(relativePath + " is missing or invalid JSON.");
  }
}

function packageVersionFromCargo() {
  const cargo = fs.readFileSync(
    path.join(projectRoot, "src-tauri/Cargo.toml"),
    "utf8",
  );
  const packageSection = cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/);
  const version = packageSection?.[1].match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) {
    fail("src-tauri/Cargo.toml has no package version.");
  }
  return version;
}

function packageVersionFromCargoLock() {
  const cargoLock = fs.readFileSync(
    path.join(projectRoot, "src-tauri/Cargo.lock"),
    "utf8",
  );
  const packageBlock = cargoLock
    .split(/\n\[\[package\]\]\n/)
    .find((block) => /^name\s*=\s*"macnu"\s*$/m.test(block));
  const version = packageBlock?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) {
    fail("src-tauri/Cargo.lock has no macnu package version.");
  }
  return version;
}

const options = {
  printVersion: false,
  requireClean: false,
  tag: process.env.MACNU_RELEASE_TAG || null,
};

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--print-version") {
    options.printVersion = true;
  } else if (argument === "--require-clean") {
    options.requireClean = true;
  } else if (argument === "--tag") {
    options.tag = process.argv[index + 1] || fail("--tag requires a value.");
    index += 1;
  } else {
    fail("unknown argument " + argument + ".");
  }
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const officialConfig = readJson("src-tauri/tauri.official.conf.json");
const cargoManifest = fs.readFileSync(
  path.join(projectRoot, "src-tauri/Cargo.toml"),
  "utf8",
);
const vendoredUpdaterManifest = fs.readFileSync(
  path.join(projectRoot, "vendor/tauri-plugin-updater/Cargo.toml"),
  "utf8",
);
const vendoredUpdaterLibrary = fs.readFileSync(
  path.join(projectRoot, "vendor/tauri-plugin-updater/src/lib.rs"),
  "utf8",
);
const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["src-tauri/Cargo.toml", packageVersionFromCargo()],
  ["src-tauri/Cargo.lock macnu package", packageVersionFromCargoLock()],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
]);

const version = packageJson.version;
if (!STABLE_SEMVER.test(version)) {
  fail(version + " is not a strict stable X.Y.Z version.");
}
for (const [location, candidate] of versions) {
  if (candidate !== version) {
    fail(location + " is " + String(candidate) + "; expected " + version + ".");
  }
}

const expectedTag = "v" + version;
if (options.tag !== null && options.tag !== expectedTag) {
  fail("tag " + options.tag + " does not match " + expectedTag + ".");
}

const bundleIcons = tauriConfig.bundle?.icon;
if (
  !Array.isArray(bundleIcons) ||
  bundleIcons.length !== 1 ||
  bundleIcons[0] !== "icons/icon.icns"
) {
  fail("the macOS bundle must include exactly icons/icon.icns.");
}

const expectedUpdaterDependency =
  'tauri-plugin-updater = { path = "../vendor/tauri-plugin-updater", optional = true }';
if (!cargoManifest.split(/\r?\n/).includes(expectedUpdaterDependency)) {
  fail("the official app must use Macnu's bounded vendored updater dependency.");
}
const vendoredUpdaterPackage = vendoredUpdaterManifest.match(
  /\[package\]([\s\S]*?)(?=\n\[|$)/,
);
const vendoredUpdaterVersion = vendoredUpdaterPackage?.[1].match(
  /^version\s*=\s*"([^"]+)"\s*$/m,
)?.[1];
if (vendoredUpdaterVersion !== "2.10.1") {
  fail("the reviewed vendored updater must remain at version 2.10.1.");
}
if (
  vendoredUpdaterLibrary.includes("commands::download_and_install") ||
  vendoredUpdaterLibrary.includes("mod commands;")
) {
  fail("the vendored updater must not expose raw updater IPC commands.");
}

const capabilitiesRoot = path.join(projectRoot, "src-tauri/capabilities");
const capabilityEntries = fs.readdirSync(capabilitiesRoot, {
  withFileTypes: true,
});
if (
  capabilityEntries.length !== 1 ||
  !capabilityEntries[0].isFile() ||
  capabilityEntries[0].name !== "default.json"
) {
  fail("the reviewed capability set must contain only default.json.");
}
const defaultCapability = readJson("src-tauri/capabilities/default.json");
if (
  !defaultCapability ||
  Array.isArray(defaultCapability) ||
  typeof defaultCapability !== "object" ||
  defaultCapability.identifier !== "default" ||
  !Array.isArray(defaultCapability.permissions)
) {
  fail("default.json must remain one reviewed capability object.");
}
for (const permission of defaultCapability.permissions) {
  const identifier =
    typeof permission === "string" ? permission : permission?.identifier;
  if (typeof identifier === "string" && identifier.startsWith("updater:")) {
    fail("default.json must not grant raw updater IPC permissions.");
  }
}

const signerPackages = [
  [
    "node_modules/@tauri-apps/cli",
    "sha512-R8xGtMpwyetawSqm9kYOuMmEqkhUbvcUy8n0aNXIxollKBLESUu5f4Fx+64hgASYm1H+jSWq6jCW6zqTnH6hqQ==",
  ],
  [
    "node_modules/@tauri-apps/cli-linux-x64-gnu",
    "sha512-2VRNWl84FOH0m2giiDkO2h0QXlcMJeX+zJDpI5kDIQAx6s+geF3v48F4DXfJez4GS/FdoDGnPnw1C2iYGbQ7bQ==",
  ],
];
for (const [packagePath, integrity] of signerPackages) {
  const locked = packageLock.packages?.[packagePath];
  if (locked?.version !== "2.11.4" || locked?.integrity !== integrity) {
    fail("the isolated Tauri signer package lock changed unexpectedly.");
  }
}

if (officialConfig.build?.beforeBuildCommand !== "") {
  fail("the official config must disable Tauri's nested frontend build.");
}
if (officialConfig.bundle?.createUpdaterArtifacts !== false) {
  fail("the official build must leave updater signing to the isolated post-build step.");
}
if (officialConfig.plugins?.updater?.pubkey !== EXPECTED_PUBLIC_KEY) {
  fail("the updater public key changed unexpectedly.");
}
const endpoints = officialConfig.plugins?.updater?.endpoints;
if (
  !Array.isArray(endpoints) ||
  endpoints.length !== 1 ||
  endpoints[0] !== EXPECTED_ENDPOINT
) {
  fail("the updater endpoint changed unexpectedly.");
}

if (options.requireClean) {
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();
  if (dirty) {
    fail("the Git worktree is not clean.");
  }
}

if (options.printVersion) {
  process.stdout.write(version);
} else {
  console.log("Release preflight passed for " + expectedTag + ".");
}
