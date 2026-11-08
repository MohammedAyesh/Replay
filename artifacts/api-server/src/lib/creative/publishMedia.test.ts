import { expect, it } from "vitest";
import { renderIsDone } from "./publishMedia";
import { CREATIVE_RENDER_VERSION_PATH } from "./renderStore";

it("does not publish a completed render created before camera-original rendering", () => {
  expect(renderIsDone({
    renderStatus: "done",
    outputPath: "https://storage.example/creative/3/old-render.mp4",
  })).toBe(false);

  expect(renderIsDone({
    renderStatus: "done",
    outputPath: `https://storage.example/creative/3/${CREATIVE_RENDER_VERSION_PATH}/new-render.mp4`,
  })).toBe(true);
});
