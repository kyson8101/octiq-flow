"use strict";
// The pictures, recordings and sounds an ask_user call shows: up to four
// under a question, and an image on each option.
//
// Each file is read HERE, by the agent's own MCP server, so with the agent's
// rights and never the host's: an agent cannot show the person a file it
// could not open itself. The bytes are streamed to the host
// (`/hook/question-media`), which decides what they are by their first bytes,
// keeps an immutable snapshot under the profile (src-tauri/src/question_media.rs)
// and answers its id. The question then names each snapshot by id.
//
// Everything is checked before anything is asked, and a file that cannot be
// shown refuses the whole call: a question that says "pick by the picture"
// with the picture gone would mislead the person.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MAX_PER_QUESTION = 4;
const MB = 1024 * 1024;
const IMAGE_MAX = 20 * MB;
const PLAYED_MAX = 200 * MB;
const CALL_MAX = 300 * MB;
const CAPTION_MAX = 160;

/** A call that cannot be asked, in words that name the file. */
class MediaRefusal extends Error {}

const refuse = (why) => {
  throw new MediaRefusal(why);
};

/** Open one source safely: absolute, a regular
 *  file, not empty, under its cap. Non-blocking, so a FIFO handed over as a
 *  picture cannot hang the call; the size is the open file's own. */
function openSource(source, cap) {
  if (typeof source !== "string" || !source.trim()) refuse("A media path must be text.");
  if (!path.isAbsolute(source)) refuse(`${source} is not an absolute path.`);
  let fd;
  try {
    fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    refuse(
      error.code === "ENOENT"
        ? `${source} does not exist.`
        : `${source} cannot be read: ${error.code || error.message}.`,
    );
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) refuse(`${source} is not a regular file.`);
    if (stat.size === 0) refuse(`${source} is empty.`);
    if (stat.size > cap) refuse(`${source} is ${(stat.size / MB).toFixed(1)} MB, over the ${cap / MB} MB allowed here.`);
    return { fd, size: stat.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function captionOf(entry, source) {
  if (entry.caption === undefined || entry.caption === null) return undefined;
  if (typeof entry.caption !== "string") refuse(`The caption of ${source} must be text.`);
  const caption = entry.caption.trim();
  if ([...caption].length > CAPTION_MAX) refuse(`The caption of ${source} is over ${CAPTION_MAX} characters.`);
  return caption || undefined;
}

/** Every file a call shows, as `{question, option?, source, caption}`, with
 *  each one's shape checked. Nothing is opened yet. */
function wanted(list) {
  const out = [];
  list.forEach((question, q) => {
    const media = question.media;
    if (media !== undefined && media !== null) {
      if (!Array.isArray(media)) refuse("media must be a list of {path, caption}.");
      if (media.length > MAX_PER_QUESTION) {
        refuse(`The question "${question.question}" has ${media.length} media files; at most ${MAX_PER_QUESTION} can be shown under one question.`);
      }
      for (const entry of media) {
        const item = typeof entry === "string" ? { path: entry } : entry;
        if (!item || typeof item !== "object" || typeof item.path !== "string") {
          refuse("Each media entry needs a path: the absolute path of a local file.");
        }
        out.push({ question: q, source: item.path, caption: captionOf(item, item.path) });
      }
    }
    (Array.isArray(question.options) ? question.options : []).forEach((option, o) => {
      if (!option || typeof option !== "object" || option.image === undefined || option.image === null) return;
      if (typeof option.image !== "string") refuse(`The image of option "${option.label}" must be the absolute path of a local image.`);
      out.push({ question: q, option: o, source: option.image });
    });
  });
  return out;
}

/** Check, upload and name every file of a call; the list comes back with
 *  each one replaced by the snapshot the host keeps (`{id, name, caption}`).
 *  A call with no media is returned as it was, and nothing is sent. */
async function attachMedia(list, upload = uploadToHost, discard = discardMedia) {
  const files = wanted(list);
  if (!files.length) return list;
  const opened = [];
  const uploaded = [];
  try {
    let total = 0;
    for (const file of files) {
      const cap = file.option === undefined ? PLAYED_MAX : IMAGE_MAX;
      const { fd, size } = openSource(file.source, cap);
      opened.push(fd);
      total += size;
      Object.assign(file, { fd, size });
    }
    if (total > CALL_MAX) {
      refuse(`The files of this call come to ${(total / MB).toFixed(0)} MB, over the ${CALL_MAX / MB} MB one ask_user call can show.`);
    }
    // Copies, so what the agent sent is not changed under it.
    const out = list.map((question) => ({
      ...question,
      ...(question.media ? { media: [] } : {}),
      ...(Array.isArray(question.options)
        ? { options: question.options.map((o) => (o && typeof o === "object" ? { ...o } : o)) }
        : {}),
    }));
    for (const file of files) {
      const name = path.basename(file.source);
      const media = await upload({ fd: file.fd, size: file.size, name, option: file.option !== undefined });
      uploaded.push(media.id);
      const ref = { id: media.id, name: media.name || name };
      if (file.option === undefined) out[file.question].media.push(file.caption ? { ...ref, caption: file.caption } : ref);
      else out[file.question].options[file.option].image = ref;
    }
    return out;
  } catch (error) {
    await discard(uploaded).catch(() => {}); // Keep the original refusal.
    throw error;
  } finally {
    for (const fd of opened) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Roll back only snapshots the host has never adopted for a question.
 *  A missing response may mean an ask was accepted, so the host owns that check. */
function discardMedia(ids) {
  if (!ids.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const chatKey = process.env.OCTIQ_CHAT_KEY || "";
    const body = JSON.stringify({ chatKey, sessionKey: process.env.OCTIQ_SESSION_KEY || chatKey,
      launchId: process.env.OCTIQ_LAUNCH_ID || undefined, ids });
    const req = http.request({ host: "127.0.0.1", port: Number(process.env.OCTIQ_HOOK_PORT),
      path: "/hook/question-media/discard", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "x-octiq-chat-capability": process.env.OCTIQ_CHAT_CAPABILITY || "" } }, (res) => {
      res.resume();
      res.on("end", () => res.statusCode === 200 ? resolve() : reject(new Error("Media rollback refused")));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Media rollback timed out")));
    req.end(body);
  });
}

function mediaIds(list) {
  return list.flatMap((q) => [ ...(q.media || []), ...(q.options || []).flatMap((o) => o?.image ? [o.image] : []) ]).map((m) => m.id);
}

/** Stream one open file to the host as this chat. Answers the snapshot, or
 *  throws the host's sentence as a refusal. */
function uploadToHost({ fd, size, name, option }) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.OCTIQ_HOOK_PORT || "");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return reject(new MediaRefusal("OctiqFlow is not reachable, so the media could not be attached."));
    }
    const chatKey = process.env.OCTIQ_CHAT_KEY || "";
    const query = new URLSearchParams({
      chatKey,
      sessionKey: process.env.OCTIQ_SESSION_KEY || chatKey,
      name,
      bytes: String(size),
      ...(process.env.OCTIQ_LAUNCH_ID ? { launchId: process.env.OCTIQ_LAUNCH_ID } : {}),
      ...(option ? { option: "true" } : {}),
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/hook/question-media?${query}`,
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": size,
          "x-octiq-chat-capability": process.env.OCTIQ_CHAT_CAPABILITY || "",
        },
      },
      (res) => {
        let out = "";
        res.on("data", (chunk) => (out += chunk));
        res.on("end", () => {
          let answer;
          try { answer = JSON.parse(out); } catch { answer = { error: `OctiqFlow refused ${name}: ${out || res.statusCode}` }; }
          if (answer.error || !answer.result?.id) reject(new MediaRefusal(answer.error || `OctiqFlow did not keep ${name}.`));
          else resolve(answer.result);
        });
      },
    );
    req.on("error", () => reject(new MediaRefusal("OctiqFlow could not be reached, so the media could not be attached.")));
    req.setTimeout(10 * 60 * 1000, () => {
      req.destroy();
      reject(new MediaRefusal(`${name} timed out on its way to OctiqFlow.`));
    });
    // Exactly the bytes the open file held when it was measured.
    fs.createReadStream(null, { fd, start: 0, end: size - 1, autoClose: false })
      .on("error", (error) => {
        req.destroy();
        reject(new MediaRefusal(`${name} could not be read: ${error.code || error.message}.`));
      })
      .pipe(req);
  });
}

module.exports = { MediaRefusal, attachMedia, discardMedia, mediaIds, wanted, MAX_PER_QUESTION, IMAGE_MAX, PLAYED_MAX, CALL_MAX, CAPTION_MAX };
