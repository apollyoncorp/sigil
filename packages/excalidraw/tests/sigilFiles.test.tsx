import React from "react";

import { vi } from "vitest";

import { MIME_TYPES, SIGIL_FILE_EXTENSION } from "@excalidraw/common";

import {
  blobToArrayBuffer,
  normalizeFile,
  loadFromBlob,
  getFileHandleType,
} from "../data/blob";
import { saveAsJSON, serializeAsJSON } from "../data/json";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, fireEvent, render, screen, waitFor } from "./test-utils";

const { fileSaveMock } = vi.hoisted(() => ({
  fileSaveMock: vi.fn(),
}));

vi.mock("browser-fs-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("browser-fs-access")>()),
  fileSave: fileSaveMock,
}));

const { h } = window;

const serializedScene = () =>
  serializeAsJSON(
    [API.createElement({ type: "rectangle", id: "rect" })],
    { ...h.state },
    {},
    "local",
  );

const savedFileName = () => fileSaveMock.mock.calls.at(-1)![1].fileName;

beforeEach(() => {
  fileSaveMock.mockReset();
  fileSaveMock.mockResolvedValue(null);
});

describe("saving", () => {
  const data = () => ({ elements: [], appState: h.state, files: {} });

  it("names the file .sigil by default", async () => {
    await render(<Excalidraw />);
    await saveAsJSON({ data: data(), filename: "drawing", fileHandle: null });
    expect(SIGIL_FILE_EXTENSION).toBe("sigil");
    expect(savedFileName()).toBe("drawing.sigil");
    expect(fileSaveMock.mock.calls[0][1].extensions).toEqual([".sigil"]);
  });

  it("writes the same JSON an .excalidraw file has", async () => {
    await render(<Excalidraw />);
    await saveAsJSON({ data: data(), filename: "drawing", fileHandle: null });
    const blob: Blob = await fileSaveMock.mock.calls[0][0];
    expect(blob.type).toBe(MIME_TYPES.excalidraw);
    expect(
      JSON.parse(new TextDecoder().decode(await blobToArrayBuffer(blob))),
    ).toMatchObject({
      type: "excalidraw",
      version: 2,
      elements: [],
    });
  });

  it("names the file .excalidraw when asked to", async () => {
    await render(<Excalidraw />);
    await saveAsJSON({
      data: data(),
      filename: "drawing",
      fileHandle: null,
      extension: "excalidraw",
    });
    expect(savedFileName()).toBe("drawing.excalidraw");
  });

  it("passes an opened file's handle through, whatever its extension", async () => {
    await render(<Excalidraw />);
    const handle = { name: "old.excalidraw" } as FileSystemFileHandle;
    await saveAsJSON({ data: data(), filename: "old", fileHandle: handle });
    expect(fileSaveMock.mock.calls[0][2]).toBe(handle);
    expect(getFileHandleType(handle)).toBe("excalidraw");
    expect(
      getFileHandleType({ name: "new.sigil" } as FileSystemFileHandle),
    ).toBe("sigil");
  });
});

describe("export dialog", () => {
  const openDialog = async () => {
    await render(<Excalidraw />);
    act(() => {
      h.setState({ openDialog: { name: "jsonExport" } });
    });
  };

  it("keeps the focus on the main save button", async () => {
    await openDialog();
    await waitFor(() =>
      expect(document.activeElement).toHaveClass("Card-button"),
    );
  });

  it("saves .sigil from the main button", async () => {
    await openDialog();
    fireEvent.click(await screen.findByText("Save to file"));
    await waitFor(() => expect(fileSaveMock).toHaveBeenCalled());
    expect(savedFileName()).toMatch(/\.sigil$/);
  });

  it('saves .excalidraw from "Save as .excalidraw"', async () => {
    await openDialog();
    expect(
      screen.getByText(/Features only Sigil has may be lost/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("save-as-excalidraw-button"));
    await waitFor(() => expect(fileSaveMock).toHaveBeenCalled());
    expect(savedFileName()).toMatch(/\.excalidraw$/);
  });
});

describe("loading", () => {
  it.each([`scene.${SIGIL_FILE_EXTENSION}`, "scene.excalidraw"])(
    "opens %s from a file without a MIME type",
    async (name) => {
      await render(<Excalidraw />);
      const file = await normalizeFile(
        new File([serializedScene()], name, { type: "" }),
      );
      expect(file.type).toBe(MIME_TYPES.excalidraw);
      const { elements } = await loadFromBlob(file, h.state, []);
      expect(elements.map((e) => e.id)).toEqual(["rect"]);
    },
  );

  it.each(["scene.sigil", "scene.excalidraw"])(
    "drops %s onto the canvas",
    async (name) => {
      await render(<Excalidraw />);
      const replaced = await h.app.loadFileToCanvas(
        new File([serializedScene()], name, { type: "" }),
        null,
      );
      expect(replaced).toBe(true);
      expect(h.elements.map((e) => e.id)).toEqual(["rect"]);
    },
  );
});
