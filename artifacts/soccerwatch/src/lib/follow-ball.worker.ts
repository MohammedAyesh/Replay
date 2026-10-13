import { smoothPath, targetSeries, type BallSample, type CameraPoint, type GameSpan } from "./follow-ball";

type Request = {
  id: number;
  samples: BallSample[];
  spans: GameSpan[];
  duration: number;
};

type Reply = { id: number; path?: CameraPoint[]; error?: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Reply) => void;
};

workerScope.onmessage = (event) => {
  const { id, samples, spans, duration } = event.data;
  try {
    const targets = targetSeries(samples, spans, duration);
    workerScope.postMessage({ id, path: smoothPath(targets) });
  } catch (error) {
    workerScope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
