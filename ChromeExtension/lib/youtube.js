import { canonicalizePublicURL } from "./validation.js";

const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function youtubeVideoIdentity(input) {
  let canonical;
  try { canonical = canonicalizePublicURL(input); } catch { return null; }
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(canonical);
  if (!match) return null;
  const host = match[1].replace(/:443$/, "").toLowerCase();
  const path = match[2] || "/";
  let videoID = null;
  if (host === "youtu.be") videoID = path.split("/").filter(Boolean)[0] || null;
  else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (path === "/watch") {
      for (const pair of (match[3] || "").split("&")) {
        const [key, rawValue = ""] = pair.split("=", 2);
        if (key !== "v") continue;
        try { videoID = decodeURIComponent(rawValue); } catch { videoID = null; }
        break;
      }
    } else {
      const parts = path.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) videoID = parts[1] || null;
    }
  }
  if (!VIDEO_ID.test(videoID || "")) return null;
  return Object.freeze({ videoID, videoKey: `youtube:${videoID}`, canonicalURL: `https://www.youtube.com/watch?v=${encodeURIComponent(videoID)}` });
}

export function isUnidentifiedYouTubeURL(input) {
  let canonical;
  try { canonical = canonicalizePublicURL(input); } catch { return false; }
  if (youtubeVideoIdentity(canonical)) return false;
  const host = /^https:\/\/([^/?#]+)/.exec(canonical)?.[1]?.replace(/:443$/, "").toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host?.endsWith(".youtube.com");
}
