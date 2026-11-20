import type { ImageJob, ImageReply } from "./image-worker.ts";
import { pictureType } from "./images.ts";

/** The long edge of the copy of a picture a model is shown, what vision models work at anyway. */
export const PREVIEW_EDGE = 1568;

// A picture taking longer than this is given up on, and the worker with it.
const JOB_MS = 60_000;
// The worker holds a decoder's memory, so it goes when nothing has needed it for a while.
const IDLE_MS = 5 * 60_000;

type Waiting = { resolve: (data: Uint8Array) => void; reject: (error: Error) => void; timer: Timer };

let worker: Worker | null = null;
let idle: Timer | null = null;
let nextId = 1;
const waiting = new Map<number, Waiting>();
// One picture at a time: the worker does one anyway, and a job's time limit then counts only its own work.
let queue: Promise<unknown> = Promise.resolve();

function stop(reason: string) {
  worker?.terminate();
  worker = null;
  for (const [id, job] of waiting) {
    clearTimeout(job.timer);
    job.reject(new Error(reason));
    waiting.delete(id);
  }
}

function started(): Worker {
  if (worker) return worker;
  const made = new Worker(new URL("./image-worker.ts", import.meta.url));
  // Bun's workers keep the process alive unless told not to; its types don't say so.
  (made as Worker & { unref?: () => void }).unref?.();
  made.onmessage = (event: MessageEvent<ImageReply>) => {
    const job = waiting.get(event.data.id);
    if (!job) return;
    waiting.delete(event.data.id);
    clearTimeout(job.timer);
    if (event.data.data) job.resolve(event.data.data);
    else job.reject(new Error(event.data.error ?? "the picture couldn't be read"));
  };
  made.onerror = (event) => {
    if (worker === made) stop(`the picture reader stopped: ${event.message}`);
  };
  worker = made;
  return made;
}

function run(op: ImageJob["op"], data: Uint8Array, type: string): Promise<Uint8Array> {
  const job = queue.then(
    () =>
      new Promise<Uint8Array>((resolve, reject) => {
        if (idle) clearTimeout(idle);
        const id = nextId++;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("the picture took too long to read"));
          stop("the picture reader was restarted");
        }, JOB_MS);
        waiting.set(id, { resolve, reject, timer });
        started().postMessage({ id, op, type, data, edge: PREVIEW_EDGE } satisfies ImageJob);
      }),
  );
  queue = job
    .catch(() => undefined)
    .then(() => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => !waiting.size && stop("idle"), IDLE_MS);
      idle.unref();
    });
  return job.then((jpeg) => {
    if (pictureType(jpeg) !== "image/jpeg") throw new Error("the picture couldn't be read");
    return jpeg;
  });
}

/** An iPhone's HEIC or HEIF photo as a JPEG every page and model reads, turned the way the camera held it, its metadata (where it was taken too) left behind. */
export function jpegFromHeic(data: Uint8Array): Promise<Uint8Array> {
  return run("jpeg", data, "image/heic");
}

/** A JPEG copy of a picture for a model to look at, its long edge at most `PREVIEW_EDGE`; read only as the type it was sent as. */
export function previewPicture(data: Uint8Array, mediaType: string): Promise<Uint8Array> {
  return run("preview", data, mediaType);
}
