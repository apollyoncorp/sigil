import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import { vi } from "vitest";

import ExcalidrawApp from "../App";
import { encodeSceneData } from "../data/dataLink";

import { openWithHash, rect, sceneJson } from "./dataLinkFixtures";

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

describe("opening #data= over a non-empty local scene", () => {
  beforeEach(() => {
    localStorage.setItem("excalidraw", JSON.stringify([rect("local")]));
    openWithHash(`#data=${encodeSceneData(sceneJson("a"))}`);
  });

  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("asks first (the existing overwrite dialog) and replaces on yes", async () => {
    // the app only finishes loading once the dialog is answered
    const loaded = render(<ExcalidrawApp />);
    const button = await screen.findByText("Replace my content");
    expect(document.body.textContent).toContain("Load from link");
    fireEvent.click(button);
    await loaded;
    await waitFor(() => {
      expect(h.elements.map((e) => e.id)).toEqual(["a"]);
    });
    expect(window.location.hash).toBe("");
  });

  it("keeps the local scene when the dialog is dismissed", async () => {
    const loaded = render(<ExcalidrawApp />);
    await screen.findByText("Replace my content");
    fireEvent.keyDown(document.activeElement || document.body, {
      key: "Escape",
    });
    await loaded;
    await waitFor(() => {
      expect(h.elements.map((e) => e.id)).toEqual(["local"]);
    });
    expect(window.location.hash).toBe("");
  });
});
