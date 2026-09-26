/**
 * A tiny task-based progress tracker.
 *
 * This game generates its world procedurally rather than downloading a bundle
 * of GLB files, so "loading" is really "building meshes". The loader yields to
 * the browser between steps, which keeps the progress bar honest and moving
 * instead of freezing on a white screen -- the thing that kills a browser toy.
 */
export interface LoadStep {
  label: string;
  run: () => void | Promise<void>;
  /** Relative cost, used to weight the progress bar. Defaults to 1. */
  weight?: number;
}

export async function runSteps(
  steps: LoadStep[],
  onProgress: (fraction: number, label: string) => void,
): Promise<void> {
  const total = steps.reduce((sum, s) => sum + (s.weight ?? 1), 0);
  let done = 0;

  for (const step of steps) {
    onProgress(done / total, step.label);
    // Yield twice: once to paint the new label, once to let the browser settle.
    await nextFrame();
    await step.run();
    done += step.weight ?? 1;
    onProgress(done / total, step.label);
    await nextFrame();
  }
}

/**
 * Yield to the browser for one frame.
 *
 * Races requestAnimationFrame against a timer on purpose: rAF is throttled to
 * zero in a background tab, so a loader that awaited it alone would simply stop
 * generating the world if the player switched tabs while it built -- and then sit
 * frozen at whatever percentage it had reached when they came back.
 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 32);
  });
}
