import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../BrowserExtension");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest V3 is required");
if (manifest.incognito !== "not_allowed") throw new Error("Private browsing must be disabled");
if (!manifest.host_permissions.includes("https://*/*")) throw new Error("HTTPS website access is required");
if (manifest.content_scripts?.[0]?.all_frames !== true) throw new Error("Embedded video frames must be covered");
if (manifest.host_permissions.some((value) => value.includes("<all_urls>") || value.includes("http://"))) {
  throw new Error("Host permissions are too broad");
}

for (const file of ["content.js", "background.js", "popup.js"]) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, file)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr}`);
  const source = await readFile(resolve(root, file), "utf8");
  for (const banned of ["fetch(", "XMLHttpRequest", "innerText", "textContent"]) {
    if (file !== "popup.js" && source.includes(banned)) throw new Error(`${file} contains banned page/network API: ${banned}`);
  }
}
const content = await readFile(resolve(root, "content.js"), "utf8");
const background = await readFile(resolve(root, "background.js"), "utf8");
if (!content.includes("IntersectionObserver") || !content.includes("trackingEnabled")) {
  throw new Error("Content tracking must be consent- and frame-visibility-gated");
}
if (!background.includes("connectNative") || background.includes("lastPlaybackEvent")) {
  throw new Error("Background must use a persistent native port without extension playback persistence");
}
if (!background.includes("sender.tab") || !background.includes("pageSite")) {
  throw new Error("Embedded-frame events must carry the top-level page site");
}
console.log("Extension manifest, syntax, privacy allow-list: PASS");
