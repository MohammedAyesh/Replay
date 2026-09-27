import { useId } from "react";

export function ReplayMark({ className = "" }: { className?: string }) {
  const clipPathId = `replay-mark-clip-${useId().replace(/:/g, "")}`;

  return (
    <svg
      className={`replay-mark ${className}`.trim()}
      viewBox="-5 0 225 200"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipPathId}>
          <circle cx="95" cy="96" r="88" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipPathId})`}>
        <polygon className="replay-mark-facet" points="95,60 126.2,78 126.2,114 95,132 63.8,114 63.8,78" fill="var(--replay-turf)" />
        <polygon className="replay-mark-facet" points="126.2,6 157.4,24 157.4,60 126.2,78 95,60 95,24" fill="var(--replay-floodlight)" />
        <polygon className="replay-mark-facet" points="63.8,6 95,24 95,60 63.8,78 32.6,60 32.6,24" fill="var(--replay-turf)" />
        <polygon className="replay-mark-facet" points="157.4,60 188.6,78 188.6,114 157.4,132 126.2,114 126.2,78" fill="color-mix(in srgb, var(--replay-turf) 72%, var(--replay-void))" />
        <polygon className="replay-mark-facet" points="32.6,60 63.8,78 63.8,114 32.6,132 1.4,114 1.4,78" fill="color-mix(in srgb, var(--replay-turf) 42%, var(--replay-void))" />
        <polygon className="replay-mark-facet" points="126.2,114 157.4,132 157.4,168 126.2,186 95,168 95,132" fill="color-mix(in srgb, var(--replay-turf) 62%, var(--replay-violet))" />
        <polygon className="replay-mark-facet" points="63.8,114 95,132 95,168 63.8,186 32.6,168 32.6,132" fill="var(--replay-violet)" />
      </g>
      <polygon points="170,62 170,134 210,98" fill="var(--replay-void)" />
      <polygon points="172,68 172,128 206,98" fill="var(--replay-floodlight)" />
      <circle cx="178" cy="46" r="7.5" fill="var(--replay-void)" />
      <circle cx="178" cy="46" r="5.5" fill="var(--replay-violet)" />
    </svg>
  );
}