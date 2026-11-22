import { validateLibraryUrl } from "@excalidraw/excalidraw/data/library";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

// Shape libraries shipped with Sigil. The files are generated from
// sigil-mcp/src/shapes (node sigil-mcp/scripts/build-libraries.mjs) and served
// from the same origin, so adding one never leaves the site.
export const SHAPE_LIBRARIES = {
  bpmn: "/libraries/sigil-bpmn.excalidrawlib",
  flowchart: "/libraries/sigil-flowchart.excalidrawlib",
} as const;

const LIBRARIES_PATH = "/libraries/";

/**
 * Which URLs a `#addLibrary=` link may install from: files of our own
 * /libraries/ folder, plus what the editor already allowed (the public
 * catalog behind "Browse libraries").
 */
export const isAllowedLibraryUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.origin === window.location.origin) {
      return parsed.pathname.startsWith(LIBRARIES_PATH);
    }
    return validateLibraryUrl(url);
  } catch {
    return false;
  }
};

/** Merges a shipped library into the user's library and opens the panel. */
export const addShapeLibrary = async (
  api: ExcalidrawImperativeAPI,
  name: keyof typeof SHAPE_LIBRARIES,
) => {
  try {
    await api.updateLibrary({
      libraryItems: fetch(SHAPE_LIBRARIES[name]).then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.blob();
      }),
      merge: true,
      openLibraryMenu: true,
      defaultStatus: "published",
    });
  } catch (error: any) {
    api.updateScene({ appState: { errorMessage: error.message } });
  }
};
