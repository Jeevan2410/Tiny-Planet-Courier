/**
 * World generation worker.
 *
 * Rebuilds the terrain field from a tiny config (a seed plus the registered
 * building sites and roads) and returns the finished mesh arrays by transfer.
 * The main thread stays responsive throughout, which matters most on phones --
 * a second of blocked main thread during load is what makes a browser offer to
 * kill the page.
 *
 * This module must never import three. See the note in `field.ts`.
 */
import { TerrainField, type FieldConfig } from './field';
import { buildTerrain } from './terrainMesh';

export interface BuildTerrainRequest {
  type: 'terrain';
  config: FieldConfig;
  subdivisions: number;
}

export interface TerrainProgress {
  type: 'progress';
  fraction: number;
}

export interface TerrainResult {
  type: 'terrain';
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  elapsedMs: number;
}

export interface TerrainError {
  type: 'error';
  message: string;
}

/**
 * Minimal worker-scope shape. Declared locally rather than by adding the
 * "WebWorker" lib to tsconfig, which collides with the DOM lib the rest of the
 * project needs.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<BuildTerrainRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event: MessageEvent<BuildTerrainRequest>) => {
  const request = event.data;
  if (request?.type !== 'terrain') return;

  try {
    const started = performance.now();
    const field = TerrainField.fromConfig(request.config);

    let lastReport = 0;
    const arrays = buildTerrain(field, request.subdivisions, (fraction) => {
      // Throttle: posting on every sample would cost more than it reports.
      const now = performance.now();
      if (fraction < 1 && now - lastReport < 80) return;
      lastReport = now;
      ctx.postMessage({ type: 'progress', fraction } satisfies TerrainProgress);
    });

    const result: TerrainResult = {
      type: 'terrain',
      position: arrays.position,
      normal: arrays.normal,
      color: arrays.color,
      index: arrays.index,
      vertexCount: arrays.vertexCount,
      elapsedMs: performance.now() - started,
    };

    ctx.postMessage(result, [
      result.position.buffer,
      result.normal.buffer,
      result.color.buffer,
      result.index.buffer,
    ]);
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies TerrainError);
  }
};
