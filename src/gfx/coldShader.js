// Cold pipeline builds: say so while the view waits for one.
//
// The WebGL build's view program was built by ANGLE/Metal on its first draw,
// holding the page's main thread for seconds, so the app showed a message and
// held the first frame long enough for it to paint. Every pipeline of ours is
// now created asynchronously (docs/webgpu.md W18, B5): nothing stalls the page,
// and the hold is gone. What stays is the message, for a view whose pipeline
// is still building when it is wanted (the first view after a deploy, a view
// switched to for the first time): the view draws without the volume meanwhile
// and the toast says why. Dawn keeps built pipelines across sessions, so a
// warm browser rarely sees it.

// ms between showing a message and the work it announces, so the page paints
// it first
export const WARN_PAINT_MS = 100;
// a pipeline still building this long after the view wanted it gets the message
export const COLD_TOAST_MS = 250;

// warn(): show the message. watch(pipe) when the view starts waiting for a
// pipeline (gpu.renderPipeline or gpu.kernel: its state and ready promise).
// hold() and drew() stay for the app's calls: nothing is held back any more.
export function createColdShaderGuard(warn) {
  const watched = new WeakSet();
  return {
    watch(pipe) {
      if (!pipe || pipe.state === 'ready' || watched.has(pipe)) return;
      watched.add(pipe);
      const timer = setTimeout(() => { if (pipe.state === 'pending' || pipe.state === 'idle') warn(); }, COLD_TOAST_MS);
      pipe.ready?.then(() => clearTimeout(timer), () => clearTimeout(timer));
    },
    hold() { return false; },
    drew() {},
  };
}
