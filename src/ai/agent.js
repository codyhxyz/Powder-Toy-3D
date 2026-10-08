import { generateText, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { formatReport, errorCount } from '../constructions/lint.js';
import { extractCode, MAX_NAME_CHARS } from './prompt.js';

// The prompt-to-construction agent, on the Vercel AI SDK's tool loop. It works
// with any AI SDK language model (see providers.js for the BYOK catalog).
//
// The model writes construction code and calls construct_exec; we run it in the
// sandbox, lint it and draw it, and send all of that back so it can fix leaks,
// loose powder or a wrong shape before the player ever sees the build. It ends
// when the model calls finish, or after MAX_STEPS steps with the best attempt.

export const MAX_STEPS = 6;

const ok = (text, images = []) => ({ text, images, isError: false });
const failed = (text) => ({ text, images: [], isError: true });

// A tool result as the model sees it: the report text plus the preview pictures.
const toModelOutput = ({ output }) => (output.isError
  ? { type: 'error-text', value: output.text }
  : {
    type: 'content',
    value: [
      { type: 'text', text: output.text },
      ...output.images.map((img) => ({ type: 'file', mediaType: img.mediaType, data: { type: 'data', data: img.data } })),
    ],
  });

// One generation: the best attempt so far and how it ended.
class AgentRun {
  constructor({ exec, preview, onEvent = () => {} }) {
    Object.assign(this, { exec, preview, onEvent });
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
  finish({ name, description }) {
    if (!this.best) return failed('Nothing to finish yet: call construct_exec first.');
    const errors = errorCount(this.best.report);
    if (errors && !this.finishRefused) {
      this.finishRefused = true;
      return failed(`The best attempt (${this.best.attempt}) still has ${errors} errors. Fix them, or call finish again to accept it as is.`);
    }
    this.finished = { name: String(name ?? 'Untitled').slice(0, MAX_NAME_CHARS), description: String(description ?? '') };
    return ok('Finished.');
  }

  tools() {
    return {
      construct_exec: tool({
        description: 'Run construction code (the body of a function using the construction API) at the player\'s current size and a fixed seed. Returns cell counts, a physics lint report and preview pictures. Call it after every change.',
        inputSchema: z.object({
          code: z.string().describe('The construction code: a JavaScript function body using put, box, ball, disc, rod and the rest of the API.'),
        }),
        execute: ({ code }) => this.attempt(code),
        toModelOutput,
      }),
      finish: tool({
        description: 'Accept the latest construct_exec result as the final construction. Call it only when that result has no errors and looks right.',
        inputSchema: z.object({
          name: z.string().describe(`A short name for the construction, at most ${MAX_NAME_CHARS} characters.`),
          description: z.string().describe('One sentence on what it is and how it behaves in the sim.'),
        }),
        execute: async (input) => this.finish(input),
        toModelOutput,
      }),
    };
  }
}

// model: any AI SDK language model. exec(code) → { cells, report } (throws on bad
// code). preview(cells) → [{ mediaType, data: base64 }] (optional).
// onEvent({ type, ... }) reports progress: step, text, exec, report, exec_error, done.
export async function runAgent({ model, system, request, exec, preview, onEvent = () => {}, signal, maxSteps = MAX_STEPS }) {
  const run = new AgentRun({ exec, preview, onEvent });
  const result = await generateText({
    model,
    system,
    prompt: request,
    tools: run.tools(),
    abortSignal: signal,
    stopWhen: [isStepCount(maxSteps), () => !!run.finished],
    onStepStart: ({ stepNumber }) => onEvent({ type: 'step', step: stepNumber + 1 }),
    onStepEnd: ({ text }) => { if (text?.trim()) onEvent({ type: 'text', text }); },
  });

  // A model without tool support may answer with a code block: run it anyway.
  if (!run.best && /```/.test(result.text ?? '')) await run.attempt(extractCode(result.text));
  if (!run.best) throw new Error('The model never produced code that ran.');

  const finished = !!run.finished;
  onEvent({ type: 'done', finished });
  const usage = { inputTokens: result.totalUsage?.inputTokens ?? 0, outputTokens: result.totalUsage?.outputTokens ?? 0 };
  return { ...run.best, name: run.finished?.name ?? 'Untitled', description: run.finished?.description ?? '', finished, usage, messages: result.response?.messages ?? [] };
}
