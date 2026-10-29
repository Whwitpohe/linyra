// Server-sent events as the WHATWG spec reads them: lines end in CRLF, LF or CR (a CR at the end of
// one chunk may pair with an LF at the start of the next), `data:` lines join with "\n", a blank
// line dispatches, comments (":") are skipped, and UTF-8 split across chunks decodes whole.
// Pure: no vscode import.

export interface SseEvent {
  /** The `event:` field; "message" when there was none. */
  event: string;
  data: string;
}

type Chunks = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

async function* chunksOf(body: Chunks): AsyncGenerator<Uint8Array | string> {
  if (typeof (body as ReadableStream<Uint8Array>).getReader !== "function") {
    yield* body as AsyncIterable<Uint8Array | string>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // Stopped early (an error, a cancel, the consumer returned): close the connection.
    reader.cancel().catch(() => undefined);
  }
}

/** The events of an SSE body, in order. Throws `signal.reason` once the signal aborts. */
export async function* readSse(body: Chunks, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let hasData = false;
  const line = (text: string): SseEvent | undefined => {
    if (text === "") {
      const out = hasData ? { event: event || "message", data: data.join("\n") } : undefined;
      event = "";
      data = [];
      hasData = false;
      return out;
    }
    if (text.startsWith(":")) return undefined;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      hasData = true;
    } else if (field === "event") event = value;
    return undefined;
  };
  for await (const chunk of chunksOf(body)) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      // A CR as the last character may be the first half of a CRLF still on its way.
      if (c === "\r" && i === buffer.length - 1) break;
      const out = line(buffer.slice(start, i));
      if (c === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
      if (out) yield out;
    }
    buffer = buffer.slice(start);
  }
  buffer += decoder.decode();
  // The stream ended: a trailing CR ends its line, and an event without its blank line still counts.
  for (const rest of buffer.split(/\r\n|\r|\n/)) {
    const out = line(rest);
    if (out) yield out;
  }
  const last = line("");
  if (last) yield last;
}
