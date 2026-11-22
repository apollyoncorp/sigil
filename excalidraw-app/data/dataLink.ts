import { deflate, inflate } from "pako";

// Scene-in-the-link: `<origin>/#data=<base64url(deflate(json))>`, where json is
// the text of a .excalidraw file and deflate is zlib (what the fork's own
// `encode()` in packages/excalidraw/data/encode.ts uses). Used by sigil-mcp to
// hand a diagram to the editor without a server. Nothing is fetched when it is
// opened.
//
// Deliberately imports only pako (not data/encode.ts, which pulls in the whole
// editor through encryption -> blob) so the very same encoder also runs inside
// sigil-mcp (Node). Only atob/btoa are needed besides it.

export const DATA_HASH_PREFIX = "#data=";

/** Matches a location hash that carries a scene: capture 1 is the payload. */
export const DATA_HASH_REGEX = /^#data=([a-zA-Z0-9_-]+)$/;

/** Longest link (in characters) sigil-mcp hands out; browsers cope with more. */
export const MAX_DATA_LINK_LENGTH = 200_000;

const CHUNK = 0x8000;

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const base64UrlToBytes = (data: string) => {
  const padded = data
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(data.length + ((4 - (data.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const encodeSceneData = (json: string): string =>
  bytesToBase64Url(deflate(new TextEncoder().encode(json)));

/** Throws on anything that is not valid base64url of zlib-deflated text. */
export const decodeSceneData = (data: string): string =>
  inflate(base64UrlToBytes(data), { to: "string" });

export const buildDataLink = (baseUrl: string, json: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/${DATA_HASH_PREFIX}${encodeSceneData(json)}`;
