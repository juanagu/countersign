export interface AguiEvent {
  type: string;
  [key: string]: unknown;
}

export function parseSse(body: string): AguiEvent[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as AguiEvent);
}

/** The assistant text a client would show for each message id, folded from the events in order. */
export function foldText(events: readonly AguiEvent[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const event of events) {
    const id = event.messageId as string;
    if (event.type === 'TEXT_MESSAGE_START') texts.set(id, texts.get(id) ?? '');
    if (event.type === 'TEXT_MESSAGE_CONTENT') texts.set(id, (texts.get(id) ?? '') + (event.delta as string));
  }
  return texts;
}

/** Reads an SSE response until `stop` says so, then drops the connection. Returns what arrived. */
export async function readUntil(res: Response, abort: AbortController, stop: (events: AguiEvent[]) => boolean) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    const complete = raw.slice(0, raw.lastIndexOf('\n\n') + 2);
    if (stop(parseSse(complete))) {
      abort.abort();
      return parseSse(complete);
    }
  }
  return parseSse(raw);
}
