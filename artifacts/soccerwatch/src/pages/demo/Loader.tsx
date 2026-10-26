import { ReplayMark } from "@/components/ReplayMark";

/** The Replay mark, breathing, over a clip or preview that is still on its way. */
export function DemoLoader({ label }: { label: string }) {
  return (
    <span className="dm-loader" role="status" aria-label={label}>
      <ReplayMark className="dm-loader-mark" />
    </span>
  );
}
