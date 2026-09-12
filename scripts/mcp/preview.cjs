"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const PREVIEW_IMAGE = {
  name: "preview_image",
  description: "Show a local image in this conversation's Preview panel. Saves an immutable snapshot, so overwriting the source does not destroy earlier versions. Use the same slot for revisions of one image; omit slot to add a separate image. Returns immediately. Supports PNG, JPEG, GIF and WebP up to 20 MB.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to an existing local image." },
      title: { type: "string", maxLength: 160, description: "A short caption for the picture." },
      slot: { type: "string", maxLength: 120, description: "Stable name for one image across revisions, e.g. home-screen." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  throw new Error("Use a PNG, JPEG, GIF or WebP image.");
}

const PREVIEW_HTML = {
  name: "preview_html",
  description: "Publish an HTML document to this conversation's Preview panel. The person clicks Open HTML to view it in a new browser tab. Provide exactly one of path (a local .html/.htm file) or html (inline UTF-8 HTML). Saves an immutable snapshot; reuse slot for revisions. Maximum 2 MB. Use self-contained HTML with inline CSS/JS and embedded images; adjacent files are not uploaded. Returns immediately without opening the document for the person.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to an existing UTF-8 .html or .htm file." },
      html: { type: "string", description: "HTML source to upload directly, including inline styles and scripts if needed." },
      title: { type: "string", maxLength: 160, description: "Document title shown in the Preview panel." },
      slot: { type: "string", maxLength: 120, description: "Stable name grouping revisions of this HTML document." },
    },
    oneOf: [{ required: ["path"], not: { required: ["html"] } }, { required: ["html"], not: { required: ["path"] } }],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

function validatePublication(args, chatKey) {
  if (!/^chat:[A-Za-z0-9_-]{1,160}$/.test(chatKey)) throw new Error("Previews require an OctiqFlow conversation.");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Preview arguments must be an object.");
  for (const [field, limit] of [["title", 160], ["slot", 120]]) {
    if (args[field] !== undefined && (typeof args[field] !== "string" || !args[field].trim() || args[field].length > limit)) throw new Error(`${field} must be non-empty text of at most ${limit} characters.`);
  }
}

function readSource(source, maxBytes) {
  if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("path must be an absolute file path.");
  // Open first, then inspect and read the same descriptor. Non-blocking avoids
  // hanging on a FIFO supplied as an image; the size cap also covers file growth.
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error(`File must be a regular file between 1 byte and ${maxBytes / 1024 / 1024} MB.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > maxBytes) throw new Error(`File exceeds ${maxBytes / 1024 / 1024} MB.`);
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  return bytes;
}

function publish(args, root, chatKey, bytes, extension, kind) {
  const dir = path.join(root, "previews", chatKey.slice(5));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Do not follow a conversation directory redirected outside the profile.
  if (fs.realpathSync(dir) !== path.join(fs.realpathSync(root), "previews", chatKey.slice(5))) throw new Error("Preview directory must not be a symlink.");
  const id = randomUUID();
  const file = `${id}.${extension}`;
  fs.writeFileSync(path.join(dir, file), bytes, { flag: "wx", mode: 0o600 });
  const entry = { id, file, kind, slot: args.slot?.trim() || id, title: args.title?.trim() || (args.path ? path.basename(args.path) : "HTML document"), createdAt: Date.now() };
  // Unique entries avoid read-modify-write races between agents. Publish the
  // metadata last with an atomic rename so readers never see a partial entry.
  const pending = path.join(dir, `${id}.pending`);
  fs.writeFileSync(pending, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
  fs.renameSync(pending, path.join(dir, `${id}.json`));
  return { ...entry, path: path.join(dir, file) };
}
function previewImage(args, root, chatKey) {
  validatePublication(args, chatKey);
  const bytes = readSource(args.path, MAX_BYTES);
  return publish(args, root, chatKey, bytes, imageExtension(bytes), "image");
}

function previewHtml(args, root, chatKey) {
  validatePublication(args, chatKey);
  if ((args.path !== undefined) === (args.html !== undefined)) throw new Error("Provide exactly one of path or html.");
  let bytes;
  if (args.path !== undefined) {
    if (typeof args.path !== "string" || !/\.html?$/i.test(args.path)) throw new Error("path must name a .html or .htm file.");
    bytes = readSource(args.path, MAX_HTML_BYTES);
  } else {
    if (typeof args.html !== "string" || Buffer.byteLength(args.html, "utf8") > MAX_HTML_BYTES) throw new Error("html must be a string of at most 2 MB.");
    bytes = Buffer.from(args.html, "utf8");
  }
  let html;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("HTML must be UTF-8 text."); }
  if (!html.trim() || html.includes("\0")) throw new Error("HTML must be non-empty text without null bytes.");
  return publish(args, root, chatKey, bytes, "html", "html");
}
module.exports = { PREVIEW_IMAGE, PREVIEW_HTML, previewImage, previewHtml };
