import { formatReport, errorCount } from '../constructions/lint.js';
import { extractCode } from './prompt.js';

// The prompt-to-construction agent loop, independent of any model provider
// (see providers.js for the plug-in interface).
//
// The model writes construction code and calls construct_exec; we run it in the
// sandbox, lint it and draw it, and send all of that back so it can fix leaks,
// loose powder or a wrong shape before the player ever sees the build. It ends
// with finish, or after MAX_STEPS turns with the best attempt so far.

export const MAX_STEPS = 6;
export const MAX_NAME_CHARS = 40;

export const TOOLS = [
  {
    name: 'construct_exec',
    description: 'Run construction code (the body of a function using the construction API) at the player\'s current size and a fixed seed. Returns cell counts, a physics lint report and preview pictures. Call it after every change.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The construction code: a JavaScript function body using put, box, ball, disc, rod and the rest of the API.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'Accept the latest construct_exec result as the final construction. Call it only when that result has no errors and looks right.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `A short name for the construction, at most ${MAX_NAME_CHARS} characters.` },
        description: { type: 'string', description: 'One sentence on what it is and how it behaves in the sim.' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
  },
];

const userText = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const ok = (text, images = []) => ({ text, images, isError: false });
const failed = (text) => ({ text, images: [], isError: true });

// One generation: the conversation, the best attempt so far, and how it ended.
class AgentRun {
  constructor({ provider, system, request, exec, preview, onEvent = () => {}, signal, maxSteps = MAX_STEPS }) {
    Object.assign(this, { provider, system, exec, preview, onEvent, signal, maxSteps });
    this.messages = [userText(request)];
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.best = null;          // { code, cells, report, attempt }
    this.attempts = 0;
    this.finished = null;      // { name, description }
    this.finishRefused = false;
  }

  // Run one piece of code; keep it if it has no more errors than the best so far.
  async attempt(code) {
    const n = ++this.attempts;
    this.onEvent({ type: 'exec', attempt: n });
    try {
      const { cells, report } = await this.exec(code);
      if (!this.best || errorCount(report) <= errorCount(this.best.report)) this.best = { code, cells, report, attempt: n };
      this.onEvent({ type: 'report', attempt: n, report });
      return ok(`Attempt ${n}.\n${formatReport(report)}`, this.preview ? await this.preview(cells) : []);
    } catch (err) {
      this.onEvent({ type: 'exec_error', attempt: n, message: err.message });
      return failed(`Attempt ${n} failed: ${err.message}`);
    }
  }

  // Accept the best attempt, but push back once if it still has errors.
  finish(input) {
    if (!this.best) return failed('Nothing to finish yet: call construct_exec first.');
    const errors = errorCount(this.best.report);
    if (errors && !this.finishRefused) {
      this.finishRefused = true;
      return failed(`The best attempt (${this.best.attempt}) still has ${errors} errors. Fix them, or call finish again to accept it as is.`);
    }
    this.finished = { name: String(input?.name ?? 'Untitled').slice(0, MAX_NAME_CHARS), description: String(input?.description ?? '') };
    return ok('Finished.');
  }

  async toolCall(call) {
    if (call.name === 'finish') return this.finish(call.input);
    if (call.name !== 'construct_exec') return failed(`Unknown tool ${call.name}. Use construct_exec or finish.`);
    return typeof call.input?.code === 'string' ? this.attempt(call.input.code) : failed('construct_exec needs { code: string }.');
  }

  // A model without tool support may answer with a code block: run it anyway.
  async textOnly(content) {
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const code = /```/.test(text) ? extractCode(text) : '';
    if (!code) { this.messages.push(userText('Call construct_exec with your construction code, then finish.')); return; }
    const r = await this.attempt(code);
    this.messages.push(userText(`${r.text}\n\nUse the construct_exec and finish tools from now on.`));
  }

  count(usage) {
    this.usage.inputTokens += usage?.inputTokens ?? 0;
    this.usage.outputTokens += usage?.outputTokens ?? 0;
  }

  async turn(step) {
    if (this.signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
    this.onEvent({ type: 'step', step });
    const res = await this.provider.generate({ system: this.system, messages: this.messages, tools: TOOLS, signal: this.signal });
    this.count(res.usage);
    const content = res.content ?? [];
    this.messages.push({ role: 'assistant', content });
    for (const b of content) if (b.type === 'text' && b.text.trim()) this.onEvent({ type: 'text', text: b.text });

    const calls = content.filter((b) => b.type === 'tool_call');
    if (!calls.length) { await this.textOnly(content); return; }
    const results = [];
    for (const call of calls) results.push({ type: 'tool_result', id: call.id, name: call.name, ...(await this.toolCall(call)) });
    this.messages.push({ role: 'tool', content: results });
  }
}

// provider: see providers.js. exec(code) → { cells, report } (throws on bad code).
// preview(cells) → [{ mediaType, data }] (optional). onEvent({ type, ... }) reports progress.
export async function runAgent(options) {
  const run = new AgentRun(options);
  for (let step = 1; step <= run.maxSteps && !run.finished; step++) await run.turn(step);
  if (!run.best) throw new Error('The model never produced code that ran.');
  const finished = !!run.finished;
  run.onEvent({ type: 'done', finished });
  return { ...run.best, name: run.finished?.name ?? 'Untitled', description: run.finished?.description ?? '', finished, usage: run.usage, messages: run.messages };
}
