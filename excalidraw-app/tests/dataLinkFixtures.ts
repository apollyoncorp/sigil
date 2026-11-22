export const rect = (id: string, x = 0) => ({
  id,
  type: "rectangle",
  x,
  y: 0,
  width: 180,
  height: 80,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "#a5d8ff",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});

export const sceneJson = (...ids: string[]) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://sigil.apollyoncorp.com",
    elements: ids.map((id, i) => rect(id, i * 300)),
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });

// like loading a URL: unlike `location.hash = ...`, no hashchange event fires
export const openWithHash = (hash: string) =>
  window.history.replaceState({}, "", `/${hash}`);
