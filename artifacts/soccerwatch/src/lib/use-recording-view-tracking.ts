import { useMemo } from "react";
import {
  useRecordRecordingView,
  useRecordRecordingWatchTime,
  type RecordingViewInput,
} from "@workspace/api-client-react";
import { createRecordingViewCallbacks } from "./recording-view-tracking";

export function useRecordingViewTracking(input: RecordingViewInput | null) {
  const recordView = useRecordRecordingView();
  const recordWatchTime = useRecordRecordingWatchTime();

  return useMemo(() => createRecordingViewCallbacks(
    input,
    (data) => { recordView.mutate({ data }); },
    (data) => { recordWatchTime.mutate({ data }); },
  ), [
    input?.fieldId,
    input?.videoId,
    recordView.mutate,
    recordWatchTime.mutate,
  ]);
}
