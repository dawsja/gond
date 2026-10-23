import { CALL_MODELS, CALL_SAMPLE_RATE, type VoiceProvider } from "@gond/shared";

/** What a speaking model said or asked for, the same whichever model it is. */
export type VoiceSignal =
  | { kind: "ready" }
  | { kind: "audio"; data: string }
  | { kind: "heard"; text: string; final: boolean }
  | { kind: "said"; text: string }
  | { kind: "said-end" }
  | { kind: "interrupt" }
  | { kind: "delegate"; id: string; request: string | null }
  | { kind: "status"; id: string }
  | { kind: "hang-up"; id: string }
  | { kind: "error"; message: string }
  | { kind: "closed"; reason: string | null };

export type VoiceLink = {
  sendAudio(base64: string): void;
  /** The bot's answer to a handed-over request, for the voice to say in its own words. */
  result(id: string, text: string): void;
  /** Where the bot's work stands, for the voice to know without saying it. */
  progress(id: string, text: string): void;
  /** Something the voice should tell the person now, like a card on their screen. */
  tell(text: string): void;
  status(id: string, text: string): void;
  /** The quiet answer to a hand-over itself, for a voice whose hand-over is a function call. */
  handed(id: string, text: string): void;
  mute(muted: boolean): void;
  close(): void;
};

export type LinkOptions = {
  baseUrl: string;
  key: string;
  instructions: string;
  /** What came before the call, so the voice picks up where the chat is. */
  history: string;
  greeting: string;
  botName: string;
  /** The person's pick for this provider, else its default. */
  voice: string | undefined;
  on: (signal: VoiceSignal) => void;
};

// One append to GPT-Live takes up to 500 tokens.
const APPEND_CHARS = 1800;

function clip(text: string, max = APPEND_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function socketUrl(baseUrl: string, path: string): URL {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url;
}

type Event = Record<string, unknown> & { type?: unknown };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorOf(event: Event): string {
  const error = event.error as { message?: unknown; code?: unknown } | undefined;
  return text(error?.message) || text(error?.code) || "The voice ran into a problem";
}

/** GPT-Live with client delegation: it asks for help with an id only, and the request is what the person just said. */
export function readLiveEvent(event: Event): VoiceSignal[] {
  switch (event.type) {
    case "session.started":
      return [{ kind: "ready" }];
    case "session.output_audio.delta":
      return text(event.delta) ? [{ kind: "audio", data: text(event.delta) }] : [];
    case "session.input_transcript.delta":
      return text(event.delta) ? [{ kind: "heard", text: text(event.delta), final: false }] : [];
    case "session.output_transcript.delta":
      return text(event.delta) ? [{ kind: "said", text: text(event.delta) }] : [];
    case "session.delegation.created": {
      const delegation = event.delegation as { id?: unknown; target?: unknown } | undefined;
      return text(delegation?.id) && delegation?.target !== "responses" ? [{ kind: "delegate", id: text(delegation?.id), request: null }] : [];
    }
    case "session.closed":
      return [{ kind: "closed", reason: text(event.reason) || null }];
    case "error":
      return [{ kind: "error", message: errorOf(event) }];
    default:
      return [];
  }
}

export const ASK_TOOL = "ask_bot";
export const STATUS_TOOL = "bot_status";
export const END_TOOL = "end_call";

/** xAI's realtime voice: the OpenAI Realtime events, with the hand-over as a function call. */
export function readXaiEvent(event: Event): VoiceSignal[] {
  switch (event.type) {
    case "session.updated":
      return [{ kind: "ready" }];
    case "response.output_audio.delta":
    case "response.audio.delta":
      return text(event.delta) ? [{ kind: "audio", data: text(event.delta) }] : [];
    case "conversation.item.input_audio_transcription.completed":
      return text(event.transcript).trim() ? [{ kind: "heard", text: text(event.transcript), final: true }] : [];
    case "response.output_audio_transcript.delta":
      return text(event.delta) ? [{ kind: "said", text: text(event.delta) }] : [];
    case "response.output_audio_transcript.done":
      return [{ kind: "said-end" }];
    case "input_audio_buffer.speech_started":
      return [{ kind: "interrupt" }];
    case "response.function_call_arguments.done": {
      const id = text(event.call_id);
      if (!id) return [];
      if (event.name === STATUS_TOOL) return [{ kind: "status", id }];
      if (event.name === END_TOOL) return [{ kind: "hang-up", id }];
      if (event.name !== ASK_TOOL) return [];
      let request: string | null = null;
      try {
        const args = JSON.parse(text(event.arguments) || "{}") as { request?: unknown };
        request = text(args.request).trim() || null;
      } catch {
        /* the person's last words stand in */
      }
      return [{ kind: "delegate", id, request }];
    }
    case "error":
      return [{ kind: "error", message: errorOf(event) }];
    default:
      return [];
  }
}

function connect(url: URL, key: string, options: LinkOptions, read: (event: Event) => VoiceSignal[], opened: (send: (event: object) => void) => void, seen?: (event: Event) => void) {
  // Bun's WebSocket takes headers, so the key goes upstream from here and never to the page.
  const socket = new WebSocket(url.toString(), { headers: { authorization: `Bearer ${key}` } } as unknown as string[]);
  const send = (event: object) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };
  let closed = false;
  socket.addEventListener("open", () => opened(send));
  socket.addEventListener("message", (message) => {
    let event: Event;
    try {
      event = JSON.parse(typeof message.data === "string" ? message.data : new TextDecoder().decode(message.data as ArrayBuffer)) as Event;
    } catch {
      return;
    }
    seen?.(event);
    for (const signal of read(event)) options.on(signal);
  });
  socket.addEventListener("close", (event) => {
    if (closed) return;
    closed = true;
    options.on({ kind: "closed", reason: event.reason || null });
  });
  socket.addEventListener("error", () => options.on({ kind: "error", message: "The voice connection failed" }));
  return { socket, send };
}

function liveLink(options: LinkOptions): VoiceLink {
  const { model } = CALL_MODELS.openai;
  const voice = options.voice ?? CALL_MODELS.openai.voice;
  let started = false;
  const { socket, send } = connect(
    socketUrl(options.baseUrl, "live/sessions"),
    options.key,
    options,
    readLiveEvent,
    (send) =>
      send({
        type: "session.start",
        event_id: "start",
        session: {
          model,
          instructions: options.instructions,
          audio: { format: { type: "audio/pcm", rate: CALL_SAMPLE_RATE }, output: { voice } },
          delegation: { type: "client" },
          input: [
            ...(options.history ? [{ type: "message", role: "developer", content: [{ type: "input_text", text: clip(options.history, 6000) }] }] : []),
            { type: "message", role: "developer", content: [{ type: "input_text", text: options.greeting }] },
          ],
        },
      }),
    (event) => {
      if (event.type !== "session.started" || started) return;
      started = true;
      append("session.commentary.append", null, options.greeting);
    },
  );
  let n = 0;
  function append(type: string, delegation: string | null, content: string) {
    send({ type, event_id: `gond_${++n}`, delegation_id: delegation, content: clip(content) });
  }
  return {
    sendAudio: (audio) => started && send({ type: "session.input_audio.append", audio }),
    result: (id, content) => append("session.commentary.append", id, content),
    progress: (id, content) => append("session.thinking.append", id, content),
    tell: (content) => append("session.commentary.append", null, content),
    status: () => {},
    handed: () => {},
    mute: (muted) => send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: `gond_${++n}` }),
    close: () => {
      if (socket.readyState !== WebSocket.OPEN) return socket.close();
      send({ type: "session.close" });
      // Wait for session.closed so the minutes are settled, but not for ever.
      setTimeout(() => socket.close(), 5_000);
    },
  };
}

type Ask = { instructions?: string } | undefined;
const SPEAK_RETRY_MS = 1500;
const SPEAK_TRIES = 4;

/**
 * xAI speaks one response at a time and refuses a response.create while one runs, and a refused one is
 * simply gone. So asks wait their turn, and one that never starts (refused, or lost in a race with a
 * reply the person's own words set off) is asked again, a few times.
 */
export class SpeakQueue {
  private active = false;
  private waiting: { ask: Ask; tries: number } | null = null;
  private queue: { ask: Ask; tries: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly create: (ask: Ask) => void,
    private readonly retryMs = SPEAK_RETRY_MS,
  ) {}

  ask(ask: Ask) {
    this.queue.push({ ask, tries: 0 });
    this.pump();
  }

  started() {
    this.active = true;
    this.settle();
  }

  finished() {
    this.active = false;
    this.pump();
  }

  /** An error came back: if an ask was waiting to start, it was the one refused. */
  refused() {
    const refused = this.waiting;
    if (!refused) return;
    this.settle();
    if (refused.tries < SPEAK_TRIES) this.queue.unshift(refused);
    this.timer = setTimeout(() => this.pump(), this.retryMs);
  }

  stop() {
    this.settle();
    this.queue = [];
  }

  private settle() {
    this.waiting = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pump() {
    if (this.active || this.waiting || this.timer || !this.queue.length) return;
    const next = this.queue.shift()!;
    next.tries += 1;
    this.waiting = next;
    this.create(next.ask);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.waiting !== next) return;
      this.waiting = null;
      if (next.tries < SPEAK_TRIES) this.queue.unshift(next);
      this.pump();
    }, this.retryMs);
  }
}

function xaiLink(options: LinkOptions): VoiceLink {
  const { model } = CALL_MODELS.xai;
  const voice = options.voice ?? CALL_MODELS.xai.voice;
  const url = socketUrl(options.baseUrl, "realtime");
  url.searchParams.set("model", model);
  let ready = false;
  const speak = new SpeakQueue((ask) => send(ask ? { type: "response.create", response: ask } : { type: "response.create" }));
  // Said now, with what to say in this one response's own instructions, so the voice says it rather than filling.
  const sayNow = (what: string) => speak.ask({ instructions: `${options.instructions}\n\n${what}` });
  const system = (content: string) => send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: clip(content, 4000) }] } });
  const { socket, send } = connect(
    url,
    options.key,
    options,
    readXaiEvent,
    (send) =>
      send({
        type: "session.update",
        session: {
          voice,
          instructions: options.instructions,
          turn_detection: { type: "server_vad" },
          audio: { input: { format: { type: "audio/pcm", rate: CALL_SAMPLE_RATE } }, output: { format: { type: "audio/pcm", rate: CALL_SAMPLE_RATE } } },
          tools: [
            {
              type: "function",
              name: ASK_TOOL,
              description: `Hand what the person wants to ${options.botName}'s work: anything past small talk, any question that needs facts, memory or a look-up, and any task. Say in a few words that you're on it as you call this. The answer arrives on its own later, and you'll be asked to tell it then.`,
              parameters: { type: "object", properties: { request: { type: "string", description: "What the person wants, in full, with every detail they gave." } }, required: ["request"] },
            },
            { type: "function", name: STATUS_TOOL, description: `Where ${options.botName}'s work stands right now, for when the person asks how it's going.`, parameters: { type: "object", properties: {} } },
            { type: "function", name: END_TOOL, description: "Hang up, once the person is done and you've said a short goodbye.", parameters: { type: "object", properties: {} } },
          ],
        },
      }),
    (event) => {
      if (event.type === "response.created") speak.started();
      if (event.type === "response.done") speak.finished();
      if (event.type === "error") speak.refused();
      if (event.type !== "session.updated" || ready) return;
      ready = true;
      if (options.history) system(options.history);
      sayNow(options.greeting);
    },
  );
  return {
    sendAudio: (audio) => ready && send({ type: "input_audio_buffer.append", audio }),
    result: (_id, content) => {
      system(`${options.botName}'s answer to what the person asked: ${content}`);
      sayNow(`${options.botName}'s answer just came in: "${content}". Tell the person now, plainly and briefly, in your own words, keeping names, numbers and codes exact. Don't say you're still working on it.`);
    },
    progress: () => {},
    tell: (content) => {
      system(content);
      sayNow(content);
    },
    status: (id, content) => {
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: id, output: JSON.stringify({ status: content }) } });
      speak.ask(undefined);
    },
    handed: (id, content) => send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: id, output: JSON.stringify({ status: content }) } }),
    mute: () => {},
    close: () => {
      speak.stop();
      socket.close();
    },
  };
}

/** Called when the voice hands a request over: xAI's function call is answered at once, quietly, since the voice said it's on it as it called. */
export function acknowledge(link: VoiceLink, provider: VoiceProvider, id: string, botName: string) {
  if (provider === "xai") link.handed(id, `Handed to ${botName}. Its answer comes on its own when it's ready; don't say anything more about it until then.`);
}

export function openVoiceLink(provider: VoiceProvider, options: LinkOptions): VoiceLink {
  return provider === "openai" ? liveLink(options) : xaiLink(options);
}
