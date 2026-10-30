// Wave 2.10b F6: the icon picker's categories and search words. Every built-in icon (icons.ts) sits in
// exactly one category (icon-catalogue.test.ts checks it); words are extra names a person might type.
import { ICON_PATHS } from "./icons";

export type IconCategory = { id: string; title: string; names: readonly string[] };

export const ICON_CATEGORIES: readonly IconCategory[] = [
  { id: "services", title: "Services", names: ["prometheus", "proxmox", "docker", "npm", "pfsense", "uptime-kuma", "home-assistant", "custom-api", "atrium", "rss", "git", "pull-request", "container", "database", "terminal", "code", "brackets", "robot"] },
  { id: "devices", title: "Devices", names: ["server", "cpu", "memory", "disk", "ssd", "gpu", "rack", "nodes", "laptop", "monitor", "tablet", "phone", "watch", "keyboard", "mouse", "printer", "scanner", "usb", "sd-card", "save", "window", "tv", "remote", "speaker", "headphones", "microphone", "gamepad", "battery", "battery-charging", "power", "plug", "fan"] },
  { id: "network", title: "Network", names: ["network", "router", "network-switch", "ethernet", "wifi", "wifi-off", "antenna", "satellite-dish", "signal", "bluetooth", "cast", "globe", "cloud", "cloud-upload", "cloud-download", "link", "sitemap", "firewall", "shield", "shield-lock", "shield-check", "shield-alert", "lock", "unlock", "key", "qr-code", "barcode", "scan", "download", "upload"] },
  { id: "home", title: "Home", names: ["home", "door", "garage", "doorbell", "light", "lamp", "sofa", "bed", "bath", "fridge", "oven", "washer", "coffee", "plant", "air-conditioner", "thermostat", "thermometer", "flame", "blinds", "camera", "cctv", "sensor", "siren", "outlet", "toggle", "faucet", "droplet", "trash", "paw", "bolt"] },
  { id: "weather", title: "Weather and nature", names: ["sun", "moon", "cloud-sun", "cloud-rain", "cloud-snow", "storm", "wind", "snowflake", "umbrella", "rainbow", "sunrise", "sunset", "mountain", "waves", "tree", "leaf", "flower", "solar-panel"] },
  { id: "media", title: "Media", names: ["play", "pause", "stop", "record", "skip-back", "skip-next", "shuffle", "loop", "music", "playlist", "vinyl", "radio", "podcast", "volume", "mute", "film", "video", "clapperboard", "play-box", "ticket", "photo", "images", "palette", "pen", "edit", "eye", "eye-off", "book", "news"] },
  { id: "status", title: "Status", names: ["check", "check-circle", "close", "x-circle", "warning", "alert-circle", "info", "question", "ban", "plus", "minus", "plus-circle", "spinner", "bell", "bell-off", "flag", "target", "bug", "activity", "gauge", "chart", "bar-chart", "pie-chart", "trending-up", "trending-down", "star", "heart", "trophy", "medal", "thumbs-up", "smile", "frown", "sparkle"] },
  { id: "time", title: "Time", names: ["clock", "alarm-clock", "stopwatch", "hourglass", "history", "calendar", "calendar-check"] },
  { id: "files", title: "Files", names: ["file", "file-text", "file-code", "folder", "folder-open", "archive", "box", "clipboard", "copy", "paperclip", "note", "bookmark", "tag", "layers", "inbox", "mail", "send", "share", "external-link", "search", "zoom-in", "list", "table", "grid", "presentation", "hash"] },
  { id: "people", title: "People", names: ["user", "users", "user-plus", "user-check", "message", "chats", "at", "telephone", "id-card", "briefcase", "graduation", "accessibility", "translate"] },
  { id: "tools", title: "Tools", names: ["settings", "sliders", "wrench", "hammer", "toolbox", "filter", "refresh", "scissors", "magnet", "flask", "rocket", "puzzle", "wand", "dice"] },
  { id: "places", title: "Places and travel", names: ["building", "store", "factory", "hospital", "map", "pin", "location", "compass", "anchor", "car", "bike", "bus", "train", "plane", "truck", "fuel", "ev-charger", "parking"] },
  { id: "money", title: "Money and food", names: ["dollar", "wallet", "credit-card", "receipt", "bank", "percent", "cart", "bag", "gift", "pizza", "utensils", "wine", "dumbbell", "pill", "first-aid"] },
  { id: "shapes", title: "Arrows and shapes", names: ["arrow-up", "arrow-down", "arrow-left", "arrow-right", "chevron-up", "chevron-down", "chevron-left", "chevron-right", "maximize", "minimize", "move", "menu", "dots", "login", "logout", "layout", "columns", "circle", "square", "triangle", "hexagon", "diamond", "infinity", "contrast"] },
];

/** Extra words that find an icon by what it means, not only by its name. */
const WORDS: Record<string, string> = {
  server: "host machine computer box", cpu: "processor chip load", memory: "ram", disk: "drive storage hdd", ssd: "drive storage nvme", gpu: "graphics card video", rack: "servers cabinet", nodes: "cluster mesh",
  monitor: "screen display desktop", phone: "mobile", tv: "television screen media", speaker: "audio sound", gamepad: "games console controller", fan: "cooling", plug: "power socket",
  network: "lan topology", router: "gateway modem", "network-switch": "lan ports", ethernet: "cable port lan", wifi: "wireless", globe: "web internet world dns", cloud: "online sync", link: "chain url",
  shield: "security firewall protect", "shield-lock": "vpn wireguard", firewall: "wall security", key: "password secret token", lock: "secure closed", sitemap: "dns hierarchy",
  home: "house", door: "entrance", light: "bulb lamp idea", camera: "photo snapshot security", cctv: "security camera surveillance", sensor: "motion presence", siren: "alarm smoke",
  thermostat: "heating climate", thermometer: "temperature heat", flame: "fire heating gas", droplet: "water humidity", bolt: "electricity energy lightning power", trash: "bin delete rubbish",
  sun: "day weather bright", moon: "night dark", storm: "lightning thunder", "cloud-rain": "weather rain", "solar-panel": "energy power pv",
  play: "start media", film: "movie plex jellyfin", video: "camera stream", music: "audio song", photo: "image picture", images: "gallery photos", palette: "colour theme paint", news: "rss feed article",
  check: "ok done tick yes", "check-circle": "ok healthy up", close: "x cancel no", "x-circle": "error down failed", warning: "alert caution", "alert-circle": "error problem", info: "about help",
  bell: "notification alert", activity: "pulse uptime monitor", gauge: "meter speed", chart: "graph metrics", "bar-chart": "graph stats", "trending-up": "growth rise", bug: "error issue",
  clock: "time", history: "past log backup", calendar: "date schedule",
  file: "document", folder: "directory files", box: "package", note: "text memo", mail: "email message", search: "find magnifier", table: "spreadsheet rows",
  user: "person account profile", users: "people family team group", message: "chat comment", telephone: "phone call",
  settings: "gear cog preferences", sliders: "controls adjust", wrench: "tool fix", refresh: "reload sync update", rocket: "launch deploy",
  building: "office", store: "shop", car: "vehicle", map: "location", pin: "place marker location",
  dollar: "money cost price", cart: "shopping basket", bag: "shopping",
  terminal: "shell console ssh", code: "developer html", database: "db sql postgres", container: "docker pod", git: "repository branch", robot: "bot ai automation",
  prometheus: "metrics monitoring", proxmox: "virtual machines hypervisor", docker: "containers", npm: "nginx proxy manager", pfsense: "firewall router", "uptime-kuma": "monitor uptime", "home-assistant": "smart home automation",
};

const ALL = Object.keys(ICON_PATHS);
const NAMES_IN_CATEGORIES = new Set(ICON_CATEGORIES.flatMap((c) => c.names));
/** Any icon not placed in a category still shows, under Other. */
const OTHER = ALL.filter((n) => !NAMES_IN_CATEGORIES.has(n));
export const PICKER_CATEGORIES: readonly IconCategory[] = [...ICON_CATEGORIES.map((c) => ({ ...c, names: c.names.filter((n) => n in ICON_PATHS) })), ...(OTHER.length ? [{ id: "other", title: "Other", names: OTHER }] : [])];

/** Every built-in icon in picker order (by category). */
export const PICKER_ICONS: readonly string[] = PICKER_CATEGORIES.flatMap((c) => c.names);

/** How an icon's name reads ("cloud-upload" reads "cloud upload"). */
export const iconWords = (name: string) => name.replace(/-/g, " ");

/**
 * Icons matching what a person typed: every typed word must start a word of the icon's name, its
 * category or its extra words. Names that start with the text come first.
 */
export function searchIcons(query: string, names: readonly string[] = PICKER_ICONS): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...names];
  const terms = q.split(/\s+/);
  const catOf = new Map<string, string>();
  for (const c of PICKER_CATEGORIES) for (const n of c.names) catOf.set(n, c.title.toLowerCase());
  const hit = (n: string) => {
    const hay = `${iconWords(n)} ${catOf.get(n) ?? ""} ${WORDS[n] ?? ""}`.split(/\s+/);
    return terms.every((t) => hay.some((w) => w.startsWith(t)));
  };
  const found = names.filter(hit);
  const starts = found.filter((n) => iconWords(n).startsWith(q));
  return [...starts, ...found.filter((n) => !starts.includes(n))];
}

const RECENT_KEY = "atrium.icons.recent";
const RECENT_MAX = 12;
/** The icons this person picked last (in this browser), newest first. Browser storage is a convenience only. */
export function readRecentIcons(): string[] {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
export function rememberIcon(ref: string): void {
  try {
    const next = [ref, ...readRecentIcons().filter((x) => x !== ref)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: Recent stays as it was */
  }
}
