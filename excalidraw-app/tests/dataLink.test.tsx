import { render, waitFor } from "@excalidraw/excalidraw/tests/test-utils";
import { vi } from "vitest";

import ExcalidrawApp from "../App";
import {
  buildDataLink,
  decodeSceneData,
  encodeSceneData,
} from "../data/dataLink";

import { openWithHash, sceneJson } from "./dataLinkFixtures";

vi.mock("../../excalidraw-app/data/firebase.ts", () => ({
  loadFromFirebase: async () => null,
  saveToFirebase: () => {},
  isSavedToFirebase: () => true,
  loadFilesFromFirebase: async () => ({ loadedFiles: [], erroredFiles: [] }),
  saveFilesToFirebase: async () => ({
    savedFiles: new Map(),
    erroredFiles: new Map(),
  }),
}));

const { h } = window;

describe("data link encoding", () => {
  it("round-trips json, including non-ASCII text", () => {
    const json = `${sceneJson("a")}ção → ✓`;
    const data = encodeSceneData(json);
    expect(data).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(decodeSceneData(data)).toBe(json);
  });

  it("compresses", () => {
    const json = sceneJson(...Array.from({ length: 40 }, (_, i) => `r${i}`));
    expect(encodeSceneData(json).length).toBeLessThan(json.length / 4);
  });

  it("builds a link on the given base, once the slash is trimmed", () => {
    const link = buildDataLink("https://sigil.example.org/", "{}");
    expect(link.startsWith("https://sigil.example.org/#data=")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(() => decodeSceneData("not-a-valid-payload")).toThrow();
    expect(() => decodeSceneData("AAAA_not_a_scene")).toThrow();
  });
});

describe("opening #data= in the app", () => {
  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("restores the scene and clears the hash", async () => {
    openWithHash(`#data=${encodeSceneData(sceneJson("a", "b"))}`);
    const replaceState = vi.spyOn(window.history, "replaceState");

    await render(<ExcalidrawApp />);

    await waitFor(() => {
      expect(h.elements.map((e) => e.id)).toEqual(["a", "b"]);
    });
    expect(replaceState).toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    replaceState.mockRestore();
  });

  it("shows the existing error message for invalid data", async () => {
    openWithHash("#data=AAAA_not_a_scene");

    await render(<ExcalidrawApp />);

    await waitFor(() => {
      expect(h.state.errorMessage).toBeTruthy();
    });
    expect(h.elements).toHaveLength(0);
    expect(window.location.hash).toBe("");
  });
});
