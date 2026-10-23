// Written inspector labels (builder ease spec 3.2, criterion 9): every prop of every built-in component
// has a label a first-time user can read and a one-line hint under it, and each type names its simple
// set (shown first; everything else folds under "More settings"). The type below makes a missing label
// a compile error, so the production build fails on it; labels.test.ts checks the same at run time.
import type { z } from "zod";
import type { BuiltInType, propsSchemas } from "../catalogue/schemas";

export type FieldWords = {
  label: string;
  hint: string;
  /** Words for an enum's values, shown in its menu instead of the raw value. */
  options?: Record<string, string>;
};

type PropsOf<T extends BuiltInType> = keyof z.infer<(typeof propsSchemas)[T]>;
export type TypeWords<T extends BuiltInType> = { simple: readonly PropsOf<T>[]; fields: { [K in PropsOf<T>]-?: FieldWords } };

const FIT = { cover: "Fill and crop", contain: "Show whole" };
const LINK = { none: "Nothing", page: "Open a page of this app", url: "Open an address", enlarge: "Enlarge" };
/** The Picture panel's words (media layout spec 3.1, Amendment 8 A8.7), shared by Image and Video. */
const MEDIA_WORDS = {
  shape: { label: "Shape", hint: "The box's shape: the file's own, a fixed ratio, or the box as you sized it", options: { original: "Original", "16:9": "16:9", "4:3": "4:3", "1:1": "1:1", "3:4": "3:4", "9:16": "9:16", fill: "Fill the box" } },
  rotate: { label: "Rotate", hint: "Turns the picture a quarter at a time inside its box", options: { "0": "Upright", "90": "A quarter right", "180": "Upside down", "270": "A quarter left" } },
  flipX: { label: "Flip across", hint: "Mirrors the picture left to right" },
  flipY: { label: "Flip down", hint: "Mirrors the picture top to bottom" },
  straighten: { label: "Straighten", hint: "Tilts the picture by up to 45 degrees either way" },
  zoom: { label: "Zoom", hint: "Zooms in around the focal point, up to 400 percent" },
  focusX: { label: "Focal point across", hint: "Click or drag on the thumbnail: which part stays in view, from the left" },
  focusY: { label: "Focal point down", hint: "Which part stays in view, from the top" },
  filters: { label: "Filters", hint: "A preset, or set brightness, contrast, saturation, grey, sepia and blur yourself" },
  caption: { label: "Caption", hint: "Words shown with the picture, in the theme's text style" },
  captionAt: { label: "Caption position", hint: "Below the picture, over its bottom edge, or none", options: { below: "Below", over: "Over the bottom" } },
} satisfies Record<string, FieldWords>;
const updated: FieldWords = { label: "Show when it was updated", hint: "A small \"Last updated\" badge with the source's own time" };
const warn: FieldWords = { label: "Warning from", hint: "Turns the warning colour at or above this number" };
const bad: FieldWords = { label: "Problem from", hint: "Turns the problem colour at or above this number" };
const control = (what: string): FieldWords => ({ label: "What it runs", hint: `The app control this ${what} runs` });

export const FIELD_WORDS: { [T in BuiltInType]: TypeWords<T> } = {
  grid: {
    simple: ["gap"],
    fields: {
      gap: { label: "Space between", hint: "Gap between widgets in px. Empty uses the theme" },
      minRows: { label: "Minimum height", hint: "In rows of 8 px, so an empty grid has room to drop into" },
      columns: { label: "Columns", hint: "How many columns widgets snap to on desktop. Phones always use 4", options: { "6": "6 columns", "12": "12 columns", "24": "24 columns" } },
    },
  },
  stack: {
    simple: ["direction", "gap"],
    fields: {
      direction: { label: "Direction", hint: "Top to bottom, or side by side", options: { vertical: "Top to bottom", horizontal: "Side by side" } },
      gap: { label: "Space between", hint: "Gap between items in px. Empty uses the theme" },
      align: { label: "Line up", hint: "How items line up across the stack", options: { start: "Start", center: "Centre", end: "End", stretch: "Stretch to fill" } },
      wrap: { label: "Wrap onto more lines", hint: "A side by side stack moves items down when it runs out of room" },
    },
  },
  card: {
    simple: ["title", "subtitle"],
    fields: {
      title: { label: "Title", hint: "Shown at the top of the card. Leave empty for none" },
      subtitle: { label: "Subtitle", hint: "A short line under the title" },
      padded: { label: "Space inside", hint: "Pad the card's content with the theme's padding" },
    },
  },
  tabs: {
    simple: ["labels"],
    fields: {
      labels: { label: "Tab names", hint: "One name per tab, separated by commas" },
      initial: { label: "Tab shown first", hint: "Counting from 0 for the first tab" },
    },
  },
  section: {
    simple: ["title", "description"],
    fields: {
      title: { label: "Heading", hint: "The section's heading. Leave empty for none" },
      description: { label: "Description", hint: "A sentence under the heading" },
    },
  },
  repeat: {
    simple: ["items", "columns"],
    fields: {
      items: { label: "Repeat for each row of", hint: "A list or table; its child shows once per row" },
      columns: { label: "Per row", hint: "How many items side by side on desktop (always 1 on phones)" },
      gap: { label: "Space between", hint: "Gap between items in px" },
      max: { label: "Most items", hint: "Show at most this many" },
      empty: { label: "When there is nothing", hint: "Text shown when the list is empty" },
    },
  },
  stat: {
    simple: ["data", "label", "value", "unit", "decimals"],
    fields: {
      data: { label: "Number from", hint: "The data this stat shows" },
      value: { label: "Value", hint: "The number or text shown. Replaces the source's value" },
      label: { label: "Label", hint: "The words under the value" },
      unit: { label: "Unit", hint: "Shown after the value, like % or GB" },
      delta: { label: "Change", hint: "A change to show, like -2 over 1h" },
      warn,
      bad,
      decimals: { label: "Decimal places", hint: "How many digits after the point" },
      showUpdated: updated,
    },
  },
  chart: {
    simple: ["data", "kind"],
    fields: {
      data: { label: "Series", hint: "The values over time this chart draws" },
      kind: { label: "Chart type", hint: "Lines, filled areas or bars", options: { line: "Lines", area: "Filled areas", bars: "Bars" } },
      height: { label: "Height", hint: "In px" },
      legend: { label: "Show the legend", hint: "Names each line under the chart" },
      showUpdated: updated,
    },
  },
  table: {
    simple: ["data", "columns", "maxRows"],
    fields: {
      data: { label: "Rows from", hint: "The table of data to show" },
      columns: { label: "Columns", hint: "Which columns to show, in order, separated by commas. Empty shows all" },
      maxRows: { label: "Rows per page", hint: "Show at most this many rows" },
      showUpdated: updated,
    },
  },
  list: {
    simple: ["items", "labelKey"],
    fields: {
      items: { label: "Lines from", hint: "A list or table; one line per row" },
      labelKey: { label: "Text of each line", hint: "The column each line shows. Empty picks the first text column" },
      detailKey: { label: "Detail on the right", hint: "A column shown at the right of each line" },
      maxItems: { label: "Most lines", hint: "Show at most this many lines" },
      showUpdated: updated,
    },
  },
  status: {
    simple: ["data", "layout"],
    fields: {
      data: { label: "Things to watch", hint: "Services or devices that are up or down" },
      layout: { label: "Show as", hint: "One per line, or a grid of tiles", options: { list: "A list", grid: "Tiles" } },
      showUpdated: updated,
    },
  },
  gauge: {
    simple: ["value", "label", "unit"],
    fields: {
      value: { label: "Value", hint: "The number on the dial" },
      min: { label: "Lowest", hint: "The value at the start of the dial. Default 0" },
      max: { label: "Highest", hint: "The value at the end of the dial. Default 100" },
      unit: { label: "Unit", hint: "Shown after the value" },
      label: { label: "Label", hint: "The words under the dial" },
      warn,
      bad,
      showUpdated: updated,
    },
  },
  progress: {
    simple: ["value", "label", "unit"],
    fields: {
      value: { label: "Value", hint: "How far along the bar is" },
      min: { label: "Empty at", hint: "The value of an empty bar. Default 0" },
      max: { label: "Full at", hint: "The value of a full bar. Default 100" },
      label: { label: "Label", hint: "The words above the bar" },
      unit: { label: "Unit", hint: "Shown after the value" },
      showValue: { label: "Show the number", hint: "The value as text next to the label" },
      warn,
      bad,
      showUpdated: updated,
    },
  },
  heading: {
    simple: ["text", "level"],
    fields: {
      text: { label: "Text", hint: "The heading's words" },
      level: { label: "Size", hint: "1 is the largest", options: { "1": "Large", "2": "Medium", "3": "Small" } },
    },
  },
  text: {
    simple: ["text", "size"],
    fields: {
      text: { label: "Text", hint: "Line breaks are kept" },
      size: { label: "Size", hint: "How big the text is", options: { sm: "Small", md: "Medium", lg: "Large" } },
      muted: { label: "Quieter colour", hint: "Use the theme's muted text colour" },
    },
  },
  image: {
    simple: ["src", "alt", "shape", "fit", "rotate", "flipX", "flipY", "straighten", "zoom", "focusX", "focusY", "filters", "caption", "captionAt", "link"],
    fields: {
      src: { label: "Picture", hint: "Upload one, pick one you uploaded, or paste an address" },
      alt: { label: "Description", hint: "What the picture shows, read aloud by screen readers" },
      fit: { label: "Fit", hint: "Show the whole picture (the default for new pictures), or fill the box and crop", options: FIT },
      height: { label: "Picture height", hint: "In px. Kept in step with the box; change the box with Shape or Layout" },
      ...MEDIA_WORDS,
      link: { label: "When clicked", hint: "Nothing, open a page of this app, open an address in a new tab, or enlarge to full screen", options: LINK },
    },
  },
  video: {
    simple: ["src", "alt", "shape", "fit", "rotate", "flipX", "flipY", "filters", "caption", "captionAt", "poster", "startAt"],
    fields: {
      src: { label: "Video", hint: "An MP4 or WebM file, up to 25 MB" },
      alt: { label: "Description", hint: "What the video shows, read aloud by screen readers" },
      fit: { label: "Fit", hint: "Show the whole video (the default), or fill the box and crop", options: FIT },
      height: { label: "Video height", hint: "In px. Kept in step with the box; change the box with Shape or Layout" },
      loop: { label: "Loop", hint: "Start again when it ends" },
      autoplay: { label: "Play on its own", hint: "Starts muted as soon as it shows. Paused for reduced motion" },
      controls: { label: "Show controls", hint: "Play, pause and volume buttons" },
      sound: { label: "Sound", hint: "Only works with controls shown: browsers block sound that plays on its own" },
      ...MEDIA_WORDS,
      link: { label: "When clicked", hint: "Nothing, open a page of this app, open an address in a new tab, or enlarge to full screen", options: LINK },
      poster: { label: "Cover picture", hint: "Shown before the video plays, and while it stays paused for reduced motion" },
      startAt: { label: "Start at", hint: "Seconds into the video where playing starts" },
    },
  },
  icon: {
    simple: ["name", "size"],
    fields: {
      name: { label: "Icon", hint: "Pick a built-in icon" },
      size: { label: "Size", hint: "In px" },
      label: { label: "Meaning", hint: "Read aloud by screen readers. Empty marks it as decoration" },
    },
  },
  link: {
    simple: ["label", "page", "href"],
    fields: {
      label: { label: "Text", hint: "The words people click" },
      page: { label: "Page of this app", hint: "Opens this page, by its id or address" },
      href: { label: "Web address", hint: "An http or https address, opened in a new tab" },
    },
  },
  divider: {
    simple: ["spacing"],
    fields: { spacing: { label: "Space around", hint: "Space above and below the line in px" } },
  },
  spacer: {
    simple: ["height"],
    fields: { height: { label: "Height", hint: "Empty space in px" } },
  },
  clock: {
    simple: ["show"],
    fields: {
      show: { label: "Show", hint: "In the viewer's own time zone", options: { time: "Time", date: "Date", both: "Time and date" } },
      seconds: { label: "Seconds", hint: "Show the seconds ticking" },
      hour12: { label: "12-hour clock", hint: "With AM and PM" },
    },
  },
  button: {
    simple: ["label", "control"],
    fields: {
      label: { label: "Text", hint: "The words on the button" },
      control: control("button"),
      variant: { label: "Look", hint: "Main uses the theme's accent colour", options: { primary: "Main", secondary: "Plain" } },
    },
  },
  toggle: {
    simple: ["label", "control"],
    fields: {
      label: { label: "Text", hint: "The words next to the switch" },
      control: control("switch"),
      state: { label: "On when", hint: "Usually live data from the device" },
    },
  },
  slider: {
    simple: ["label", "control"],
    fields: {
      label: { label: "Text", hint: "The words above the slider" },
      control: control("slider when it is let go"),
      value: { label: "Current value", hint: "Usually live data from the device" },
      min: { label: "Lowest", hint: "Default 0" },
      max: { label: "Highest", hint: "Default 100" },
      step: { label: "Step", hint: "How much one notch moves. Default 1" },
      unit: { label: "Unit", hint: "Shown after the value" },
    },
  },
  select: {
    simple: ["label", "control", "options"],
    fields: {
      label: { label: "Text", hint: "The words above the menu" },
      control: control("menu"),
      value: { label: "Current choice", hint: "Usually live data from the device" },
      options: { label: "Choices", hint: "What people can pick, and what the control receives" },
    },
  },
  html: {
    simple: ["html", "height", "images"],
    fields: {
      html: { label: "Code", hint: "HTML, CSS and JavaScript, edited in the code window" },
      css: { label: "CSS", hint: "Edited in the code window" },
      js: { label: "JavaScript", hint: "Edited in the code window" },
      data: { label: "Data the block can read", hint: "Names the code reads in atrium.data" },
      controls: { label: "Controls the block may run", hint: "App controls the code may ask to run" },
      height: { label: "Height", hint: "Auto sizes to the content; Fill the page takes the window's height" },
      libs: { label: "Libraries", hint: "Bundled code libraries loaded into the block" },
      images: { label: "Pictures", hint: "Uploaded pictures the code can show, 2 MB in total" },
    },
  },
};

/** The written words for one field, or null for a prop no table names (package and library props). */
export function wordsFor(type: string, key: string): FieldWords | null {
  const t = (FIELD_WORDS as Record<string, { fields: Record<string, FieldWords> }>)[type];
  return t?.fields[key] ?? null;
}

/** Whether a field opens in its group's simple set. */
export function isSimple(type: string, key: string): boolean {
  const t = (FIELD_WORDS as Record<string, { simple: readonly string[] }>)[type];
  return !!t && t.simple.includes(key);
}
