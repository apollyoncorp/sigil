import { setTranslationOverrides } from "@excalidraw/excalidraw/i18n";

// Sigil's own wording for upstream strings that name Excalidraw. The locale
// files stay as upstream ships them, so merges and translations are untouched.

// Swaps the product name in every language. Used where the string names the
// product (menu item, dialog title, install prompt).
const brand = (translation: string) =>
  translation.replace(/Excalidraw/g, "Sigil");

setTranslationOverrides({
  "toolBar.mermaidToExcalidraw": brand,
  "mermaid.title": brand,
  // English: "converted to Sigil elements" reads oddly, so drop the name.
  "mermaid.description": (translation) =>
    brand(translation.replace("Excalidraw elements", "editable shapes")),
  "labels.installPWA": brand,
  // Section of the library panel for libraries added from a catalog or from
  // the main menu (BPMN, flowchart). Not Sigil-branded, so the same in every
  // language.
  "labels.excalidrawLib": "Shape libraries",
  // "Excalidraw JSON" names the file format, which Sigil also reads. This
  // error also shows for a broken #data= link, so name the format by its file
  // extension. Other languages keep the upstream text.
  "alerts.invalidSceneUrl": (translation, langCode) =>
    langCode === "en"
      ? "Couldn't import scene from the supplied link. It's either malformed, or doesn't contain valid .excalidraw data."
      : translation,
});
