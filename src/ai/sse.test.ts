import * as assert from "assert";
import { readSse, type SseEvent } from "./sse";

const bytes = (text: string) => new TextEncoder().encode(text);

async function events(chunks: (string | Uint8Array)[]): Promise<SseEvent[]> {
  async function* source() {
    for (const c of chunks) yield c;
  }
  const out: SseEvent[] = [];
  for await (const e of readSse(source())) out.push(e);
  return out;
}

/** The same text cut at every byte: the parser must not care where the network splits it. */
async function everySplit(text: string): Promise<void> {
  const whole = await events([bytes(text)]);
  const b = bytes(text);
  for (let i = 1; i < b.length; i++) {
    assert.deepStrictEqual(await events([b.slice(0, i), b.slice(i)]), whole, `split at byte ${i}`);
  }
}

(async () => {
  {
    const text = 'event: message_start\ndata: {"a":1}\n\n: keep-alive comment\n\ndata: first\ndata: second\n\nevent: ping\ndata:\n\n';
    assert.deepStrictEqual(await events([text]), [
      { event: "message_start", data: '{"a":1}' },
      { event: "message", data: "first\nsecond" },
      { event: "ping", data: "" },
    ]);
    console.log("ok - SSE: event names, multi-line data joined with newlines, comments skipped, empty data dispatched");
  }

  {
    await everySplit('data: {"text":"héllo ✓ 漢字"}\r\n\r\ndata: [DONE]\r\n\r\n');
    await everySplit("data: a\r\rdata: b\n\n");
    const crlf = await events([bytes("data: x\r"), bytes("\n\r\ndata: y\r\n\r\n")]);
    assert.deepStrictEqual(crlf.map((e) => e.data), ["x", "y"], "a CRLF split across chunks is one line end");
    assert.deepStrictEqual((await events([bytes('data: {"text":"漢字"}\n\ndata: [DONE]\n\n')])).map((e) => e.data), ['{"text":"漢字"}', "[DONE]"]);
    console.log("ok - SSE: every split point gives the same events, CRLF/CR/LF line ends, UTF-8 split mid-character");
  }

  {
    assert.deepStrictEqual(await events(["data: tail without blank line"]), [{ event: "message", data: "tail without blank line" }]);
    assert.deepStrictEqual(await events(["data:no-space\n\n", "data:  two spaces\n\n"]), [{ event: "message", data: "no-space" }, { event: "message", data: " two spaces" }]);
    assert.deepStrictEqual(await events(["event: only-name\n\n", "id: 7\nretry: 10\n\n"]), [], "an event without data is not dispatched");
    console.log("ok - SSE: a last event without its blank line still counts; field values lose one leading space");
  }

  {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes("data: 1\n\n"));
        c.enqueue(bytes("data: 2\n\n"));
        c.close();
      },
    });
    const seen: string[] = [];
    for await (const e of readSse(stream)) seen.push(e.data);
    assert.deepStrictEqual(seen, ["1", "2"]);
    const controller = new AbortController();
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(bytes("data: tick\n\n")); },
      cancel() { cancelled = true; },
    });
    let count = 0;
    await assert.rejects(async () => {
      for await (const e of readSse(endless, controller.signal)) if (e.data === "tick" && ++count === 3) controller.abort(new Error("stop"));
    }, /stop/);
    assert.ok(cancelled, "the body is cancelled when reading stops");
    console.log("ok - SSE: reads web streams, stops on abort and cancels the body");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
