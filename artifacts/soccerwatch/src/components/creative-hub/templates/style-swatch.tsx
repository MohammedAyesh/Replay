import type { CSSProperties } from "react";
import { CREATIVE_PACKS, isPackStyle, type CreativeBrand, type CreativeStyle } from "@workspace/api-zod";

/**
 * A thumbnail-sized sketch of each look in the academy's own colours, so the
 * style switcher shows what a style does rather than just naming it. A brand
 * pack shows the house style it is built on, marked with a star in the pack's
 * own accent (it is the academy's own look).
 */
export function StyleSwatch({ style, brand }: { style: CreativeStyle; brand: CreativeBrand }) {
  if (isPackStyle(style)) {
    const pack = CREATIVE_PACKS[style];
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }} aria-hidden>
        <StyleSwatch style={pack.base} brand={brand} />
        <span style={{
          position: "absolute", top: 4, insetInlineEnd: 4, width: 14, height: 14, borderRadius: "50%",
          background: pack.palette.ink, color: pack.palette.accent, fontSize: 10, lineHeight: "14px", textAlign: "center",
        }}>★</span>
      </div>
    );
  }
  const p = brand.primary;
  const a = brand.accent;
  const box: CSSProperties = { position: "relative", width: "100%", height: "100%", overflow: "hidden", borderRadius: 10 };
  const at = (s: CSSProperties): CSSProperties => ({ position: "absolute", ...s });
  switch (style) {
    case "broadcast":
      return (
        <div style={{ ...box, background: "#0B0F1A" }} aria-hidden>
          <div style={at({ left: "8%", right: "30%", bottom: "26%", height: "22%", background: p, transform: "skewX(-12deg)" })} />
          <div style={at({ left: "70%", width: "18%", bottom: "26%", height: "22%", background: "#FFFFFF" })} />
          <div style={at({ left: "8%", right: "12%", bottom: "20%", height: "5%", background: a })} />
        </div>
      );
    case "street":
      return (
        <div style={{ ...box, background: "#0A0A0A" }} aria-hidden>
          <div style={at({ left: "-6%", right: "-6%", top: "22%", height: "26%", background: "#FFFFFF", transform: "rotate(-6deg)" })} />
          <div style={at({ left: "10%", width: "56%", bottom: "16%", height: "20%", background: a, transform: "rotate(4deg)" })} />
          <div style={at({ right: "8%", top: "8%", width: "22%", height: "22%", borderRadius: "50%", background: p })} />
        </div>
      );
    case "editorial":
      return (
        <div style={{ ...box, background: "#F3EFE6" }} aria-hidden>
          <div style={at({ left: "10%", right: "10%", top: "14%", height: 1, background: "#16181D" })} />
          <div style={at({ left: "10%", right: "10%", top: "22%", height: "38%", background: "#C9C3B6" })} />
          <div style={at({ left: "10%", width: "50%", bottom: "20%", height: "8%", background: "#16181D" })} />
          <div style={at({ left: "10%", width: "16%", bottom: "12%", height: 2, background: p })} />
        </div>
      );
    case "luxury":
      return (
        <div style={{ ...box, background: "#060606" }} aria-hidden>
          <div style={at({ left: "12%", width: "40%", bottom: "34%", height: "6%", background: "#F1EDE4" })} />
          <div style={at({ left: "12%", width: "18%", bottom: "24%", height: 1, background: a })} />
          <div style={at({ left: "12%", width: "10%", top: "12%", height: "10%", borderRadius: "50%", border: "1px solid #F1EDE4" })} />
        </div>
      );
    case "playful":
      return (
        <div style={{ ...box, background: "#FFF6E5" }} aria-hidden>
          <div style={at({ right: "-18%", top: "-24%", width: "70%", height: "70%", borderRadius: "50%", background: p })} />
          <div style={at({ left: "-14%", bottom: "-20%", width: "46%", height: "46%", borderRadius: "50%", background: a })} />
          <div style={at({ left: "16%", top: "30%", width: "52%", height: "18%", borderRadius: 999, background: "#FFFFFF", border: "2px solid #1B1A2E", transform: "rotate(-6deg)" })} />
        </div>
      );
    case "cinematic":
      return (
        <div style={{ ...box, background: `linear-gradient(0deg, ${p} 0%, #000000 70%)` }} aria-hidden>
          <div style={at({ left: "10%", width: "62%", bottom: "22%", height: "16%", background: "#FFFFFF", transform: "skewX(-10deg)", boxShadow: `0 0 10px ${p}` })} />
          <div style={at({ left: "30%", top: "24%", width: 3, height: 3, borderRadius: "50%", background: a })} />
          <div style={at({ left: "70%", top: "36%", width: 2, height: 2, borderRadius: "50%", background: a })} />
        </div>
      );
    case "stadium":
      return (
        <div style={{ ...box, background: `linear-gradient(180deg, ${p} 0%, #040A1C 85%)` }} aria-hidden>
          <div style={at({ left: "-10%", top: "-10%", width: "26%", height: "130%", background: "linear-gradient(#FFFFFF55, #FFFFFF00)", transform: "rotate(-24deg)" })} />
          <div style={at({ right: "-10%", top: "-10%", width: "26%", height: "130%", background: "linear-gradient(#FFFFFF55, #FFFFFF00)", transform: "rotate(24deg)" })} />
          <div style={at({ left: "18%", right: "18%", bottom: "14%", height: "14%", borderRadius: 999, background: a })} />
        </div>
      );
  }
  return null;
}
